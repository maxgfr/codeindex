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
import { cpus, tmpdir, totalmem } from "node:os";
import { basename, join, sep } from "node:path";
import { REPO_ROOT, CLI_PATH, ENGINE_URL, reposFor, clonePinned, pickSymbol } from "./repos.mjs";
import { detectCompetitors, noCompetitors, runCmd } from "./competitors.mjs";
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
          scipCell = r.last.ok
            ? { v: `${Math.round(r.ms)} (+${Math.round(inst.ms)} install)`, k: "text" }
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

    rows.push([{ v: ctx.repo.slug, k: "text" }, { v: files, k: "int" }, msCell(our), ctagsCell, scipCell, oxCell]);
  }
  return {
    id: "cold", title: "Cold index",
    note: "Full process spawn per run into a fresh output dir. scip-typescript excludes its npm install (timed separately, shown inline). 01x `init` shells out to ast-grep per file and is cleaned between runs.",
    headers: ["Repo", "Files", "codeindex (ms)", "ctags -R (ms)", "scip-typescript (ms)", "01x init (ms)"],
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
        const touch = runMedian(cfg, () => runCmd(process.execPath, [CLI_PATH, "index", "--repo", work, "--out", out]),
          { before: () => writeFileSync(target, Buffer.concat([original, Buffer.from("\n// codeindex-bench-touch\n")])), after: () => writeFileSync(target, original) });
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
          const r = runMedian(cfg, () => runCmd(comp["01x"].path, ["reindex", rel], { cwd: oxWork }),
            { before: () => writeFileSync(target, Buffer.concat([original, Buffer.from("\n// codeindex-bench-touch\n")])), after: () => writeFileSync(target, original) });
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
    note: "Re-index with a warm cache present, then with exactly one file touched (comment appended, restored after). 01x re-indexes the single touched file.",
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
    note: "in-proc = warm scan already loaded, API call timed alone; spawn = full `codeindex` CLI process. The spawn/in-proc gap is Node startup, not algorithm cost. ctags lookup scans its tags file for the symbol.",
    headers: ["Repo", "Symbol", "find-symbol in-proc (ms)", "find-symbol spawn (ms)", "references in-proc (ms)", "callers in-proc (ms)", "01x find-symbol (ms)", "ctags lookup (ms)"],
    rows,
  };
}

function scenarioTokens(ctxs, _comp, _cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    log(`tokens: ${ctx.repo.slug}`);
    const scan = ctx.scan();
    const sym = ctx.symbol();
    const hits = engine.grepRepo(ctx.dir(), sym);
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

function scenarioDeterminism(ctxs, comp, _cfg) {
  const rows = [];
  for (const ctx of ctxs) {
    log(`determinism: ${ctx.repo.slug}`);
    const dir = ctx.dir();
    const a = engine.buildIndexArtifacts(dir);
    const b = engine.buildIndexArtifacts(dir);
    const same = engine.renderGraphJson(a.graph) === engine.renderGraphJson(b.graph)
      && engine.renderSymbolsJson(a.symbols) === engine.renderSymbolsJson(b.symbols);
    const oxCell = comp["01x"].available ? na("SQLite") : na(comp["01x"].reason);
    rows.push([{ v: ctx.repo.slug, k: "text" }, { v: same, k: "bool" }, oxCell]);
  }
  return {
    id: "determinism", title: "Determinism (byte-identical rebuild)",
    note: "Two cold builds byte-compared (graph.json + symbols.json). 01x keeps a SQLite DB (embedded ids/timestamps) that is not byte-comparable, so determinism is not claimed for it here.",
    headers: ["Repo", "codeindex (byte-identical)", "01x"],
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

    rows.push([{ v: ctx.repo.slug, k: "text" }, { v: ourBytes, k: "bytes" }, oxCell, ctagsCell]);
  }
  return {
    id: "size", title: "Index size on disk",
    note: "Our artifacts (graph.json + symbols.json + cache.json) vs 01x's `.codeindex/` SQLite DB vs the ctags `tags` file.",
    headers: ["Repo", "codeindex artifacts", "01x .codeindex", "ctags tags"],
    rows,
  };
}

// Not per-repo: measured install footprint of each tool.
function scenarioInstall(_ctxs, comp, _cfg) {
  const rows = [];
  // ours — npm pack --dry-run, zero runtime deps.
  let ourCell = na("npm pack failed");
  const pack = runCmd("npm", ["pack", "--dry-run", "--json"], { cwd: REPO_ROOT });
  if (pack.ok) {
    try { ourCell = { v: JSON.parse(pack.stdout)[0].unpackedSize, k: "bytes" }; } catch { /* keep na */ }
  }
  rows.push([{ v: "codeindex", k: "text" }, ourCell, { v: "zero runtime dependencies; single engine.mjs", k: "text" }]);

  // 01x binary + required ast-grep.
  let oxCell = na(comp["01x"].reason ?? "not installed");
  let oxNote = "requires ast-grep in PATH";
  if (comp["01x"].path && existsSync(comp["01x"].path)) {
    oxCell = { v: statSync(comp["01x"].path).size, k: "bytes" };
    if (comp.astGrep.available) oxNote = `binary only; + ast-grep ${(statSync(comp.astGrep.path).size / 1024 / 1024).toFixed(1)} MB required`;
  }
  rows.push([{ v: "01x", k: "text" }, oxCell, { v: oxNote, k: "text" }]);

  // scip-typescript — binary present, but needs the target repo's node_modules.
  const scipCell = comp["scip-typescript"].available
    ? { v: "binary + target-repo node_modules", k: "text" }
    : na(comp["scip-typescript"].reason);
  rows.push([{ v: "scip-typescript", k: "text" }, scipCell, { v: "requires a full npm install of each indexed repo (see cold column)", k: "text" }]);

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
  tokens: scenarioTokens,
  determinism: scenarioDeterminism,
  size: scenarioSize,
  install: scenarioInstall,
};
const SCENARIO_ORDER = ["cold", "warm", "queries", "tokens", "determinism", "size", "install"];

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

  const repos = args.repoDir
    ? [{ slug: basename(args.repoDir), sha: "local", lang: "auto", symbol: undefined, local: args.repoDir }]
    : reposFor(args.repo);
  // Deterministic row order: repos sorted by slug (render's structural contract).
  const ctxs = repos.map(makeCtx).sort((a, b) => (a.repo.slug < b.repo.slug ? -1 : a.repo.slug > b.repo.slug ? 1 : 0));

  const ids = args.scenario === "all" ? SCENARIO_ORDER : args.scenario.split(",").map((s) => s.trim());
  for (const id of ids) if (!SCENARIOS[id]) throw new Error(`unknown scenario: ${id} (have ${SCENARIO_ORDER.join(", ")}, or 'all')`);

  const sections = [];
  for (const id of ids) sections.push(SCENARIOS[id](ctxs, comp, cfg));

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
