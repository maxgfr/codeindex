import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, EXTRACTOR_VERSION, type FileRecord } from "./types.js";
import { ENGINE_VERSION } from "./types.js";
import { ensureGrammars, grammarKeysForExts, resolveGrammarsTier, sharedGrammarsCacheDir } from "./ast/loader.js";
import {
  resolveGrammarsPullTarget,
  fetchGrammarsTarball,
  fetchExpectedSha256,
  extractGrammarsTarball,
} from "./ast/grammars-pull.js";
import { buildIndexArtifacts, buildArtifactsFromScan, type BuildIndexOptions } from "./pipeline.js";
import { sha1 } from "./hash.js";
import { renderGraphJson } from "./render/graph-json.js";
import { renderSymbolsJson } from "./render/symbols-json.js";
import { renderScip } from "./render/scip.js";
import { scanRepo } from "./scan.js";
import { walk, type WalkResult } from "./walk.js";
import { buildCallerIndex } from "./callers.js";
import { detectWorkspaces } from "./workspaces.js";
import { gitChurn } from "./git.js";
import { grepRepo } from "./grep.js";
import { changeCoupling, rankHotspots } from "./coupling.js";
import { renderRepoMap } from "./repomap.js";
import { findDeadCode } from "./deadcode.js";
import { symbolComplexity, riskHotspots } from "./complexity.js";
import { renderMermaid } from "./viz.js";
import { searchIndex } from "./bm25.js";
import { checkRules, parseRules } from "./rules.js";
import { EMBED_VERSION, resolveEmbedModelDir, loadEmbedModel, parseEmbedModel, resolveEmbedPullUrl, fetchEmbedModel } from "./embed/model.js";
import { buildEmbeddingIndex, serializeEmbeddings } from "./embed/index.js";
import { searchSemantic } from "./embed/search.js";
import {
  resolveEmbedEndpoint,
  buildEndpointIndex,
  encodeQueryViaEndpoint,
  probeEndpoint,
} from "./embed/endpoint.js";
import { have, sh } from "./util.js";

