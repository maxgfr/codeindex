#!/usr/bin/env node
// Competitor benchmark orchestrator.
//
//   node scripts/bench/bench.mjs [--repo <slug>|all] [--runs N]
//        [--scenario <name>|all] [--write] [--repo-dir <path>] [--no-competitors]
//
// Prints the full BENCHMARKS.md markdown to stdout; with --write it also writes
// BENCHMARKS.md (repo root) + site/benchmarks.json. Timings are the median of N
// runs (default 5) with one warmup discarded; a scenario whose warmup exceeds
// 60s downgrades to `slowRuns` (3) and the per-cell run count is shown.
//
// Fairness, made explicit: 01x-in keeps a live SQLite graph and shells out to
// ast-grep PER FILE on its cold init; we emit static artifacts. We report two
// query modes — in-process (warm scan already loaded, API call only) and full
// CLI spawn — precisely so the reader can separate our algorithm cost from
// Node's process-startup cost, and compare each to the competitor's model.
//
// The harness never crashes because a competitor is absent: every competitor
// spawn is total (see competitors.runCmd) and renders `n/a (reason)`. Exit is 0
// even with n/a cells; a non-zero exit means one of OUR OWN operations failed.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, homedir, tmpdir, totalmem } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, CLI_PATH, ENGINE_URL, reposFor, clonePinned, pickSymbol } from "./repos.mjs";
import { detectCompetitors, noCompetitors, runCmd } from "./competitors.mjs";
import { adapterFor } from "./mcp-adapters.mjs";
import { formula01x, measuredTokens, byteLen } from "./tokens.mjs";
import { renderMarkdown, renderJson, na } from "./render.mjs";

const engine = await import(ENGINE_URL.href);

// ---- tiny fs/timing utilities ------------------------------------------------

let tmpCounter = 0;
const tmpPath = (tag) => join(tmpdir(), `bench-${process.pid}-${tmpCounter++}-${tag}`);
const rmrf = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };
const log = (msg) => process.stderr.write(`[bench] ${msg}\n`);

// Copy a repo's working tree WITHOUT .git (source is all any indexer needs).
function copySource(src) {
  const dst = mkdtempSync(tmpPath("copy-"));
  cpSync(src, dst, { recursive: true, filter: (s) => !s.split(sep).includes(".git") });
  return dst;
}

function dirBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) total += dirBytes(p);
    else { try { total += statSync(p).size; } catch { /* race */ } }
  }
  return total;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Run `thunk` (the ONLY timed region) warmup+N times. If the warmup crosses the
// slow threshold, the measured run count drops to slowRuns. `before/after` hooks
// run untimed around each iteration (fresh scratch dir, touch/restore a file).
function runMedian(cfg, thunk, hooks = {}) {
  const once = () => {
    hooks.before?.();
    const t0 = performance.now();
    const r = thunk();
    const dt = performance.now() - t0;
    hooks.after?.(r);
    return { dt, r };
  };
  const warm = once();
  const n = warm.dt > cfg.slowThresholdMs ? Math.min(cfg.runs, cfg.slowRuns) : cfg.runs;
  const times = [];
  let last = warm.r;
  for (let i = 0; i < n; i++) { const x = once(); times.push(x.dt); last = x.r; }
  return { ms: median(times), runs: n, last };
}

const msCell = (res) => ({ v: res.ms, k: "ms", runs: res.runs });

// ---- MCP competitors (serena / graphify / falcon / self over MCP) -------------

const PROBE_PATH = fileURLToPath(new URL("./mcp-probe.mjs", import.meta.url));
const MCP_SERVERS = ["codeindex", "serena", "graphify", "falcon"];
// Prime / cold-index ops and one whole probe child get the npm-install-class
// ceiling (spec timeout policy); the probe's per-session timeout is its own.
const MCP_OP_TIMEOUT_MS = 600_000;

// Adapter built from DETECTED paths — call only when comp[server] is available
// (a bare adapterFor would re-resolve binaries and defeat --no-competitors).
function adapterOf(server, comp) {
  if (server === "codeindex") return adapterFor("codeindex", { engine: CLI_PATH });
  if (server === "serena") return adapterFor("serena", { bin: comp.serena.path });
  if (server === "graphify") return adapterFor("graphify", { bin: comp.graphify.path, mcpBin: comp.graphify.extra?.mcpPath });
  return adapterFor("falcon", { bin: comp.falcon.path });
}

// serena's per-repo language-server prerequisites, recorded by detectSerena()
// in `extra`. Positive exclusions ONLY, so synthetic --repo-dir repos with
// lang "auto" pass every gate (harness invariant).
function serenaRepoGate(comp, lang) {
  const x = comp.serena.extra ?? {};
  if (lang === "typescript" && !(x.node && x.npm)) return "node/npm missing";
  if (lang === "python" && !x.uv) return "uv missing";
  if (lang === "go" && !x.gopls) return "gopls missing";
  if (lang === "rust" && !x.rustAnalyzer) return "rust-analyzer missing";
  return null;
}

let selfMcp; // memoized: does THIS build's CLI ship the `mcp` command? The
// parallel src/ workflow may rename things — probe, never assume (spec §2.4).
function selfMcpAvailable() {
  return selfMcp ??= /^\s*mcp\b/m.test(runCmd(process.execPath, [CLI_PATH, "--help"]).stdout);
}

// Availability + per-repo language gate for one MCP server; null = measurable.
function mcpGate(server, comp, ctx) {
  if (server === "codeindex") return selfMcpAvailable() ? null : "no mcp command in this build";
  const c = comp[server];
  if (!c.available) return c.reason ?? "not installed";
  const byLang = adapterOf(server, comp).perRepoSupport(ctx.repo.lang);
  if (byLang) return byLang; // falcon: "rust not supported" — the only one
  if (server === "serena") return serenaRepoGate(comp, ctx.repo.lang);
  return null;
}

