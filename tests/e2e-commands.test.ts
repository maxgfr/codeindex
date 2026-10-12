import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Graph, SymbolIndex } from "../src/types.js";
import { clonePinned, REPOS, type RealRepo } from "./real-repos.js";
import {
  decodeScip,
  filesUnder,
  gitChurnOracle,
  gitDiffNames,
  gitIgnored,
  gitVisibleFiles,
  hasStackTrace,
  haveRg,
  mermaidProblems,
  parseJson,
  rgFilesWithWord,
  rgLiteralHits,
  runCli,
  setDiff,
  startMcp,
  type CliRun,
} from "./oracles/real-world.js";

// The real-world command campaign: every CLI command and every MCP tool, run
// against each pinned repository of tests/real-repos.ts and held to two kinds
// of check.
//
//   Invariants, on every call: the expected exit code, valid JSON on stdout
//   where the command promises JSON, no stack trace on stderr, the same bytes
//   on a second run, the repo's time budget, and — for MCP — a response no
//   larger on the wire than the server's --max-response-bytes.
//
//   Oracles, per repo: what git, ripgrep and a protobuf reader say the answer
//   must contain (see tests/oracles/real-world.ts).
//
// Opt-in (network, minutes per repo): `pnpm test:e2e:commands`. It runs the
// BUILT CLI (scripts/cli.mjs), the surface users get. CODEINDEX_E2E_REPOS=a/b,c/d
// narrows the matrix; CODEINDEX_E2E_REPORT=<dir> writes each repo's anomalies
// as JSON there (the input of docs/real-world-validation-*.md).
const E2E = !!process.env.CODEINDEX_E2E;
const ONLY = process.env.CODEINDEX_E2E_REPOS?.split(",").map((s) => s.trim()).filter(Boolean);
const SELECTED = ONLY?.length ? REPOS.filter((r) => ONLY.includes(r.slug)) : REPOS;
const REPORT_DIR = process.env.CODEINDEX_E2E_REPORT;
const MCP_CAP = 1_000_000;

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

interface Samples {
  hubFiles: string[]; // most-imported primary-language files
  functions: { name: string; file: string; line: number; endLine?: number }[];
  types: { name: string; file: string; line: number }[];
  rulesConfig: string;
}

interface Ctx {
  repo: RealRepo;
  dir: string;
  graph: Graph;
  symbols: SymbolIndex;
  samples: Samples;
  results: Map<string, CliRun>;
  anomalies: { check: string; detail: string }[];
}