const HELP = `codeindex engine v${ENGINE_VERSION} — deterministic repo indexing

Usage: engine.mjs <command> [flags]

Commands:
  index       Build graph.json + symbols.json (+ incremental cache.json) into
              --out <dir> in ONE pass — the fast path for repeated runs
  scan        Scan summary: file count, language histogram, capped flag
  graph       Full link-graph (graph.json bytes) to stdout or --out
  symbols     Symbol index (symbols.json bytes) to stdout or --out
  scip        SCIP code-intelligence index (protobuf bytes) into --out
              (default index.scip; --out - writes to stdout)
  callers     Per-symbol caller index (JSON)
  workspaces  Monorepo packages + dependency graph (JSON)
  churn       Per-file git commit counts (JSON; --since <ref> to bound)
  grep        Search: cli.mjs grep <pattern> --repo <dir> (JSON hits)
  search      Keyless BM25 lexical search over symbol names, path segments,
              markdown headings and summaries: cli.mjs search "<query>" --repo <dir>.
              --semantic fuses in an embedding tier (RRF) — the HTTP endpoint
              (CODEINDEX_EMBED_ENDPOINT) if set, else a local static model;
              degrades to lexical (exit 0) when neither is available/reachable
  embed       Embedding tiers (opt-in). Precedence: endpoint > static model:
                embed status   Effective mode (none/static/endpoint), model +
                               EMBED_VERSION, and endpoint reachability (JSON)
                embed build    Write embeddings.bin into --out <dir> (static tier)
                embed pull     Fetch the official model asset into CODEINDEX_EMBED_DIR
                               (or <repo>/.codeindex/models/); sha256-verified. Override
                               the source with CODEINDEX_EMBED_URL
                embed serve    Print (or --run) the docker command that starts the
                               containerized embedding server (rich tier)
  grammars    Tree-sitter wasm grammars (optional AST tier; regex without them).
              Precedence: bundle-adjacent > CODEINDEX_GRAMMARS_DIR > shared cache:
                grammars status  Active tier (adjacent/env/cache/none), resolved
                                 dir, pinned ENGINE_VERSION, pull-needed (JSON)
                grammars pull    Fetch the per-release grammars-<version>.tar.gz
                                 asset into the shared cache (sha256-verified,
                                 atomic). Override the source with
                                 CODEINDEX_GRAMMARS_URL
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
  --out <file>        Write output to a file instead of stdout (\`scip\`: --out -
                      writes the binary index to stdout)
  --project-root <uri> \`scip\`: override Metadata.project_root (default
                      file://<repo>); pin it for a byte-reproducible index
  --include <glob>    Only include matching paths (repeatable)
  --exclude <glob>    Exclude matching paths (repeatable)
  --scope <dir>       Restrict to one directory (sugar for --include '<dir>/**')
  --no-gitignore      Do not honor .gitignore files (default: honored)
  --ignore-dir <name> Directory names to skip (repeatable) — REPLACES the
                      default ignored-directory set, never merges with it
  --max-files <n>     Cap walked files (default 20000)
  --max-bytes <n>     Skip files above this size (default 1 MiB)
  --max-calls <n>     Per-file call-site cap for extraction (default 512)
  --no-ast            Skip tree-sitter grammars even when present (regex tier)
  --config <file>     Rules config for \`rules\` (JSON: [{name, from, to, …}])
  --limit <n>         Max results for \`search\` (default 20)
  --no-fuzzy          \`search\`: disable trigram fuzzy fallback for query terms
                      with zero document frequency (default: enabled)
  --semantic          \`search\`: RRF-fuse an embedding tier with lexical — the
                      HTTP endpoint if CODEINDEX_EMBED_ENDPOINT is set, else a
                      local static model (lexical-only when neither is available)
  --run               \`embed serve\`: run the docker command instead of printing it
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
  ignoreDirs: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxCalls?: number;
  noAst: boolean;
  since?: string;
  ignoreCase?: boolean;
  maxHits?: number;
  budgetTokens?: number;
  config?: string; // rules config path
  limit?: number; // search result cap
  fuzzy: boolean; // search: trigram fuzzy fallback for df==0 terms (default true)
  semantic: boolean; // search: RRF-fuse the static-embedding tier (default false)
  recall?: boolean; // callers: recall-oriented binding
  run?: boolean; // `embed serve`: actually run the docker command (default: print)
  projectRoot?: string; // scip: override Metadata.project_root
  positional?: string; // e.g. the grep pattern or search query
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { repo: process.cwd(), include: [], exclude: [], gitignore: true, ignoreDirs: [], noAst: false, fuzzy: true, semantic: false };
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
    else if (a === "--out") {
      const v = next();
      flags.out = v === "-" ? "-" : resolve(v); // "-" = stdout (scip binary)
    } else if (a === "--project-root") flags.projectRoot = next();
    else if (a === "--include") flags.include.push(next());
    else if (a === "--exclude") flags.exclude.push(next());
    else if (a === "--scope") flags.scope = next();
    else if (a === "--no-gitignore") flags.gitignore = false;
    else if (a === "--ignore-dir") flags.ignoreDirs.push(next());
    else if (a === "--max-files") flags.maxFiles = num();
    else if (a === "--max-bytes") flags.maxBytes = num();
    else if (a === "--max-calls") flags.maxCalls = num();
    else if (a === "--ignore-case") flags.ignoreCase = true;
    else if (a === "--max-hits") flags.maxHits = num();
    else if (a === "--budget-tokens") flags.budgetTokens = num();
    else if (a === "--no-ast") flags.noAst = true;
    else if (a === "--since") flags.since = next();
    else if (a === "--config") flags.config = resolve(next());
    else if (a === "--limit") flags.limit = num();
    else if (a === "--no-fuzzy") flags.fuzzy = false;
    else if (a === "--semantic") flags.semantic = true;
    else if (a === "--recall") flags.recall = true;
    else if (a === "--run") flags.run = true;
    else if (!a.startsWith("--") && flags.positional === undefined) flags.positional = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function emit(content: string, out?: string): void {
  if (out) writeFileSync(out, content);
  else process.stdout.write(content);
}

function scanOptions(flags: CliFlags, precomputedWalk?: WalkResult): BuildIndexOptions {
  return {
    include: flags.include.length ? flags.include : undefined,
    exclude: flags.exclude.length ? flags.exclude : undefined,
    scope: flags.scope,
    gitignore: flags.gitignore,
    ignoreDirs: flags.ignoreDirs.length ? flags.ignoreDirs : undefined,
    maxFiles: flags.maxFiles,
    maxBytes: flags.maxBytes,
    maxCallsPerFile: flags.maxCalls,
    // The walk performed once in runCli to warm the present-language grammars,
    // reused here so scanRepo does not traverse the tree a second time. Absent
    // for --no-ast / scan-less commands: scanRepo walks itself, unchanged.
    precomputedWalk,
  };
}

// Commands that never walk/scan the file tree — they read git/grep directly or
// only manage the grammar cache, so they must warm NO tree-sitter grammar (the
// CLI previously warmed every one unconditionally). `embed` is scan-only for its
// `build` subcommand; the other embed subcommands (status/pull/serve) are
// excluded by the positional check at the warm site. `grammars` (status/pull)
// resolves/downloads the wasms itself and must not warm them.
// version/help/mcp return before we get there.
const SCANLESS_COMMANDS = new Set(["grep", "churn", "coupling", "workspaces", "grammars"]);

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

  // Warm ONLY the grammars for languages actually present, and only for commands
  // that scan the file tree. Scan-less commands (grep, churn, coupling,
  // workspaces, embed status|pull|serve) load no grammar at all; version/help/mcp
  // already returned above. The walk is done ONCE here to derive the present
  // extensions, then handed to the scan via precomputedWalk so the tree is
  // traversed a single time. --no-ast keeps the regex tier: no walk, no warm —
  // scanRepo walks itself, exactly as before.
  const scans = !SCANLESS_COMMANDS.has(cmd) && !(cmd === "embed" && flags.positional !== "build");
  let precomputedWalk: WalkResult | undefined;
  if (scans && !flags.noAst) {
    precomputedWalk = walk(flags.repo, {
      maxFileBytes: flags.maxBytes,
      maxFiles: flags.maxFiles,
      gitignore: flags.gitignore,
      ignoreDirs: flags.ignoreDirs.length ? flags.ignoreDirs : undefined,
    });
    await ensureGrammars(grammarKeysForExts(precomputedWalk.files.map((f) => f.ext)));
  }

  if (cmd === "index") {
    if (!flags.out) throw new Error("index needs --out <dir>");
    const outDir = flags.out;
    mkdirSync(outDir, { recursive: true });
    // Incremental cache: reuse per-file records when (schema, extractor) match —
    // same invalidation discipline as ultraindex's cache.json.
    const cachePath = join(outDir, "cache.json");
    type CacheEntry = { hash: string; record: FileRecord; size?: number; mtimeMs?: number };
    // ADDITIVE meta keys describing the artifacts the cache-writing run put on
    // disk. Old engines ignore them (they only check schema/extractor above);
    // old caches lacking them simply never take the fastpath below (their
    // per-file records are still reused). cache.json embeds mtimes, so it was
    // never cross-machine byte-reproducible — no determinism surface changes.
    type CacheMeta = {
      engineVersion?: string;
      commit?: string;
      graphSha1?: string;
      symbolsSha1?: string;
      embed?: { embedVersion?: number; modelId?: string; sha1?: string };
    };
    let cache: Map<string, CacheEntry> | undefined;
    let meta: CacheMeta = {};
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
        schemaVersion: number;
        extractorVersion: number;
        files: Record<string, CacheEntry>;
      } & CacheMeta;
      if (parsed.schemaVersion === SCHEMA_VERSION && parsed.extractorVersion === EXTRACTOR_VERSION) {
        cache = new Map(Object.entries(parsed.files));
        meta = {
          engineVersion: parsed.engineVersion,
          commit: parsed.commit,
          graphSha1: parsed.graphSha1,
          symbolsSha1: parsed.symbolsSha1,
          embed: parsed.embed,
        };
      }
    } catch {
      // no cache yet (or unreadable) — cold build
    }
    const scan = scanRepo(flags.repo, { ...scanOptions(flags, precomputedWalk), cache, out: outDir });
    const modelDir = resolveEmbedModelDir(flags.repo);
    const model = modelDir ? loadEmbedModel(modelDir) : undefined;

    const graphPath = join(outDir, "graph.json");
    const symbolsPath = join(outDir, "symbols.json");
    const embedPath = join(outDir, "embeddings.bin");
    // sha of an on-disk artifact, or undefined when it is missing/unreadable —
    // never equal to a defined meta sha, so a deleted artifact fails the guard.
    const artifactSha = (path: string): string | undefined => {
      try {
        return sha1(readFileSync(path));
      } catch {
        return undefined;
      }
    };
    const writeCache = (out: Pick<CacheMeta, "graphSha1" | "symbolsSha1" | "embed">): void => {
      const files: Record<string, CacheEntry> = {};
      for (const f of scan.files) {
        const entry: CacheEntry = { hash: f.hash, record: f, size: f.size };
        const mtime = scan.mtimes.get(f.rel);
        if (mtime !== undefined) entry.mtimeMs = mtime;
        files[f.rel] = entry;
      }
      // Fixed key order; JSON.stringify drops the undefined-valued keys
      // (commit outside a git worktree, embed without a model) cleanly.
      writeFileSync(
        cachePath,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          extractorVersion: EXTRACTOR_VERSION,
          engineVersion: ENGINE_VERSION,
          commit: scan.commit,
          graphSha1: out.graphSha1,
          symbolsSha1: out.symbolsSha1,
          embed: out.embed,
          files,
        }) + "\n",
      );
    };

    // FASTPATH GUARD — skip the whole downstream pipeline only when this scan
    // is proven identical to the run that wrote the on-disk artifacts:
    // contentUnchanged means this scan's records are object-identical to that
    // run's; downstream is a pure function of (records, docText, commit,
    // meta-opts) and the CLI never sets meta/previousCommunities;
    // engineVersion pins the version stamp; commit must match because
    // graph.json embeds it (identical trees under a new HEAD must rebuild);
    // the shas prove the on-disk bytes are that run's output. ANY failure —
    // deleted or tampered artifacts included — falls through to the full
    // build, which rewrites everything (self-healing).
    const embedUnchanged =
      !model ||
      (meta.embed !== undefined &&
        meta.embed.embedVersion === EMBED_VERSION &&
        meta.embed.modelId === model.modelId &&
        meta.embed.sha1 !== undefined &&
        artifactSha(embedPath) === meta.embed.sha1);
    const fastpath =
      scan.contentUnchanged &&
      meta.engineVersion === ENGINE_VERSION &&
      meta.commit === scan.commit &&
      meta.graphSha1 !== undefined &&
      artifactSha(graphPath) === meta.graphSha1 &&
      meta.symbolsSha1 !== undefined &&
      artifactSha(symbolsPath) === meta.symbolsSha1 &&
      embedUnchanged;

    if (fastpath) {
      // Artifacts verified byte-identical to what this build would produce —
      // leave them untouched. Rewrite cache.json only when the scan says its
      // bytes would change (e.g. an mtime drifted); the meta is carried
      // forward verbatim since the guard just proved it describes the disk.
      if (scan.cacheDirty) writeCache(meta);
      process.stderr.write(
        `codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${scan.capped ? " (capped)" : ""} (unchanged — artifacts reused)\n`,
      );
    } else {
      const { graph, symbols } = buildArtifactsFromScan(scan);
      const graphJson = renderGraphJson(graph);
      const symbolsJson = renderSymbolsJson(symbols);
      writeFileSync(graphPath, graphJson);
      writeFileSync(symbolsPath, symbolsJson);
      // Deterministic embeddings sidecar: written next to graph.json ONLY when a
      // model asset is present (opt-in). Silently skipped otherwise — no model, no
      // embeddings.bin, no impact on the graph/symbols consumers.
      let embedNote = "";
      let embedMeta: CacheMeta["embed"];
      if (model) {
        const index = buildEmbeddingIndex(scan, model);
        const bytes = serializeEmbeddings(index);
        writeFileSync(embedPath, bytes);
        embedMeta = { embedVersion: EMBED_VERSION, modelId: model.modelId, sha1: sha1(bytes) };
        embedNote = ` + embeddings.bin (${index.records.length} records, model ${model.modelId})`;
      }
      // cache.json is written LAST so its meta always describes artifacts that
      // are already on disk — a crash mid-way leaves stale meta whose shas
      // fail the guard on the next run (safe: it just rebuilds).
      writeCache({ graphSha1: sha1(graphJson), symbolsSha1: sha1(symbolsJson), embed: embedMeta });
      process.stderr.write(`codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${embedNote}${scan.capped ? " (capped)" : ""}\n`);
    }
  } else if (cmd === "scan") {
    const { scan } = buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
    const summary = {
      engineVersion: ENGINE_VERSION,
      commit: scan.commit,
      fileCount: scan.files.length,
      languages: scan.languages,
      capped: scan.capped,
    };
    emit(JSON.stringify(summary, null, 2) + "\n", flags.out);
  } else if (cmd === "graph") {
    const { graph } = buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
    emit(renderGraphJson(graph), flags.out);
  } else if (cmd === "symbols") {
    const { symbols } = buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
    emit(renderSymbolsJson(symbols), flags.out);
  } else if (cmd === "scip") {
    const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
    const bytes = renderScip(scan, { projectRoot: flags.projectRoot });
    const out = flags.out ?? resolve("index.scip");
    if (out === "-") process.stdout.write(Buffer.from(bytes));
    else {
      writeFileSync(out, bytes);
      process.stderr.write(`codeindex: SCIP index → ${out} (${bytes.length} bytes)\n`);
    }
  } else if (cmd === "callers") {
    const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
    const index = buildCallerIndex(scan, undefined, { recall: flags.recall });
    const obj: Record<string, unknown> = {};
    for (const [name, entry] of index) obj[name] = entry;
    emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
  } else if (cmd === "search") {
    if (!flags.positional) throw new Error('search needs a query: cli.mjs search "<query>" --repo <dir>');
    const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
    if (flags.semantic) {
      const endpoint = resolveEmbedEndpoint();
      const lexical = (): void => {
        const results = searchIndex(scan, flags.positional!, { limit: flags.limit, fuzzy: flags.fuzzy });
        emit(JSON.stringify(results, null, 2) + "\n", flags.out);
      };
      if (endpoint) {
        // Rich tier. The endpoint takes PRECEDENCE over a local static model:
        // configuring CODEINDEX_EMBED_ENDPOINT is an explicit user intent. An
        // unreachable/timed-out/malformed endpoint degrades straight to lexical
        // (a stderr note, exit 0) — NOT to the static model.
        try {
          const index = await buildEndpointIndex(scan);
          const queryVec = await encodeQueryViaEndpoint(flags.positional);
          const results = searchSemantic(scan, flags.positional, index, { queryVec, limit: flags.limit, fuzzy: flags.fuzzy });
          emit(JSON.stringify(results, null, 2) + "\n", flags.out);
        } catch (e) {
          process.stderr.write(
            `codeindex: embedding endpoint ${endpoint} unavailable (${e instanceof Error ? e.message : e}) — returning lexical results\n`,
          );
          lexical();
        }
      } else {
        const modelDir = resolveEmbedModelDir(flags.repo);
        const model = modelDir ? loadEmbedModel(modelDir) : undefined;
        if (!model) {
          // Degradation: --semantic without a model or endpoint → lexical results
          // + a stderr note, exit 0. The results shape is a superset of lexical.
          process.stderr.write(
            "codeindex: semantic search unavailable (no embedding model or endpoint) — returning lexical results; run `codeindex embed pull` or set CODEINDEX_EMBED_ENDPOINT to enable it\n",
          );
          lexical();
        } else {
          const index = buildEmbeddingIndex(scan, model);
          const results = searchSemantic(scan, flags.positional, index, { model, limit: flags.limit, fuzzy: flags.fuzzy });
          emit(JSON.stringify(results, null, 2) + "\n", flags.out);
        }
      }
    } else {
      const results = searchIndex(scan, flags.positional, { limit: flags.limit, fuzzy: flags.fuzzy });
      emit(JSON.stringify(results, null, 2) + "\n", flags.out);
    }
  } else if (cmd === "embed") {
    const sub = flags.positional;
    const modelDir = resolveEmbedModelDir(flags.repo);
    if (sub === "status") {
      const model = modelDir ? loadEmbedModel(modelDir) : undefined;
      const endpoint = resolveEmbedEndpoint();
      // Effective mode with precedence: endpoint > static model > none.
      const mode: "none" | "static" | "endpoint" = endpoint ? "endpoint" : model ? "static" : "none";
      const status: Record<string, unknown> = {
        embedVersion: EMBED_VERSION,
        mode,
        model: model
          ? { present: true, dir: modelDir, modelId: model.modelId, dim: model.dim, vocabSize: model.vocabSize }
          : { present: false },
        endpoint: endpoint ?? null,
      };
      // When an endpoint is configured, actually probe its reachability.
      if (endpoint) status.endpointReachable = await probeEndpoint(endpoint);
      emit(JSON.stringify(status, null, 2) + "\n", flags.out);
    } else if (sub === "serve") {
      // Convenience only — the LIBRARY never orchestrates docker (engine.ts is
      // side-effect-free). This lives in the CLI: it prints (or, with --run,
      // executes) the docker command that starts the embedding server image.
      const dockerArgs = ["run", "-d", "-p", "8756:8756", "ghcr.io/maxgfr/codeindex-embed:latest"];
      const oneLiner = `docker ${dockerArgs.join(" ")}`;
      if (!have("docker")) {
        process.stderr.write(
          "codeindex: docker not found on PATH. Install Docker, then run:\n  " + oneLiner + "\n",
        );
        process.exitCode = 1;
        return;
      }
      if (flags.run) {
        process.stderr.write(`codeindex: starting embedding server → ${oneLiner}\n`);
        const res = sh("docker", dockerArgs);
        if (res.stdout.trim()) process.stdout.write(res.stdout.trim() + "\n"); // container id
        if (!res.ok) {
          process.stderr.write(res.stderr || "codeindex: docker run failed\n");
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          "codeindex: server starting on http://localhost:8756 — then:\n" +
            "  CODEINDEX_EMBED_ENDPOINT=http://localhost:8756 codeindex search \"<query>\" --repo . --semantic\n",
        );
      } else {
        // Print the command for the user to run (default; no side effects).
        process.stdout.write(oneLiner + "\n");
        process.stderr.write(
          "codeindex: run the line above to start the embedding server (or `embed serve --run`), then:\n" +
            "  CODEINDEX_EMBED_ENDPOINT=http://localhost:8756 codeindex search \"<query>\" --repo . --semantic\n",
        );
      }
    } else if (sub === "build") {
      if (!flags.out) throw new Error("embed build needs --out <dir>");
      if (!modelDir) {
        process.stderr.write("codeindex: no embedding model present — run `codeindex embed pull` first (nothing written)\n");
        process.exitCode = 1;
        return;
      }
      const model = loadEmbedModel(modelDir)!;
      mkdirSync(flags.out, { recursive: true });
      const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
      const index = buildEmbeddingIndex(scan, model);
      writeFileSync(join(flags.out, "embeddings.bin"), serializeEmbeddings(index));
      process.stderr.write(`codeindex: ${index.records.length} embedding records → ${flags.out}/embeddings.bin (model ${model.modelId})\n`);
    } else if (sub === "pull") {
      // Default: the official published asset + its pinned sha256. A user-set
      // CODEINDEX_EMBED_URL overrides both (mirror/custom model, no verification).
      const { url, sha256 } = resolveEmbedPullUrl();
      const destDir = process.env.CODEINDEX_EMBED_DIR ?? join(flags.repo, ".codeindex", "models");
      mkdirSync(destDir, { recursive: true });
      process.stderr.write(`codeindex: fetching model from ${url} → ${join(destDir, "model.json")}\n`);
      let body: string;
      try {
        // Follows redirects (GitHub → CDN) and verifies sha256 for the default asset.
        body = await fetchEmbedModel(url, sha256);
      } catch (e) {
        process.stderr.write(`codeindex: pull failed — ${e instanceof Error ? e.message : String(e)} (nothing written)\n`);
        process.exitCode = 1;
        return;
      }
      try {
        // Shape-validate BEFORE writing: a JSON-valid but shape-invalid asset
        // would otherwise land on disk and turn every later semantic search
        // into a hard loadEmbedModel error instead of the documented degrade.
        parseEmbedModel(JSON.parse(body), url);
      } catch (e) {
        process.stderr.write(
          `codeindex: pull failed — response is not a valid model.json (${e instanceof Error ? e.message : String(e)}) (nothing written)\n`,
        );
        process.exitCode = 1;
        return;
      }
      writeFileSync(join(destDir, "model.json"), body);
      process.stderr.write(`codeindex: model written to ${join(destDir, "model.json")}\n`);
    } else {
      throw new Error("embed needs a subcommand: status | build | pull | serve");
    }
  } else if (cmd === "grammars") {
    const sub = flags.positional;
    const cacheDir = sharedGrammarsCacheDir();
    if (sub === "status") {
      // Report which tier furnishes the wasms (adjacent/env/cache/none), the
      // resolved dir, the pinned ENGINE_VERSION the cache is keyed on, and
      // whether a pull is needed (no runtime wasm resolvable → AST off, regex).
      const info = resolveGrammarsTier();
      const runtimePresent = info.dir ? existsSync(join(info.dir, "web-tree-sitter.wasm")) : false;
      const target = resolveGrammarsPullTarget();
      const status: Record<string, unknown> = {
        engineVersion: ENGINE_VERSION,
        tier: info.tier,
        dir: info.dir ?? null,
        cacheDir,
        runtimePresent,
        pullNeeded: !runtimePresent,
        url: target.url,
      };
      emit(JSON.stringify(status, null, 2) + "\n", flags.out);
    } else if (sub === "pull") {
      // Default: the official per-release asset + its `.sha256` sidecar. A
      // user-set CODEINDEX_GRAMMARS_URL overrides both (mirror/custom, no
      // verification). Fetch the expected digest from the sidecar first; a
      // missing sidecar degrades to an unverified pull with a note (never fatal).
      const target = resolveGrammarsPullTarget();
      let expected: string | undefined;
      if (target.sha256Url) {
        try {
          expected = await fetchExpectedSha256(target.sha256Url);
        } catch (e) {
          process.stderr.write(
            `codeindex: could not fetch checksum (${e instanceof Error ? e.message : String(e)}) — proceeding unverified\n`,
          );
        }
      }
      // Idempotent: the marker sibling records the digest of the tarball that
      // populated cacheDir. If the runtime wasm is present AND the marker matches
      // the freshly-fetched digest, the cache is already up to date — skip the
      // ~22 MB download entirely. (Keeps cacheDir itself byte-identical to the
      // tarball; the marker lives next to it, never inside it.)
      const runtime = join(cacheDir, "web-tree-sitter.wasm");
      const markerPath = join(dirname(cacheDir), `${ENGINE_VERSION}.sha256`);
      if (existsSync(runtime) && expected && existsSync(markerPath)) {
        let marker = "";
        try {
          marker = readFileSync(markerPath, "utf8").trim();
        } catch {
          // unreadable marker → fall through and re-pull
        }
        if (marker === expected) {
          process.stderr.write(`codeindex: grammars already present at ${cacheDir} (up to date)\n`);
          return;
        }
      }
      process.stderr.write(`codeindex: fetching grammars from ${target.url} → ${cacheDir}\n`);
      let bytes: Uint8Array;
      try {
        // Follows redirects (GitHub → CDN) and verifies sha256 when known.
        bytes = await fetchGrammarsTarball(target.url, expected);
      } catch (e) {
        process.stderr.write(`codeindex: pull failed — ${e instanceof Error ? e.message : String(e)} (nothing written)\n`);
        process.exitCode = 1;
        return;
      }
      // Atomic install: extract into a tmp dir SIBLING to cacheDir (same
      // filesystem → rename is atomic), sanity-check the runtime wasm landed,
      // then swap it into place. A failure at any step discards the tmp dir and
      // leaves any existing cache untouched — a half-populated cache never shows.
      let tmp: string | undefined;
      try {
        mkdirSync(dirname(cacheDir), { recursive: true });
        tmp = mkdtempSync(join(dirname(cacheDir), ".grammars-tmp-"));
        extractGrammarsTarball(bytes, tmp);
        if (!existsSync(join(tmp, "web-tree-sitter.wasm"))) {
          throw new Error("archive is missing web-tree-sitter.wasm");
        }
        if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
        renameSync(tmp, cacheDir);
        tmp = undefined;
        if (expected) writeFileSync(markerPath, expected + "\n");
      } catch (e) {
        if (tmp) {
          try {
            rmSync(tmp, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
        process.stderr.write(
          `codeindex: pull failed — ${e instanceof Error ? e.message : String(e)} (nothing written)\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stderr.write(`codeindex: grammars extracted → ${cacheDir}\n`);
    } else {
      throw new Error("grammars needs a subcommand: status | pull");
    }
  } else if (cmd === "rules") {
    if (!flags.config) throw new Error("rules needs --config <codeindex.rules.json>");
    const rules = parseRules(JSON.parse(readFileSync(flags.config, "utf8")));
    const { graph } = buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
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
    const { scan, graph } = buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
    emit(renderRepoMap(scan, graph, { budgetTokens: flags.budgetTokens }), flags.out);
  } else if (cmd === "hotspots") {
    const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, hotspots: rankHotspots(scan, churn) }, null, 2) + "\n", flags.out);
  } else if (cmd === "coupling") {
    const { ok, couplings } = changeCoupling(flags.repo, { since: flags.since });
    emit(JSON.stringify({ ok, couplings }, null, 2) + "\n", flags.out);
  } else if (cmd === "deadcode") {
    emit(JSON.stringify(findDeadCode(scanRepo(flags.repo, scanOptions(flags, precomputedWalk))), null, 2) + "\n", flags.out);
  } else if (cmd === "complexity") {
    const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
    emit(JSON.stringify(symbolComplexity(scan, flags.positional), null, 2) + "\n", flags.out);
  } else if (cmd === "risk") {
    const scan = scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, risks: riskHotspots(scan, churn) }, null, 2) + "\n", flags.out);
  } else if (cmd === "mermaid") {
    const { graph } = buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
    emit(renderMermaid(graph, { module: flags.positional }), flags.out);
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