// ONE mcp-probe child per (repo, server), memoized so mcp-sessions and
// mcp-tokens share the measurement instead of re-priming artifacts and
// re-spawning servers. The probe prints one JSON line and always exits 0;
// anything else degrades to {ok:false, reason} -> n/a cells, never a crash.
const probeCache = new Map(); // "slug:server" -> parsed probe JSON | {ok:false, reason}
const probeScratch = new Map(); // slug -> scratch source copy holding kept artifacts

function probeWorkDir(ctx, server) {
  if (server === "codeindex") return ctx.dir(); // writes nothing to disk
  // One scratch copy per repo, shared by serena/graphify/falcon: their artifact
  // dirs (.serena/, graphify-out/, .falcon/) are disjoint, and the shared clone
  // cache must never grow artifacts (harness invariant).
  let w = probeScratch.get(ctx.repo.slug);
  if (!w) { w = copySource(ctx.dir()); probeScratch.set(ctx.repo.slug, w); }
  return w;
}

function cleanupProbeScratch() {
  for (const w of probeScratch.values()) rmrf(w);
  probeScratch.clear();
}

function probeMcp(ctx, server, comp, cfg) {
  const key = `${ctx.repo.slug}:${server}`;
  let res = probeCache.get(key);
  if (!res) { res = runProbe(ctx, server, comp, cfg); probeCache.set(key, res); }
  return res;
}

function runProbe(ctx, server, comp, cfg) {
  const gate = mcpGate(server, comp, ctx);
  if (gate) return { ok: false, reason: gate };
  const sym = ctx.symbol();
  const file = ctx.probeFile();
  if (!sym) return { ok: false, reason: "no symbol extracted" };
  if (!file) return { ok: false, reason: "no code file" };
  const args = [
    PROBE_PATH, "--server", server, "--dir", probeWorkDir(ctx, server),
    "--symbol", sym, "--file", file,
    "--runs", String(cfg.runs), "--slow-runs", String(cfg.slowRuns), "--slow-threshold", String(cfg.slowThresholdMs),
  ];
  if (server === "codeindex") args.push("--engine", CLI_PATH);
  else args.push("--bin", comp[server].path);
  if (server === "graphify" && comp.graphify.extra?.mcpPath) args.push("--mcp-bin", comp.graphify.extra.mcpPath);
  const r = runCmd(process.execPath, args, { timeoutMs: MCP_OP_TIMEOUT_MS });
  if (!r.ok) return { ok: false, reason: r.code == null ? "probe killed (>600s)" : `probe exit ${r.code}` };
  let out;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { out = undefined; }
  if (!out) return { ok: false, reason: "unparseable probe output" };
  return out.ok ? out : { ok: false, reason: out.reason ?? "probe failed" };
}

// Reason for a null per-task value inside an otherwise-successful probe: a
// recorded per-task error wins (truncated for the table), else the structural
// explanation (tool absent / deliberately unmapped).
function taskNaReason(p, server, task) {
  const err = p.taskErrors?.[task];
  if (err) return err.length > 120 ? `${err.slice(0, 120)}…` : err;
  return server === "graphify" && task === "overview"
    ? "basename-keyed file nodes — n/a by design"
    : "tool not served";
}

// ---- per-repo context (memoized in-process artifacts) ------------------------

function makeCtx(repo) {
  let dir, arts;
  return {
    repo,
    dir() { return dir ??= repo.local ? repo.local : clonePinned(repo); },
    arts() { return arts ??= engine.buildIndexArtifacts(this.dir()); },
    scan() { return this.arts().scan; },
    symbol() { return pickSymbol(this.arts().symbols, repo.symbol); },
    // First indexed code file — the deterministic touch target for warm/incremental.
    codeFile() {
      const f = this.scan().files.find((x) => x.kind === "code" && x.symbols?.length) ?? this.scan().files.find((x) => x.kind === "code");
      return f?.rel;
    },
    // MCP probe file target: the def file of the representative symbol — the
    // same file for every server, and by construction in the repo's main
    // language (serena activates ONE language per project; falcon skips rust
    // files even on repos it otherwise indexes — the first-code-file pick
    // could land on a file outside both scopes and n/a the overview cell for
    // reasons that have nothing to do with the tool). Falls back to codeFile().
    probeFile() {
      try {
        const hit = engine.findSymbol(this.scan(), this.symbol())?.[0];
        if (hit?.file) return hit.file;
      } catch { /* fall through */ }
      return this.codeFile();
    },
  };
}

// A scratch copy of the repo with a primed 01x index (.codeindex/). Caller must
// rmrf(work) when done. Returns undefined if 01x is unavailable.
function prime01x(comp, dir) {
  if (!comp["01x"].available) return undefined;
  const work = copySource(dir);
  const r = runCmd(comp["01x"].path, ["init", "--yes"], { cwd: work });
  if (!r.ok) { rmrf(work); return undefined; }
  return work;
}

// ---- scenarios ---------------------------------------------------------------

