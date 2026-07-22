import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCHEMA_VERSION, EXTRACTOR_VERSION, type FileRecord } from "./types.js";
import { ENGINE_VERSION } from "./types.js";
import { ensureGrammars, allGrammarKeys } from "./ast/loader.js";
import { buildIndexArtifacts, type BuildIndexOptions } from "./pipeline.js";
import { renderGraphJson } from "./render/graph-json.js";
import { renderSymbolsJson } from "./render/symbols-json.js";
import { scanRepo } from "./scan.js";
import { buildCallerIndex } from "./callers.js";
import { detectWorkspaces } from "./workspaces.js";
import { gitChurn } from "./git.js";
import { grepRepo } from "./grep.js";
import { changeCoupling, rankHotspots } from "./coupling.js";
import { renderRepoMap } from "./repomap.js";
import { searchIndex } from "./bm25.js";
import { checkRules, parseRules } from "./rules.js";

const HELP = `codeindex engine v${ENGINE_VERSION} — deterministic repo indexing

Usage: engine.mjs <command> [flags]

Commands:
  index       Build graph.json + symbols.json (+ incremental cache.json) into
              --out <dir> in ONE pass — the fast path for repeated runs
  scan        Scan summary: file count, language histogram, capped flag
  graph       Full link-graph (graph.json bytes) to stdout or --out
  symbols     Symbol index (symbols.json bytes) to stdout or --out
  callers     Per-symbol caller index (JSON)
  workspaces  Monorepo packages + dependency graph (JSON)
  churn       Per-file git commit counts (JSON; --since <ref> to bound)
  grep        Search: cli.mjs grep <pattern> --repo <dir> (JSON hits)
  search      Keyless BM25 lexical search over symbol names, path segments,
              markdown headings and summaries: cli.mjs search "<query>" --repo <dir>
  rules       Architecture rules (forbidden edges, cycles, orphans) validated
              against the link-graph: --config <codeindex.rules.json>; exits 1
              on any error-severity violation (a CI gate)
  repomap     Token-budgeted map of the highest-PageRank files (--budget-tokens)
  hotspots    Churn × size ranking of the files where work concentrates (JSON)
  coupling    Change coupling: files that change together (JSON; --since <ref>)
  mcp         Run as an MCP server over stdio (tools: scan_summary, graph,
              symbols, callers, workspaces, churn, grep)
  version     Print the engine version

Flags:
  --repo <dir>        Repo root (default: cwd)
  --out <file>        Write output to a file instead of stdout
  --include <glob>    Only include matching paths (repeatable)
  --exclude <glob>    Exclude matching paths (repeatable)
  --scope <dir>       Restrict to one directory (sugar for --include '<dir>/**')
  --no-gitignore      Do not honor .gitignore files (default: honored)
  --max-files <n>     Cap walked files (default 20000)
  --max-bytes <n>     Skip files above this size (default 1 MiB)
  --no-ast            Skip tree-sitter grammars even when present (regex tier)
  --config <file>     Rules config for \`rules\` (JSON: [{name, from, to, …}])
  --limit <n>         Max results for \`search\` (default 20)
  --recall            \`callers\`: recall-oriented binding (issue #7) — relaxes
                      the JS/TS import gate to unique repo-wide names and labels
                      each site corroborated|unique-name
`;