// A deterministic spread of the repo's own declarations: one-definition names
// in the primary language, ordered by a hash of the name so the sample is not
// the alphabetical head of the index.
function pickSamples(repo: RealRepo, graph: Graph, symbols: SymbolIndex, scratch: string): Samples {
  const primary = graph.files.filter((f) => f.lang === repo.primaryLang && f.fileKind === "code");
  const hubFiles = [...primary]
    .sort((a, b) => b.degIn - a.degIn || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .slice(0, 3)
    .map((f) => f.rel);
  const single = Object.entries(symbols.defs)
    .filter(([name, defs]) => defs.length === 1 && defs[0]!.lang === repo.primaryLang && /^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(name))
    .sort(([a], [b]) => (sha1(a) < sha1(b) ? -1 : 1));
  const functions = single
    .filter(([, [d]]) => CALLABLE.has(d!.kind))
    .slice(0, 4)
    .map(([name, [d]]) => ({ name, file: d!.file, line: d!.line, endLine: d!.endLine }));
  const types = single
    .filter(([, [d]]) => ["class", "interface", "struct", "trait", "protocol"].includes(d!.kind))
    .slice(0, 2)
    .map(([name, [d]]) => ({ name, file: d!.file, line: d!.line }));
  const rulesConfig = join(scratch, "rules.json");
  writeFileSync(
    rulesConfig,
    JSON.stringify([
      { name: "no-cycles", builtin: "cycles", severity: "warn" },
      { name: "tests-stay-out", from: "**/*.{ts,js,py,go,rs,java,kt}", to: "**/{test,tests,spec}/**", severity: "warn" },
    ]),
  );
  return { hubFiles, functions, types, rulesConfig };
}

// Every kind a callable declaration is emitted with, across languages (Ruby
// and Python say "def").
const CALLABLE = new Set(["function", "method", "def", "fn", "func", "constructor"]);

interface Spec {
  id: string;
  args: (s: Samples, ctx: Ctx) => string[] | undefined; // undefined = no sample to run it on
  json?: boolean; // stdout must parse as JSON (default true)
  exit?: number[]; // accepted exit codes (default [0])
}

const fn = (s: Samples, i = 0) => s.functions[i];
const COMMANDS: Spec[] = [
  { id: "version", args: () => ["version"], json: false },
  { id: "scan", args: () => ["scan"] },
  { id: "scan --skipped", args: () => ["scan", "--skipped"] },
  { id: "scan --why", args: (s) => (s.hubFiles[0] ? ["scan", "--why", s.hubFiles[0]] : undefined) },
  { id: "status", args: () => ["status"] },
  { id: "graph", args: () => ["graph"] },
  { id: "symbols", args: () => ["symbols"] },
  { id: "scip", args: () => ["scip", "--out", "-"], json: false },
  { id: "callers", args: () => ["callers"] },
  { id: "callers <fn>", args: (s) => fn(s) && ["callers", fn(s)!.name] },
  { id: "callers <fn> --with-caller", args: (s) => fn(s) && ["callers", fn(s)!.name, "--with-caller"] },
  { id: "callers <fn> --recall", args: (s) => fn(s) && ["callers", fn(s)!.name, "--recall"] },
  { id: "callers <fn> --raw", args: (s) => fn(s) && ["callers", fn(s)!.name, "--raw"] },
  { id: "hierarchy", args: () => ["hierarchy"] },
  { id: "implementations <type>", args: (s) => s.types[0] && ["implementations", s.types[0].name], exit: [0, 2] },
  { id: "callgraph <fn>", args: (s) => fn(s) && ["callgraph", fn(s)!.name, "--depth", "2"] },
  { id: "callpath <fn> <fn>", args: (s) => fn(s, 1) && ["callpath", fn(s)!.name, fn(s, 1)!.name] },
  { id: "callpath --files", args: (s) => (s.hubFiles.length > 1 ? ["callpath", s.hubFiles[1]!, s.hubFiles[0]!, "--files"] : undefined) },
  { id: "find <fn>", args: (s) => fn(s) && ["find", fn(s)!.name] },
  { id: "find --substring --concise", args: (s) => fn(s) && ["find", fn(s)!.name.slice(0, 4), "--substring", "--concise", "--limit", "20"] },
  { id: "refs <fn>", args: (s) => fn(s) && ["refs", fn(s)!.name] },
  { id: "outline <hub>", args: (s) => (s.hubFiles[0] ? ["outline", s.hubFiles[0]] : undefined) },
  { id: "symbol-at <fn>", args: (s) => fn(s) && ["symbol-at", `${fn(s)!.file}:${fn(s)!.line}`] },
  { id: "workspaces", args: () => ["workspaces"] },
  { id: "workspaces --check", args: () => ["workspaces", "--check"], exit: [0, 1] },
  { id: "churn", args: () => ["churn"] },
  { id: "grep <fn>", args: (s) => fn(s) && ["grep", fn(s)!.name, "--max-hits", "1000000"] },
  { id: "search", args: (s) => fn(s) && ["search", fn(s)!.name] },
  { id: "search --explain", args: (s) => fn(s) && ["search", `${fn(s)!.name} handler`, "--explain"] },
  { id: "embed status", args: () => ["embed", "status"] },
  { id: "lsp status", args: () => ["lsp", "status"] },
  { id: "grammars status", args: () => ["grammars", "status"] },
  { id: "rules", args: (s) => ["rules", "--config", s.rulesConfig] },
  { id: "repomap", args: () => ["repomap", "--budget-tokens", "800"], json: false },
  { id: "hotspots", args: () => ["hotspots"] },
  { id: "coupling", args: () => ["coupling", "--min-together", "2"] },
  { id: "literals", args: () => ["literals"] },
  { id: "deadcode", args: () => ["deadcode", "--limit", "50"] },
  { id: "complexity", args: () => ["complexity", "--limit", "20"] },
  { id: "complexity <hub>", args: (s) => (s.hubFiles[0] ? ["complexity", s.hubFiles[0]] : undefined) },
  { id: "risk", args: () => ["risk"] },
  { id: "delta --base HEAD~5", args: () => ["delta", "--base", "HEAD~5", "--json"] },
  { id: "delta panel", args: () => ["delta", "--base", "HEAD~5"], json: false },
  { id: "impact <hub>", args: (s) => (s.hubFiles[0] ? ["impact", s.hubFiles[0]] : undefined) },
  { id: "neighbors <hub>", args: (s) => (s.hubFiles[0] ? ["neighbors", s.hubFiles[0], "--depth", "2"] : undefined) },
  { id: "resolution", args: () => ["resolution"] },
  { id: "mermaid", args: () => ["mermaid"], json: false },
  { id: "rewrite", args: (s) => fn(s) && ["rewrite", `grep -rn '${fn(s)!.name}' .`], json: false, exit: [0, 1] },
];

const contexts = new Map<string, Ctx>();
const ctxOf = (repo: RealRepo): Ctx => contexts.get(repo.slug)!;
const note = (ctx: Ctx, check: string, detail: string): void => void ctx.anomalies.push({ check, detail });

function json<T>(ctx: Ctx, id: string): T | undefined {
  const run = ctx.results.get(id);
  if (!run || run.code !== 0) return undefined;
  const parsed = parseJson(run.stdout);
  return parsed.ok ? (parsed.value as T) : undefined;
}

describe.skipIf(!E2E).each(SELECTED)("commands on $slug", (repo) => {
  beforeAll(() => {
    const dir = clonePinned(repo);
    // The index lives where every read command and the MCP server look for it;
    // git is told to ignore it so the scan and delta oracles see a clean tree.
    const exclude = join(dir, ".git", "info", "exclude");
    if (!(existsSync(exclude) && readFileSync(exclude, "utf8").includes("\n.codeindex/\n"))) appendFileSync(exclude, "\n.codeindex/\n");
    const built = runCli(["index", "--repo", dir, "--out", join(dir, ".codeindex")]);
    if (built.code !== 0) throw new Error(`index failed: ${built.stderr}`);
    const graph = JSON.parse(readFileSync(join(dir, ".codeindex", "graph.json"), "utf8")) as Graph;
    const symbols = JSON.parse(readFileSync(join(dir, ".codeindex", "symbols.json"), "utf8")) as SymbolIndex;
    const scratch = mkdtempSync(join(tmpdir(), "ci-e2e-cmd-"));
    contexts.set(repo.slug, { repo, dir, graph, symbols, samples: pickSamples(repo, graph, symbols, scratch), results: new Map(), anomalies: [] });
  }, 900_000);

  afterAll(() => {
    const ctx = contexts.get(repo.slug);
    if (!ctx || !REPORT_DIR) return;
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      join(REPORT_DIR, `${repo.slug.replace("/", "__")}.json`),
      JSON.stringify({ slug: repo.slug, sha: repo.sha, samples: ctx.samples, anomalies: ctx.anomalies }, null, 2) + "\n",
    );
  });

  it.each(COMMANDS)("$id: exit, JSON, no stack, deterministic, in budget", { timeout: 900_000 }, (spec) => {
    const ctx = ctxOf(repo);
    const args = spec.args(ctx.samples, ctx);
    if (!args) return; // no sample of that shape in this repo
    const full = [...args, "--repo", ctx.dir];
    const first = runCli(full, { cwd: ctx.dir });
    const second = runCli(full, { cwd: ctx.dir });
    ctx.results.set(spec.id, first);
    const problems: string[] = [];
    const exits = spec.exit ?? [0];
    if (!exits.includes(first.code ?? -1)) problems.push(`exit ${first.code} (expected ${exits.join("|")}): ${first.stderr.slice(0, 400)}`);
    if (hasStackTrace(first.stderr)) problems.push(`stack trace on stderr: ${first.stderr.slice(0, 400)}`);
    if (first.code === 0 && spec.json !== false) {
      const parsed = parseJson(first.stdout);
      if (!parsed.ok) problems.push(`stdout is not JSON: ${parsed.error}`);
    }
    if (!first.stdout.equals(second.stdout)) problems.push("second run printed different bytes");
    if (first.code !== second.code) problems.push(`second run exited ${second.code}, first ${first.code}`);
    if (first.ms > repo.budgetMs) problems.push(`took ${Math.round(first.ms)}ms > budget ${repo.budgetMs}ms`);
    for (const p of problems) note(ctx, spec.id, p);
    expect(problems, `${repo.slug} ${full.join(" ")}`).toEqual([]);
  });

  it("scan: every file git would build is indexed or skipped with a reason; nothing ignored is indexed", { timeout: 600_000 }, () => {
    const ctx = ctxOf(repo);
    const skipped = json<{ rel: string; reason: string; directory: boolean }[]>(ctx, "scan --skipped") ?? [];
    const indexed = new Set(ctx.graph.files.map((f) => f.rel));
    const skippedFiles = new Set(skipped.filter((s) => !s.directory).map((s) => s.rel));
    const skippedDirs = skipped.filter((s) => s.directory).map((s) => s.rel + "/");
    const visible = gitVisibleFiles(ctx.dir);
    const problems: string[] = [];
    const unaccounted = [...visible].filter(
      // A symlinked directory is one blob to git (its own path) and one
      // directory skip to the walk.
      (p) => !indexed.has(p) && !skippedFiles.has(p) && !skippedDirs.some((d) => p.startsWith(d) || p + "/" === d),
    );
    if (unaccounted.length) problems.push(`${unaccounted.length} git-visible file(s) neither indexed nor skipped: ${unaccounted.slice(0, 10).join(", ")}`);
    const outsideGit = setDiff(indexed, visible);
    const ignored = gitIgnored(ctx.dir, outsideGit);
    if (ignored.size) problems.push(`${ignored.size} indexed file(s) git ignores: ${[...ignored].slice(0, 10).join(", ")}`);
    for (const p of problems) note(ctx, "scan oracle", p);
    expect(problems).toEqual([]);
  });

  it.skipIf(!haveRg())("grep: the literal hits equal ripgrep's on the indexed files", { timeout: 600_000 }, () => {
    const ctx = ctxOf(repo);
    const name = ctx.samples.functions[0]?.name;
    const hits = json<{ file: string; line: number }[]>(ctx, "grep <fn>");
    if (!name || !hits) return;
    const indexed = new Set(ctx.graph.files.map((f) => f.rel));
    const ours = new Set(hits.map((h) => `${h.file}:${h.line}`));
    const theirs = new Set([...rgLiteralHits(ctx.dir, name)].filter((h) => indexed.has(h.slice(0, h.lastIndexOf(":")))));
    const problems: string[] = [];
    const missing = setDiff(theirs, ours);
    const extra = setDiff([...ours].filter((h) => indexed.has(h.slice(0, h.lastIndexOf(":")))), theirs);
    if (missing.length) problems.push(`${missing.length} rg hit(s) grep missed: ${missing.slice(0, 8).join(", ")}`);
    if (extra.length) problems.push(`${extra.length} grep hit(s) rg does not have: ${extra.slice(0, 8).join(", ")}`);
    for (const p of problems) note(ctx, "grep oracle", p);
    expect(problems).toEqual([]);
  });

  it.skipIf(!haveRg())("refs: every referencing file really names the symbol (rg -w)", { timeout: 600_000 }, () => {
    const ctx = ctxOf(repo);
    const name = ctx.samples.functions[0]?.name;
    const refs = json<{ defs: { file: string }[]; callSites: { file: string }[]; referencingFiles: string[] }>(ctx, "refs <fn>");
    if (!name || !refs) return;
    const withWord = rgFilesWithWord(ctx.dir, name);
    const unsound = refs.referencingFiles.filter((f) => !withWord.has(f));
    const problems = unsound.length ? [`${unsound.length} referencing file(s) never name ${name}: ${unsound.slice(0, 8).join(", ")}`] : [];
    // Recall is reported, not asserted: rg also counts comments and strings.
    const indexed = new Set(ctx.graph.files.map((f) => f.rel));
    const found = new Set([...refs.referencingFiles, ...refs.defs.map((d) => d.file), ...refs.callSites.map((c) => c.file)]);
    const missed = [...withWord].filter((f) => indexed.has(f) && !found.has(f));
    if (missed.length) note(ctx, "refs recall (report only)", `${missed.length}/${withWord.size} rg -w file(s) not listed: ${missed.slice(0, 8).join(", ")}`);
    for (const p of problems) note(ctx, "refs oracle", p);
    expect(problems).toEqual([]);
  });

  it("callers ⊆ refs", { timeout: 60_000 }, () => {
    const ctx = ctxOf(repo);
    const callers = json<unknown>(ctx, "callers <fn>");
    const refs = json<{ defs: { file: string }[]; callSites: { file: string }[]; referencingFiles: string[] }>(ctx, "refs <fn>");
    if (!callers || !refs) return;
    const callerFiles = filesUnder(callers, new Set(["callers", "sites"]));
    const refFiles = new Set([...refs.referencingFiles, ...refs.defs.map((d) => d.file), ...refs.callSites.map((c) => c.file)]);
    const outside = setDiff(callerFiles, refFiles);
    const problems = outside.length ? [`caller file(s) refs does not list: ${outside.slice(0, 8).join(", ")}`] : [];
    for (const p of problems) note(ctx, "callers ⊆ refs", p);
    expect(problems).toEqual([]);
  });

  it("impact contains every direct importer", { timeout: 60_000 }, () => {
    const ctx = ctxOf(repo);
    const hub = ctx.samples.hubFiles[0];
    const impact = json<{ files: { rel: string }[] }>(ctx, "impact <hub>");
    if (!hub || !impact) return;
    const reached = new Set(impact.files.map((f) => f.rel));
    const importers = ctx.graph.fileEdges.filter((e) => e.to === hub && e.kind === "import" && !e.dangling && e.from !== hub).map((e) => e.from);
    const missed = importers.filter((f) => !reached.has(f));
    const problems = missed.length ? [`direct importer(s) of ${hub} missing from impact: ${missed.slice(0, 8).join(", ")}`] : [];
    for (const p of problems) note(ctx, "impact oracle", p);
    expect(problems).toEqual([]);
  });

  it("delta --base HEAD~5 reviews exactly git diff --name-only", { timeout: 60_000 }, () => {
    const ctx = ctxOf(repo);
    const delta = json<{ changes: { path: string }[]; unindexed: string[]; deleted: string[] }>(ctx, "delta --base HEAD~5");
    if (!delta) return;
    // A changed file the index does not hold (a lockfile, an image) is listed
    // under `unindexed`, a deleted one under `deleted`.
    const ours = new Set([...delta.changes.map((c) => c.path), ...delta.unindexed, ...delta.deleted]);
    const theirs = gitDiffNames(ctx.dir, "HEAD~5");
    const problems: string[] = [];
    const missing = setDiff(theirs, ours);
    const extra = setDiff(ours, theirs);
    if (missing.length) problems.push(`changed file(s) delta omits: ${missing.slice(0, 8).join(", ")}`);
    if (extra.length) problems.push(`file(s) delta lists that git does not: ${extra.slice(0, 8).join(", ")}`);
    for (const p of problems) note(ctx, "delta oracle", p);
    expect(problems).toEqual([]);
  });

  it("churn equals git log --numstat over the same window", { timeout: 120_000 }, () => {
    const ctx = ctxOf(repo);
    const churn = json<{ ok: boolean; churn: Record<string, number> }>(ctx, "churn");
    if (!churn) return;
    const oracle = gitChurnOracle(ctx.dir);
    const problems: string[] = [];
    for (const [path, n] of oracle) if (churn.churn[path] !== n) problems.push(`${path}: churn ${churn.churn[path]}, git ${n}`);
    for (const path of Object.keys(churn.churn)) if (!oracle.has(path)) problems.push(`${path}: churn lists it, git log does not`);
    for (const p of problems.slice(0, 20)) note(ctx, "churn oracle", p);
    expect(problems.slice(0, 20)).toEqual([]);
  });

  it("workspaces: every manifest exists", { timeout: 60_000 }, () => {
    const ctx = ctxOf(repo);
    const ws = json<{ packages: { manifest?: string; dir: string }[] }>(ctx, "workspaces");
    if (!ws) return;
    const problems = ws.packages
      .filter((p) => !existsSync(join(ctx.dir, p.manifest ?? p.dir)))
      .map((p) => `missing manifest ${p.manifest ?? p.dir}`);
    for (const p of problems) note(ctx, "workspaces oracle", p);
    expect(problems).toEqual([]);
  });

  it("scip decodes and carries a valid project_root URI", { timeout: 60_000 }, () => {
    const ctx = ctxOf(repo);
    const run = ctx.results.get("scip");
    if (!run || run.code !== 0) return;
    const problems: string[] = [];
    try {
      const { projectRoot, documents } = decodeScip(new Uint8Array(run.stdout));
      if (!documents) problems.push("no document in the index");
      let url: URL | undefined;
      try {
        url = new URL(projectRoot ?? "");
      } catch {
        problems.push(`project_root is not a URI: ${projectRoot}`);
      }
      if (url && projectRoot !== pathToFileURL(ctx.dir).href) problems.push(`project_root ${projectRoot} != ${pathToFileURL(ctx.dir).href}`);
      if (url && fileURLToPath(url) !== ctx.dir) problems.push(`project_root does not round-trip to ${ctx.dir}`);
    } catch (e) {
      problems.push(`does not decode: ${e instanceof Error ? e.message : e}`);
    }
    for (const p of problems) note(ctx, "scip oracle", p);
    expect(problems).toEqual([]);
  });

  it("mermaid labels are escaped", { timeout: 60_000 }, () => {
    const ctx = ctxOf(repo);
    const run = ctx.results.get("mermaid");
    if (!run || run.code !== 0) return;
    const problems = mermaidProblems(run.stdout.toString("utf8"));
    for (const p of problems) note(ctx, "mermaid oracle", p);
    expect(problems).toEqual([]);
  });

  it("MCP: all 40 tools answer, twice identically, within the response cap", { timeout: 1_800_000 }, async () => {
    const ctx = ctxOf(repo);
    const s = ctx.samples;
    const f0 = s.functions[0];
    const f1 = s.functions[1];
    const hub = s.hubFiles[0];
    const t0 = s.types[0];
    const mcp = startMcp(["--repo", ctx.dir, "--max-response-bytes", String(MCP_CAP)]);
    const problems: string[] = [];
    try {
      await mcp.init();
      const tools = await mcp.listTools();
      if (tools.length !== 40) problems.push(`tools/list advertises ${tools.length} tools, not 40`);
      // [tool, args, pure] — pure calls must answer the same text twice.
      const calls: [string, Record<string, unknown>, boolean][] = [
        ["scan_summary", {}, true],
        ["index_status", {}, true],
        ["graph", {}, true],
        ["symbols", f0 ? { name: f0.name } : {}, true],
        ["callers", f0 ? { name: f0.name, withCaller: true } : {}, true],
        ["workspaces", { check: true }, true],
        ["churn", {}, true],
        ["symbols_overview", hub ? { file: hub } : { file: "README.md" }, true],
        ["find_symbol", { namePath: f0?.name ?? "main", includeBody: true }, true],
        ["find_references", { name: f0?.name ?? "main" }, true],
        ["symbol_at", { file: f0?.file ?? hub ?? "README.md", line: f0?.line ?? 1 }, true],
        ["lsp_status", {}, true],
        ["onboard", { remember: false }, true],
        ["repo_map", { budgetTokens: 600 }, true],
        ["hotspots", {}, true],
        ["coupling", { minTogether: 2 }, true],
        ["dead_code", { limit: 30 }, true],
        ["duplicated_literals", { limit: 20 }, true],
        ["complexity", { top: 20 }, true],
        ["complexity", { risk: true, top: 20 }, true],
        ["mermaid", {}, true],
        ["grep", { pattern: f0?.name ?? "main", withMeta: true }, true],
        ["search", { query: f0?.name ?? "main" }, true],
        ["explain_search", { query: `${f0?.name ?? "main"} handler` }, true],
        ["embed_status", {}, true],
        ["type_hierarchy", t0 ? { name: t0.name } : {}, true],
        ["implementations", { name: t0?.name ?? f0?.name ?? "main" }, true],
        ["call_graph", { symbol: f0?.name ?? "main", depth: 2 }, true],
        ["call_path", { from: f0?.name ?? "main", to: f1?.name ?? "main" }, true],
        ["impact", { target: hub ?? "." }, true],
        ["neighbors", { target: hub ?? "." }, true],
        ["check_rules", { rules: [{ name: "no-cycles", builtin: "cycles", severity: "warn" }] }, true],
        ["resolution_report", {}, true],
        ["delta", { base: "HEAD~5" }, true],
        ["write_memory", { name: "e2e/probe", content: "# probe\n" }, false],
        ["list_memories", {}, false],
        ["read_memory", { name: "e2e/probe" }, false],
        ["delete_memory", { name: "e2e/probe" }, false],
      ];
      const seen = new Set<string>();
      for (const [tool, args, pure] of calls) {
        seen.add(tool);
        const first = await mcp.call(tool, args);
        const label = `${tool} ${JSON.stringify(args)}`;
        if (!first.ok) problems.push(`${label}: rpc error ${first.error}`);
        if (first.wireBytes > MCP_CAP) problems.push(`${label}: ${first.wireBytes} bytes on the wire > cap ${MCP_CAP}`);
        if (first.ms > repo.budgetMs) problems.push(`${label}: ${Math.round(first.ms)}ms > budget`);
        if (hasStackTrace(first.text)) problems.push(`${label}: stack trace in the answer`);
        if (pure) {
          const second = await mcp.call(tool, args);
          if (second.text !== first.text) problems.push(`${label}: second call answered differently`);
        }
      }
      // The three writes run on a throwaway copy of one file: replacing a
      // declaration with its own body must give the file back byte for byte.
      if (f0?.endLine) {
        const copy = mkdtempSync(join(tmpdir(), "ci-e2e-edit-"));
        mkdirSync(dirname(join(copy, f0.file)), { recursive: true });
        copyFileSync(join(ctx.dir, f0.file), join(copy, f0.file));
        const original = readFileSync(join(copy, f0.file));
        const edit = startMcp(["--repo", copy]);
        try {
          await edit.init();
          const found = await edit.call("find_symbol", { namePath: f0.name, includeBody: true });
          const body = (JSON.parse(found.text) as { body?: string; line: number }[]).find((d) => d.line === f0.line)?.body;
          if (body === undefined) problems.push(`find_symbol ${f0.name} returned no body on the copy`);
          else {
            const replaced = await edit.call("replace_symbol_body", { namePath: f0.name, body, line: f0.line });
            if (replaced.isError) problems.push(`replace_symbol_body (self): ${replaced.text.slice(0, 300)}`);
            else if (!readFileSync(join(copy, f0.file)).equals(original)) problems.push("replace_symbol_body with its own body changed the file");
            for (const tool of ["insert_after_symbol", "insert_before_symbol"]) {
              const r = await edit.call(tool, { namePath: f0.name, body, line: f0.line });
              if (r.isError && !/ambiguous|refus/i.test(r.text)) problems.push(`${tool}: ${r.text.slice(0, 300)}`);
            }
          }
          seen.add("replace_symbol_body").add("insert_after_symbol").add("insert_before_symbol");
        } finally {
          await edit.close();
        }
      }
      for (const t of tools) if (!seen.has(t) && !["replace_symbol_body", "insert_after_symbol", "insert_before_symbol"].includes(t)) problems.push(`tool ${t} not exercised`);
      if (hasStackTrace(mcp.stderr())) problems.push(`stack trace on the server's stderr: ${mcp.stderr().slice(0, 400)}`);
    } finally {
      await mcp.close();
    }
    for (const p of problems) note(ctx, "mcp", p);
    expect(problems).toEqual([]);
  });

  it("symbol round trip: outline → symbol_at → find_symbol agree", { timeout: 600_000 }, async () => {
    const ctx = ctxOf(repo);
    const problems: string[] = [];
    const mcp = startMcp(["--repo", ctx.dir]);
    try {
      await mcp.init();
      for (const file of ctx.samples.hubFiles) {
        const outline = JSON.parse((await mcp.call("symbols_overview", { file })).text) as { name: string; line: number; parent?: string }[];
        for (const sym of outline.slice(0, 12)) {
          const id = `${file}#${sym.parent ? sym.parent + "/" : ""}${sym.name}`;
          const at = JSON.parse((await mcp.call("symbol_at", { file, line: sym.line })).text) as {
            symbol: { id: string } | null;
            enclosing: string[];
          };
          // The innermost declaration on that line may be a nested one that
          // starts there too (a constructor property): then ours encloses it.
          if (at.symbol?.id !== id && !at.enclosing.includes(id)) problems.push(`symbol_at ${file}:${sym.line} = ${at.symbol?.id ?? null}, expected ${id}`);
          const found = JSON.parse((await mcp.call("find_symbol", { namePath: sym.parent ? `${sym.parent}/${sym.name}` : sym.name, concise: true, maxResults: 1_000_000 })).text) as {
            file: string;
            line: number;
          }[];
          if (!found.some((d) => d.file === file && d.line === sym.line)) problems.push(`find_symbol ${sym.name} misses ${file}:${sym.line}`);
        }
      }
    } finally {
      await mcp.close();
    }
    for (const p of problems.slice(0, 20)) note(ctx, "symbol round trip", p);
    expect(problems.slice(0, 20)).toEqual([]);
  });
});