function scenarioCold(ctxs, comp, cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    const dir = ctx.dir();
    log(`cold: ${ctx.repo.slug}`);
    // ours — full CLI spawn into a fresh out dir each run.
    let out, files = 0;
    const our = runMedian(cfg,
      () => runCmd(process.execPath, [CLI_PATH, "index", "--repo", dir, "--out", out]),
      { before: () => { out = mkdtempSync(tmpPath("cold-")); },
        after: (r) => { if (r.ok) { try { files = JSON.parse(readFileSync(join(out, "graph.json"), "utf8")).fileCount; } catch { /* keep 0 */ } } rmrf(out); } });
    if (!our.last.ok) throw new Error(`codeindex cold index failed on ${ctx.repo.slug}: ${our.last.stderr}`);

    // ctags -R into a scratch tags file.
    let ctagsCell = na(comp.ctags.reason);
    if (comp.ctags.available) {
      let tags;
      const r = runMedian(cfg,
        () => runCmd(comp.ctags.path, ["-R", "-f", tags, "."], { cwd: dir }),
        { before: () => { tags = tmpPath("tags"); }, after: () => rmrf(tags) });
      ctagsCell = r.last.ok ? msCell(r) : na(`ctags exit ${r.last.code}`);
    }

    // scip-typescript — needs a TS repo with a tsconfig + node_modules; the
    // npm install is timed separately and shown inline. Runs in a scratch copy
    // so the shared clone cache is never polluted with node_modules.
    let scipCell = na(comp["scip-typescript"].reason);
    if (comp["scip-typescript"].available) {
      if (ctx.repo.lang !== "typescript" || !existsSync(join(dir, "tsconfig.json"))) {
        scipCell = na("no tsconfig");
      } else {
        const work = copySource(dir);
        const inst = runCmd("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, timeoutMs: 600_000 });
        if (!inst.ok) { scipCell = na("npm install failed"); }
        else {
          let idx;
          const r = runMedian({ ...cfg, runs: Math.min(cfg.runs, cfg.slowRuns) },
            () => runCmd(comp["scip-typescript"].path, ["index", "--output", idx], { cwd: work }),
            { before: () => { idx = tmpPath("scip.scip"); }, after: () => rmrf(idx) });
          // Text cell, so surface the effective run count ourselves (ms cells get
          // this from render); scip is forced to slowRuns, which may be < nominal.
          const runsAnn = r.runs !== cfg.runs ? ` (${r.runs}×)` : "";
          scipCell = r.last.ok
            ? { v: `${Math.round(r.ms)}${runsAnn} (+${Math.round(inst.ms)} install)`, k: "text" }
            : na("scip index failed");
        }
        rmrf(work);
      }
    }

    // 01x init — runs in a scratch copy, its .codeindex cleaned before each run
    // so every measured init is genuinely cold.
    let oxCell = na(comp["01x"].reason);
    if (comp["01x"].available) {
      const work = copySource(dir);
      const r = runMedian(cfg,
        () => runCmd(comp["01x"].path, ["init", "--yes"], { cwd: work }),
        { before: () => { rmrf(join(work, ".codeindex")); rmrf(join(work, ".codeindex.yaml")); } });
      oxCell = r.last.ok ? msCell(r) : na(`init exit ${r.last.code}`);
      rmrf(work);
    }

    // serena / graphify / falcon cold artifact builds — appended at the END
    // (site stat tiles read the earlier cells by frozen index). Each runs in
    // its own scratch copy with artifacts cleaned before every measured run,
    // so every build is genuinely cold; 600s ceiling inside adapter.prime.
    const mcpColdCells = ["serena", "graphify", "falcon"].map((server) => {
      const c = comp[server];
      if (!c.available) return na(c.reason);
      const adapter = adapterOf(server, comp);
      const gate = adapter.perRepoSupport(ctx.repo.lang) ?? (server === "serena" ? serenaRepoGate(comp, ctx.repo.lang) : null);
      if (gate) return na(gate);
      const work = copySource(dir);
      try {
        const r = runMedian(cfg, () => adapter.prime(work), { before: () => adapter.cleanCold(work) });
        return r.last.ok ? msCell(r) : na(r.last.reason ?? "build failed");
      } finally { rmrf(work); }
    });

    rows.push([{ v: ctx.repo.slug, k: "text" }, { v: files, k: "int" }, msCell(our), ctagsCell, scipCell, oxCell, ...mcpColdCells]);
  }
  return {
    id: "cold", title: "Cold index",
    note: "Full process spawn per run into a fresh output dir. scip-typescript excludes its npm install (timed separately, shown inline). 01x `init` shells out to ast-grep per file and is cleaned between runs. serena `project index` builds its document-symbol cache (its one-time per-language language-server download is absorbed by the untimed warmup, never a measured run); `graphify update` parses the repo into graph.json (keyless, clustering computed locally); `falcon index` writes its parquet artifact set. All three are cleaned between runs and are the load-side counterpart of the near-instant `activate->ready` cells in the MCP sessions table.",
    headers: ["Repo", "Files", "codeindex (ms)", "ctags -R (ms)", "scip-typescript (ms)", "01x init (ms)", "serena project index (ms)", "graphify update (ms)", "falcon index (ms)"],
    rows,
  };
}