interface CliFlags {
  repo: string;
  out?: string;
  include: string[];
  exclude: string[];
  scope?: string;
  gitignore: boolean;
  maxFiles?: number;
  maxBytes?: number;
  noAst: boolean;
  since?: string;
  ignoreCase?: boolean;
  maxHits?: number;
  budgetTokens?: number;
  config?: string; // rules config path
  limit?: number; // search result cap
  recall?: boolean; // callers: recall-oriented binding
  positional?: string; // e.g. the grep pattern or search query
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { repo: process.cwd(), include: [], exclude: [], gitignore: true, noAst: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    const num = (): number => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} expects a positive number, got "${raw}"`);
      return n;
    };
    if (a === "--repo") flags.repo = resolve(next());
    else if (a === "--out") flags.out = resolve(next());
    else if (a === "--include") flags.include.push(next());
    else if (a === "--exclude") flags.exclude.push(next());
    else if (a === "--scope") flags.scope = next();
    else if (a === "--no-gitignore") flags.gitignore = false;
    else if (a === "--max-files") flags.maxFiles = num();
    else if (a === "--max-bytes") flags.maxBytes = num();
    else if (a === "--ignore-case") flags.ignoreCase = true;
    else if (a === "--max-hits") flags.maxHits = num();
    else if (a === "--budget-tokens") flags.budgetTokens = num();
    else if (a === "--no-ast") flags.noAst = true;
    else if (a === "--since") flags.since = next();
    else if (a === "--config") flags.config = resolve(next());
    else if (a === "--limit") flags.limit = num();
    else if (a === "--recall") flags.recall = true;
    else if (!a.startsWith("--") && flags.positional === undefined) flags.positional = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function emit(content: string, out?: string): void {
  if (out) writeFileSync(out, content);
  else process.stdout.write(content);
}

function scanOptions(flags: CliFlags): BuildIndexOptions {
  return {
    include: flags.include.length ? flags.include : undefined,
    exclude: flags.exclude.length ? flags.exclude : undefined,
    scope: flags.scope,
    gitignore: flags.gitignore,
    maxFiles: flags.maxFiles,
    maxBytes: flags.maxBytes,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "version" || cmd === "--version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  if (cmd === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return;
  }

  const flags = parseFlags(rest);
  if (!existsSync(flags.repo)) throw new Error(`--repo path does not exist: ${flags.repo}`);
  if (!flags.noAst) await ensureGrammars(allGrammarKeys());

  if (cmd === "index") {
    if (!flags.out) throw new Error("index needs --out <dir>");
    const outDir = flags.out;
    mkdirSync(outDir, { recursive: true });
    // Incremental cache: reuse per-file records when (schema, extractor) match —
    // same invalidation discipline as ultraindex's cache.json.
    const cachePath = join(outDir, "cache.json");
    let cache: Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }> | undefined;
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
        schemaVersion: number;
        extractorVersion: number;
        files: Record<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }>;
      };
      if (parsed.schemaVersion === SCHEMA_VERSION && parsed.extractorVersion === EXTRACTOR_VERSION) {
        cache = new Map(Object.entries(parsed.files));
      }
    } catch {
      // no cache yet (or unreadable) — cold build
    }
    const { scan, graph, symbols } = buildIndexArtifacts(flags.repo, { ...scanOptions(flags), cache, out: outDir });
    writeFileSync(join(outDir, "graph.json"), renderGraphJson(graph));
    writeFileSync(join(outDir, "symbols.json"), renderSymbolsJson(symbols));
    const files: Record<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }> = {};
    for (const f of scan.files) {
      const entry: { hash: string; record: FileRecord; size?: number; mtimeMs?: number } = { hash: f.hash, record: f, size: f.size };
      const mtime = scan.mtimes.get(f.rel);
      if (mtime !== undefined) entry.mtimeMs = mtime;
      files[f.rel] = entry;
    }
    writeFileSync(
      cachePath,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, extractorVersion: EXTRACTOR_VERSION, files }) + "\n",
    );
    process.stderr.write(`codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${scan.capped ? " (capped)" : ""}\n`);
  } else if (cmd === "scan") {
    const { scan } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    const summary = {
      engineVersion: ENGINE_VERSION,
      commit: scan.commit,
      fileCount: scan.files.length,
      languages: scan.languages,
      capped: scan.capped,
    };
    emit(JSON.stringify(summary, null, 2) + "\n", flags.out);
  } else if (cmd === "graph") {
    const { graph } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    emit(renderGraphJson(graph), flags.out);
  } else if (cmd === "symbols") {
    const { symbols } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    emit(renderSymbolsJson(symbols), flags.out);
  } else if (cmd === "callers") {
    const scan = scanRepo(flags.repo, scanOptions(flags));
    const index = buildCallerIndex(scan, undefined, { recall: flags.recall });
    const obj: Record<string, unknown> = {};
    for (const [name, entry] of index) obj[name] = entry;
    emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
  } else if (cmd === "search") {
    if (!flags.positional) throw new Error('search needs a query: cli.mjs search "<query>" --repo <dir>');
    const scan = scanRepo(flags.repo, scanOptions(flags));
    const results = searchIndex(scan, flags.positional, { limit: flags.limit });
    emit(JSON.stringify(results, null, 2) + "\n", flags.out);
  } else if (cmd === "rules") {
    if (!flags.config) throw new Error("rules needs --config <codeindex.rules.json>");
    const rules = parseRules(JSON.parse(readFileSync(flags.config, "utf8")));
    const { graph } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    const violations = checkRules(graph, rules);
    const errors = violations.filter((v) => v.severity === "error").length;
    emit(JSON.stringify({ errors, warnings: violations.length - errors, violations }, null, 2) + "\n", flags.out);
    if (errors > 0) process.exitCode = 1; // the CI gate
  } else if (cmd === "workspaces") {
    const info = detectWorkspaces(flags.repo);
    emit(
      JSON.stringify(
        { packages: info.packages, cycle: info.cycle ?? null, topoOrder: info.topoOrder },
        null,
        2,
      ) + "\n",
      flags.out,
    );
  } else if (cmd === "churn") {
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    const sorted: Record<string, number> = {};
    for (const k of [...churn.keys()].sort()) sorted[k] = churn.get(k)!;
    emit(JSON.stringify({ ok, churn: sorted }, null, 2) + "\n", flags.out);
  } else if (cmd === "repomap") {
    const { scan, graph } = buildIndexArtifacts(flags.repo, scanOptions(flags));
    emit(renderRepoMap(scan, graph, { budgetTokens: flags.budgetTokens }), flags.out);
  } else if (cmd === "hotspots") {
    const scan = scanRepo(flags.repo, scanOptions(flags));
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, hotspots: rankHotspots(scan, churn) }, null, 2) + "\n", flags.out);
  } else if (cmd === "coupling") {
    const { ok, couplings } = changeCoupling(flags.repo, { since: flags.since });
    emit(JSON.stringify({ ok, couplings }, null, 2) + "\n", flags.out);
  } else if (cmd === "grep") {
    if (!flags.positional) throw new Error("grep needs a pattern: cli.mjs grep <pattern> --repo <dir>");
    const globs = [...flags.include, ...flags.exclude.map((g) => `!${g}`)];
    const hits = grepRepo(flags.repo, flags.positional, {
      globs: globs.length ? globs : undefined,
      ignoreCase: flags.ignoreCase,
      maxHits: flags.maxHits,
    });
    emit(JSON.stringify(hits, null, 2) + "\n", flags.out);
  } else {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
  }
}