function scenarioWarm(ctxs, comp, cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    log(`warm: ${ctx.repo.slug}`);
    const work = copySource(ctx.dir());
    const rel = ctx.codeFile();
    try {
      // ours warm rerun — cache.json primed once, then re-index.
      const out = mkdtempSync(tmpPath("warm-"));
      runCmd(process.execPath, [CLI_PATH, "index", "--repo", work, "--out", out]);
      const warm = runMedian(cfg, () => runCmd(process.execPath, [CLI_PATH, "index", "--repo", work, "--out", out]));
      if (!warm.last.ok) throw new Error(`codeindex warm rerun failed on ${ctx.repo.slug}: ${warm.last.stderr}`);

      // ours +1 touched file — append a comment, re-index, restore.
      let touchCell = na("no code file");
      if (rel) {
        const target = join(work, rel);
        const original = readFileSync(target);
        // Unique payload per iteration so the content hash changes every run and
        // the real incremental re-parse path is timed — not the hash short-circuit
        // an identical append would hit after warmup.
        let ti = 0;
        const touch = runMedian(cfg, () => runCmd(process.execPath, [CLI_PATH, "index", "--repo", work, "--out", out]),
          { before: () => writeFileSync(target, Buffer.concat([original, Buffer.from(`\n// codeindex-bench-touch ${ti++}\n`)])), after: () => writeFileSync(target, original) });
        writeFileSync(target, original);
        touchCell = touch.last.ok ? msCell(touch) : na("rerun failed");
      }
      rmrf(out);

      // 01x single-file reindex.
      let oxCell = na(comp["01x"].reason);
      if (comp["01x"].available && rel) {
        const oxWork = prime01x(comp, ctx.dir());
        if (!oxWork) oxCell = na("init failed");
        else {
          const target = join(oxWork, rel);
          const original = readFileSync(target);
          let oi = 0; // unique payload per iteration (see the codeindex touch above)
          const r = runMedian(cfg, () => runCmd(comp["01x"].path, ["reindex", rel], { cwd: oxWork }),
            { before: () => writeFileSync(target, Buffer.concat([original, Buffer.from(`\n// codeindex-bench-touch ${oi++}\n`)])), after: () => writeFileSync(target, original) });
          oxCell = r.last.ok ? msCell(r) : na(`reindex exit ${r.last.code}`);
          rmrf(oxWork);
        }
      } else if (!rel) {
        oxCell = na("no code file");
      }

      rows.push([{ v: ctx.repo.slug, k: "text" }, msCell(warm), touchCell, oxCell]);
    } finally {
      rmrf(work);
    }
  }
  return {
    id: "warm", title: "Warm / incremental",
    note: "Re-index with a warm cache present, then with exactly one file touched (comment appended, restored after). 01x re-indexes the single touched file. Deliberately no serena/graphify/falcon column: none of them exposes a comparable user-visible single-file reindex command (serena re-indexes lazily inside a live LSP session; graphify and falcon rebuild via the cold commands timed above).",
    headers: ["Repo", "codeindex warm rerun (ms)", "codeindex +1 file (ms)", "01x reindex file (ms)"],
    rows,
  };
}

function scenarioQueries(ctxs, comp, cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    log(`queries: ${ctx.repo.slug}`);
    const dir = ctx.dir();
    const scan = ctx.scan();
    const sym = ctx.symbol();
    const pairs = engine.computeImportPairs(scan);

    const findInproc = runMedian(cfg, () => engine.findSymbol(scan, sym));
    const findSpawn = runMedian(cfg, () => runCmd(process.execPath, [CLI_PATH, "symbols", "--repo", dir]));
    const refsInproc = runMedian(cfg, () => engine.findReferences(scan, sym));
    const callersInproc = runMedian(cfg, () => engine.buildCallerIndex(scan, pairs));

    // 01x find-symbol against a primed index.
    let oxCell = na(comp["01x"].reason);
    if (comp["01x"].available) {
      const work = prime01x(comp, dir);
      if (!work) oxCell = na("init failed");
      else {
        const r = runMedian(cfg, () => runCmd(comp["01x"].path, ["query", "find-symbol", sym], { cwd: work }));
        oxCell = r.last.ok ? msCell(r) : na(`query exit ${r.last.code}`);
        rmrf(work);
      }
    }

    // ctags lookup — build a tags file once, then time a symbol lookup in it.
    let ctagsCell = na(comp.ctags.reason);
    if (comp.ctags.available) {
      const tags = tmpPath("qtags");
      const built = runCmd(comp.ctags.path, ["-R", "-f", tags, "."], { cwd: dir });
      if (!built.ok) ctagsCell = na("ctags build failed");
      else {
        const needle = `${sym}\t`;
        const r = runMedian(cfg, () => readFileSync(tags, "utf8").split("\n").filter((l) => l.startsWith(needle)).length);
        ctagsCell = msCell(r);
      }
      rmrf(tags);
    }

    rows.push([
      { v: ctx.repo.slug, k: "text" }, { v: sym, k: "text" },
      msCell(findInproc), msCell(findSpawn), msCell(refsInproc), msCell(callersInproc), oxCell, ctagsCell,
    ]);
  }
  return {
    id: "queries", title: "Queries (find-symbol / references / callers)",
    note: "`find-symbol in-proc` / `references in-proc`: a single API call on an already-loaded warm scan (call timed alone). `caller-index in-proc`: builds the whole-scan caller index (not just callers-of-symbol). `full-index spawn`: a full `codeindex symbols` CLI process — Node startup PLUS a cold buildIndexArtifacts and serialization of the entire symbol table, i.e. NOT a single-symbol lookup. `01x find-symbol`: one query against its primed SQLite DB. `ctags lookup`: scans the tags file for the symbol.",
    headers: ["Repo", "Symbol", "find-symbol in-proc (ms)", "full-index spawn (ms)", "references in-proc (ms)", "caller-index in-proc (ms)", "01x find-symbol (ms)", "ctags lookup (ms)"],
    rows,
  };
}

// Repo × server MCP timings, one memoized probe child per (repo, server); the
// probe primes untimed, then measures whole sessions (spawn included) and
// per-call medians on a live session. mcp-tokens reuses the same probe results.
function scenarioMcpSessions(ctxs, comp, cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    for (const server of MCP_SERVERS) {
      log(`mcp-sessions: ${ctx.repo.slug} × ${server}`);
      const p = probeMcp(ctx, server, comp, cfg);
      const head = [{ v: ctx.repo.slug, k: "text" }, { v: server, k: "text" }, { v: ctx.symbol() || "-", k: "text" }];
      if (!p.ok) {
        rows.push([...head, na(p.reason), na(p.reason), na(p.reason), na(p.reason)]);
        continue;
      }
      const q = p.queries;
      const qCell = (v, task) => (v == null
        ? na(taskNaReason(p, server, task))
        : { v, k: "ms", ...(q.runs ? { runs: q.runs } : {}) });
      rows.push([
        ...head,
        { v: p.activation.ms, k: "ms", runs: p.activation.runs },
        qCell(q.findMs, "find"), qCell(q.refsMs, "refs"), qCell(q.overviewMs, "overview"),
      ]);
    }
  }
  return {
    id: "mcp-sessions", title: "MCP sessions (activate + per-call queries)",
    note: "All four servers speak the same stdio JSON-RPC transport to the same client, on primed artifacts. `activate->ready` times a WHOLE session — process spawn, initialize handshake, tools/list, first find-symbol answer — and its semantics differ per server, read it accordingly: serena starts a language server and lazily indexes against a cold `.serena` cache (LS binaries already on disk); graphify and falcon merely load prebuilt artifacts, their parse cost lives in the Cold index column; codeindex's MCP server re-scans the repo per call by design (nothing to preload). The three task cells are per-call medians on a live session after activation; file-overview targets the file DEFINING the representative symbol (the same file for every server, in the repo's main language by construction). falcon's references cell times the SAME `falcon_symbol_lookup` call as find-symbol — v0.6.4 has no separate references tool, its lookup response embeds callers/references.",
    headers: ["Repo", "Server", "Symbol", "activate->ready (ms)", "find-symbol (ms)", "references (ms)", "file-overview (ms)"],
    rows,
  };
}

function scenarioTokens(ctxs, _comp, _cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    log(`tokens: ${ctx.repo.slug}`);
    const scan = ctx.scan();
    const sym = ctx.symbol();
    // Uncapped: grepRepo defaults to DEFAULT_MAX_HITS=200; the 200-cap would both
    // truncate the measured bytes and feed a bogus line count into 01x's formula.
    const hits = engine.grepRepo(ctx.dir(), sym, { maxHits: Number.MAX_SAFE_INTEGER });
    const grepText = hits.map((h) => `${h.file}:${h.line}:${h.text}`).join("\n");
    const grepBytes = byteLen(grepText);
    const indexBytes = byteLen(JSON.stringify(engine.findSymbol(scan, sym)));
    const f = formula01x(sym, hits.length);
    const m = measuredTokens(grepBytes, indexBytes);
    rows.push([
      { v: ctx.repo.slug, k: "text" }, { v: sym, k: "text" }, { v: hits.length, k: "int" },
      { v: f.ratio, k: "ratio" },
      { v: Math.round(m.grepTokens), k: "int" }, { v: Math.round(m.indexTokens), k: "int" }, { v: m.ratio, k: "ratio" },
    ]);
  }
  return {
    id: "tokens", title: "Token economy (single-symbol lookup)",
    note: "Two methods side by side: 01x's published formula (grep_lines×30 vs len×5+200) and an honest bytes/4 measurement of a raw grep vs our structured JSON. Ratio > 1 means the index returns less context to the model.",
    headers: ["Repo", "Symbol", "grep lines", "01x formula ratio", "grep tokens (measured)", "index tokens (measured)", "measured ratio"],
    rows,
  };
}

// Token economy of the three MCP tasks: response text of each tool call,
// tokens ~= bytes/4 — the same convention as measuredTokens/byteLen in
// tokens.mjs, applied to the probe's Buffer.byteLength byte counts. Reuses the
// memoized probe results of mcp-sessions (one probe per repo × server).
function scenarioMcpTokens(ctxs, comp, cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    for (const server of MCP_SERVERS) {
      log(`mcp-tokens: ${ctx.repo.slug} × ${server}`);
      const p = probeMcp(ctx, server, comp, cfg);
      const head = [{ v: ctx.repo.slug, k: "text" }, { v: server, k: "text" }];
      if (!p.ok) {
        rows.push([...head, na(p.reason), na(p.reason), na(p.reason)]);
        continue;
      }
      const tok = (bytes, task) => (bytes == null
        ? na(taskNaReason(p, server, task))
        : { v: Math.round(bytes / 4), k: "int" });
      rows.push([...head, tok(p.bytes.find, "find"), tok(p.bytes.refs, "refs"), tok(p.bytes.overview, "overview")]);
    }
  }
  return {
    id: "mcp-tokens", title: "MCP token economy (per-call response size)",
    note: "Context cost of each MCP answer: tokens ~= bytes/4 of the tool-call response text (same convention as the Token economy table). The codeindex rows are the baseline the other servers compare against. falcon's references figure reuses the find-symbol response (same call, see MCP sessions); graphify's file-overview has no equivalent tool. Bigger is not automatically worse: serena's LSP answers carry semantically precise, type-aware references the static tools do not claim — this table measures context cost only, not answer quality.",
    headers: ["Repo", "Server", "find-symbol tokens", "references tokens", "file-overview tokens"],
    rows,
  };
}

// metadata.json is compared separately from falcon's parquet set: it embeds
// two absolute paths (artifacts.path, repo.root) that legitimately differ
// between out dirs. After dropping them, any remaining difference (timestamp-
// like fields included) is named in the section note, never hidden.
function falconMetadataDiff(a, b) {
  if (!a || !b) return "metadata.json missing";
  let ma, mb;
  try { ma = JSON.parse(a.toString("utf8")); mb = JSON.parse(b.toString("utf8")); } catch { return "metadata.json unparseable"; }
  for (const m of [ma, mb]) { if (m?.artifacts) delete m.artifacts.path; if (m?.repo) delete m.repo.root; }
  if (JSON.stringify(ma) === JSON.stringify(mb)) return null;
  const keys = [...new Set([...Object.keys(ma ?? {}), ...Object.keys(mb ?? {})])]
    .filter((k) => JSON.stringify(ma?.[k]) !== JSON.stringify(mb?.[k])).sort();
  return `differing fields: ${keys.join(", ")}`;
}

function scenarioDeterminism(ctxs, comp, _cfg) {
  const rows = [];
  const falconMetaNotes = [];
  for (const ctx of ctxs) {
    log(`determinism: ${ctx.repo.slug}`);
    const dir = ctx.dir();
    const a = engine.buildIndexArtifacts(dir);
    const b = engine.buildIndexArtifacts(dir);
    const same = engine.renderGraphJson(a.graph) === engine.renderGraphJson(b.graph)
      && engine.renderSymbolsJson(a.symbols) === engine.renderSymbolsJson(b.symbols);
    const oxCell = comp["01x"].available ? na("SQLite") : na(comp["01x"].reason);

    // serena — symbols live in an LSP session; nothing on disk is claimed
    // byte-stable, so there is no artifact to compare.
    const serenaCell = comp.serena.available ? na("live LSP session — no artifact") : na(comp.serena.reason);

    // graphify — two cold `update` runs from the same .git-free scratch dir
    // (so graph.json omits built_at_commit); graph.json bytes ONLY, the
    // report/HTML artifacts embed dates and are excluded.
    let graphifyCell = na(comp.graphify.reason);
    if (comp.graphify.available) {
      const adapter = adapterOf("graphify", comp);
      const work = copySource(dir);
      try {
        const g = join(work, "graphify-out", "graph.json");
        const b1 = adapter.prime(work).ok && existsSync(g) ? readFileSync(g) : undefined;
        adapter.cleanCold(work);
        const b2 = adapter.prime(work).ok && existsSync(g) ? readFileSync(g) : undefined;
        graphifyCell = b1 && b2 ? { v: b1.equals(b2), k: "bool" } : na("update failed");
      } finally { rmrf(work); }
    }

    // falcon — two cold `index` runs; the parquet artifact set byte-compared
    // (the cell), metadata.json separately (the note).
    let falconCell = na(comp.falcon.reason);
    if (comp.falcon.available) {
      const adapter = adapterOf("falcon", comp);
      const gate = adapter.perRepoSupport(ctx.repo.lang);
      if (gate) falconCell = na(gate);
      else {
        const work = copySource(dir);
        try {
          const art = join(work, ".falcon", "artifacts");
          // Regular files only: v0.6.4's artifact set is flat (verified), but a
          // future subdir must degrade the comparison, never crash the harness.
          const snap = () => Object.fromEntries(readdirSync(art, { withFileTypes: true })
            .filter((e) => e.isFile()).map((e) => [e.name, readFileSync(join(art, e.name))]));
          const s1 = adapter.prime(work).ok && existsSync(art) ? snap() : undefined;
          adapter.cleanCold(work);
          const s2 = adapter.prime(work).ok && existsSync(art) ? snap() : undefined;
          if (!s1 || !s2) falconCell = na("index failed");
          else {
            const names = [...new Set([...Object.keys(s1), ...Object.keys(s2)])].filter((n) => n !== "metadata.json").sort();
            falconCell = { v: names.every((n) => s1[n] && s2[n] && s1[n].equals(s2[n])), k: "bool" };
            const d = falconMetadataDiff(s1["metadata.json"], s2["metadata.json"]);
            if (d) falconMetaNotes.push(`${ctx.repo.slug} — ${d}`);
          }
        } finally { rmrf(work); }
      }
    }

    rows.push([{ v: ctx.repo.slug, k: "text" }, { v: same, k: "bool" }, oxCell, serenaCell, graphifyCell, falconCell]);
  }
  const falconMetaNote = falconMetaNotes.length
    ? `falcon's metadata.json, compared separately after dropping its embedded absolute paths (artifacts.path, repo.root), DID differ — ${falconMetaNotes.join("; ")} (timestamp-like fields are named per repo, not folded into the cell).`
    : "falcon's metadata.json is compared separately after dropping its embedded absolute paths (artifacts.path, repo.root); no field differed — falcon carries no timestamps (it reports determinism.timestamps: \"omitted\").";
  return {
    id: "determinism", title: "Determinism (byte-identical rebuild)",
    note: "Two cold builds byte-compared (graph.json + symbols.json). 01x keeps a SQLite DB (embedded ids/timestamps) that is not byte-comparable, so determinism is not claimed for it here. graphify: two cold `graphify update` runs, `graph.json` bytes only (its HTML/report artifacts embed dates and are excluded). falcon: two cold `falcon index` runs, all parquet artifacts byte-compared for the cell. " + falconMetaNote,
    headers: ["Repo", "codeindex (byte-identical)", "01x", "serena", "graphify graph.json", "falcon artifacts"],
    rows,
  };
}

function scenarioSize(ctxs, comp, _cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    log(`size: ${ctx.repo.slug}`);
    const dir = ctx.dir();
    // ours — graph.json + symbols.json + cache.json.
    const out = mkdtempSync(tmpPath("size-"));
    const built = runCmd(process.execPath, [CLI_PATH, "index", "--repo", dir, "--out", out]);
    if (!built.ok) { rmrf(out); throw new Error(`codeindex index failed on ${ctx.repo.slug}: ${built.stderr}`); }
    let ourBytes = 0;
    for (const f of ["graph.json", "symbols.json", "cache.json"]) { try { ourBytes += statSync(join(out, f)).size; } catch { /* optional */ } }
    rmrf(out);

    // 01x .codeindex dir.
    let oxCell = na(comp["01x"].reason);
    if (comp["01x"].available) {
      const work = prime01x(comp, dir);
      if (!work) oxCell = na("init failed");
      else { oxCell = { v: dirBytes(join(work, ".codeindex")), k: "bytes" }; rmrf(work); }
    }

    // ctags tags file.
    let ctagsCell = na(comp.ctags.reason);
    if (comp.ctags.available) {
      const tags = tmpPath("stags");
      const r = runCmd(comp.ctags.path, ["-R", "-f", tags, "."], { cwd: dir });
      ctagsCell = r.ok ? { v: statSync(tags).size, k: "bytes" } : na("ctags build failed");
      rmrf(tags);
    }

    // serena / graphify / falcon artifacts — one shared scratch copy (their
    // artifact dirs are disjoint), primed per tool, measured, then discarded.
    // Prime ORDER is load-bearing: falcon indexes every non-dot dir in the
    // work tree, so it must run FIRST (before graphify-out exists — measured
    // +5.5% falcon artifact bytes on the fixture otherwise); graphify ignores
    // dot-dirs (.falcon, verified: zero falcon-path nodes in graph.json);
    // serena's .serena cache covers only its main-language source files, which
    // neither .falcon (parquet) nor graphify-out (json/html/md) contains.
    let serenaCell = na(comp.serena.reason);
    let graphifyCell = na(comp.graphify.reason);
    let falconCell = na(comp.falcon.reason);
    if (comp.serena.available || comp.graphify.available || comp.falcon.available) {
      const work = copySource(dir);
      try {
        if (comp.falcon.available) {
          const adapter = adapterOf("falcon", comp);
          const gate = adapter.perRepoSupport(ctx.repo.lang);
          if (gate) falconCell = na(gate);
          else {
            const p = adapter.prime(work);
            const a = join(work, ".falcon", "artifacts");
            falconCell = p.ok && existsSync(a) ? { v: dirBytes(a), k: "bytes" } : na(p.reason ?? "index failed");
          }
        }
        if (comp.graphify.available) {
          const p = adapterOf("graphify", comp).prime(work);
          const g = join(work, "graphify-out", "graph.json");
          graphifyCell = p.ok && existsSync(g) ? { v: statSync(g).size, k: "bytes" } : na(p.reason ?? "update failed");
        }
        if (comp.serena.available) {
          const gate = serenaRepoGate(comp, ctx.repo.lang);
          if (gate) serenaCell = na(gate);
          else {
            const p = adapterOf("serena", comp).prime(work);
            const d = join(work, ".serena");
            serenaCell = p.ok && existsSync(d) ? { v: dirBytes(d), k: "bytes" } : na(p.reason ?? "index failed");
          }
        }
      } finally { rmrf(work); }
    }

    rows.push([{ v: ctx.repo.slug, k: "text" }, { v: ourBytes, k: "bytes" }, oxCell, ctagsCell, serenaCell, graphifyCell, falconCell]);
  }
  return {
    id: "size", title: "Index size on disk",
    note: "Our artifacts (graph.json + symbols.json + cache.json) vs 01x's `.codeindex/` SQLite DB vs the ctags `tags` file vs serena's `.serena/` project cache (document-symbol pickles) vs graphify's MCP-servable `graph.json` alone (its `graphify-out/` also holds an AST cache and report files that never leave the build machine) vs falcon's `.falcon/artifacts` parquet set.",
    headers: ["Repo", "codeindex artifacts", "01x .codeindex", "ctags tags", "serena .serena", "graphify graph.json", "falcon .falcon/artifacts"],
    rows,
  };
}

// Resolve one uv-managed tool's install dir: `uv tool dir` when uv is
// reachable, else the documented default location. Undefined when absent.
function uvToolDir(name) {
  const r = runCmd("uv", ["tool", "dir"]);
  const base = r.ok && r.stdout.trim() ? r.stdout.trim() : join(homedir(), ".local", "share", "uv", "tools");
  const d = join(base, name);
  return existsSync(d) ? d : undefined;
}

// Not per-repo: measured install footprint of each tool.
function scenarioInstall(_ctxs, comp, _cfg) {
  const rows = [];
  // ours — npm pack --dry-run, zero runtime deps. We report `unpackedSize` (the
  // installed-on-disk footprint), NOT the compressed tarball `size` — it is the
  // apples-to-apples comparison against the competitor binaries' on-disk sizes.
  let ourCell = na("npm pack failed");
  const pack = runCmd("npm", ["pack", "--dry-run", "--json"], { cwd: REPO_ROOT });
  if (pack.ok) {
    try { ourCell = { v: JSON.parse(pack.stdout)[0].unpackedSize, k: "bytes" }; } catch { /* keep na */ }
  }
  rows.push([{ v: "codeindex", k: "text" }, ourCell, { v: "zero runtime dependencies; single engine.mjs", k: "text" }]);

  // 01x binary + required ast-grep. The binary is measured when it IS the 01x
  // binary — available, or unavailable only because ast-grep is missing. A
  // recorded path with any other reason (e.g. the PATH name collision with our
  // own `codeindex` bin) is NOT 01x and must never be stat'd as its footprint.
  let oxCell = na(comp["01x"].reason ?? "not installed");
  let oxNote = "requires ast-grep in PATH";
  const oxIs01x = comp["01x"].available || comp["01x"].reason === "ast-grep missing";
  if (oxIs01x && comp["01x"].path && existsSync(comp["01x"].path)) {
    oxCell = { v: statSync(comp["01x"].path).size, k: "bytes" };
    if (comp.astGrep.available) oxNote = `binary only; + ast-grep ${(statSync(comp.astGrep.path).size / 1024 / 1024).toFixed(1)} MB required`;
  }
  rows.push([{ v: "01x", k: "text" }, oxCell, { v: oxNote, k: "text" }]);

  // scip-typescript — binary present, but needs the target repo's node_modules.
  const scipCell = comp["scip-typescript"].available
    ? { v: "binary + target-repo node_modules", k: "text" }
    : na(comp["scip-typescript"].reason);
  rows.push([{ v: "scip-typescript", k: "text" }, scipCell, { v: "requires a full npm install of each indexed repo (see cold column)", k: "text" }]);

  // serena — uv tool venv (serena-agent); its language servers live OUTSIDE
  // the venv in ~/.serena/language_servers and are measured when present.
  {
    let cell = na(comp.serena.reason ?? "not installed");
    let note = "uv tool venv; language servers download per language into ~/.serena/language_servers on first use; requires node/npm (TS), gopls (Go), rust-analyzer (Rust)";
    if (comp.serena.available) {
      const d = uvToolDir("serena-agent");
      cell = d ? { v: dirBytes(d), k: "bytes" } : na("uv tool dir not found");
      const ls = join(homedir(), ".serena", "language_servers");
      if (existsSync(ls)) {
        note = `uv tool venv; + ${(dirBytes(ls) / 1024 / 1024).toFixed(1)} MB language servers in ~/.serena/language_servers (measured); requires node/npm (TS), gopls (Go), rust-analyzer (Rust)`;
      }
    }
    rows.push([{ v: "serena", k: "text" }, cell, { v: note, k: "text" }]);
  }

  // graphify — uv tool venv (PyPI package graphifyy) including the [mcp] extra.
  {
    let cell = na(comp.graphify.reason ?? "not installed");
    if (comp.graphify.available) {
      const d = uvToolDir("graphifyy");
      cell = d ? { v: dirBytes(d), k: "bytes" } : na("uv tool dir not found");
    }
    rows.push([{ v: "graphify", k: "text" }, cell, { v: "uv tool venv (graphifyy); tree-sitter grammar wheels bundled; [mcp] extra required for the MCP server", k: "text" }]);
  }

  // falcon — one static Go binary (statSync follows the brew symlink).
  {
    const cell = comp.falcon.available && existsSync(comp.falcon.path)
      ? { v: statSync(comp.falcon.path).size, k: "bytes" }
      : na(comp.falcon.reason ?? "not installed");
    rows.push([{ v: "falcon", k: "text" }, cell, { v: "single static Go binary, no runtime deps (brew tap SocialGouv/repo-falcon)", k: "text" }]);
  }

  return {
    id: "install", title: "Install footprint",
    note: "Measured, not declared. Our tarball is the unpacked size from `npm pack --dry-run`.",
    headers: ["Tool", "Install footprint", "Notes"],
    rows,
  };
}

const SCENARIOS = {
  cold: scenarioCold,
  warm: scenarioWarm,
  queries: scenarioQueries,
  "mcp-sessions": scenarioMcpSessions,
  tokens: scenarioTokens,
  "mcp-tokens": scenarioMcpTokens,
  determinism: scenarioDeterminism,
  size: scenarioSize,
  install: scenarioInstall,
};
const SCENARIO_ORDER = ["cold", "warm", "queries", "mcp-sessions", "tokens", "mcp-tokens", "determinism", "size", "install"];

// ---- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const a = { repo: "all", runs: 5, scenario: "all", write: false, repoDir: undefined, noCompetitors: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--repo") a.repo = argv[++i];
    else if (f === "--runs") a.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (f === "--scenario") a.scenario = argv[++i];
    else if (f === "--write") a.write = true;
    else if (f === "--repo-dir") a.repoDir = argv[++i];
    else if (f === "--no-competitors") a.noCompetitors = true;
    else throw new Error(`unknown flag: ${f}`);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sessionDate = new Date().toISOString(); // ONE session date, threaded through render
  const cfg = { runs: args.runs, slowRuns: 3, slowThresholdMs: 60_000 };

  const comp = args.noCompetitors ? noCompetitors() : detectCompetitors();
  for (const c of Object.values(comp)) log(`${c.name}: ${c.available ? `available ${c.version ?? ""} (${c.path})` : `n/a — ${c.reason}`}`);

  // --repo-dir is resolved to an absolute path: MCP servers receive it as a
  // tool argument and resolve relative paths against THEIR cwd, which would
  // silently query the wrong (empty) directory.
  const repos = args.repoDir
    ? [{ slug: basename(args.repoDir), sha: "local", lang: "auto", symbol: undefined, local: resolve(args.repoDir) }]
    : reposFor(args.repo);
  // Deterministic row order: repos sorted by slug (render's structural contract).
  const ctxs = repos.map(makeCtx).sort((a, b) => (a.repo.slug < b.repo.slug ? -1 : a.repo.slug > b.repo.slug ? 1 : 0));

  const ids = args.scenario === "all" ? SCENARIO_ORDER : args.scenario.split(",").map((s) => s.trim());
  for (const id of ids) if (!SCENARIOS[id]) throw new Error(`unknown scenario: ${id} (have ${SCENARIO_ORDER.join(", ")}, or 'all')`);

  const sections = [];
  try {
    for (const id of ids) sections.push(SCENARIOS[id](ctxs, comp, cfg));
  } finally {
    cleanupProbeScratch(); // per-repo scratch copies kept alive across mcp-sessions/mcp-tokens
  }

  const report = { nominalRuns: cfg.runs, sections };
  const env = {
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    ram: `${(totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
    date: sessionDate,
  };

  const md = renderMarkdown(report, env);
  if (args.write) {
    writeFileSync(join(REPO_ROOT, "BENCHMARKS.md"), md);
    const siteDir = join(REPO_ROOT, "site");
    if (!existsSync(siteDir)) mkdirSync(siteDir, { recursive: true });
    writeFileSync(join(siteDir, "benchmarks.json"), `${JSON.stringify(renderJson(report, env), null, 2)}\n`);
    log(`wrote BENCHMARKS.md + site/benchmarks.json`);
  } else {
    process.stdout.write(md);
  }
}

main().catch((e) => {
  // Non-zero ONLY on a genuine internal failure; absent competitors are n/a, not errors.
  console.error(`bench: ${e instanceof Error ? e.stack ?? e.message : e}`);
  process.exit(2);
});
