#!/usr/bin/env node
// Standalone MCP probe. The synchronous bench orchestrator spawns this child
// (node scripts/bench/mcp-probe.mjs …) per repo × server so the async MCP
// client never leaks into bench.mjs. Prints exactly ONE JSON line on stdout
// and ALWAYS exits 0 — any internal failure prints {ok:false, reason}; the
// orchestrator treats a non-zero exit or unparseable stdout as n/a.
//
//   node scripts/bench/mcp-probe.mjs \
//     --server codeindex|serena|graphify|falcon --dir <abs-repo> \
//     --symbol <S> --file <repo-relative-F0> \
//     --runs N [--slow-runs 3] [--slow-threshold 60000] \
//     [--bin <abs>] [--mcp-bin <abs>] [--engine <abs>]
//
// Output line:
//   { ok, reason?, activation: {ms, runs}, queries: {findMs, refsMs,
//     overviewMs, runs}, bytes: {find, refs, overview},
//     toolUsed: {find, refs, overview}, defFile, overviewFile }
//
// activation  = spawn -> first successful find response, cold artifacts
//               (cleanCold before every iteration, child killed between),
//               median of warmup+N (N downgraded to --slow-runs when the
//               warmup crosses --slow-threshold, mirroring bench runMedian).
// queries     = per-call medians on the LAST live session of the activation
//               loop; runs = the smallest effective N across the three tasks.
// bytes       = Buffer.byteLength of the last response text per task.
//
// ---- mcp-adapters.mjs import contract (module lands in the next phase) ----
// export function adapterFor(server, opts) -> adapter | undefined
//   server: "codeindex" | "serena" | "graphify" | "falcon"
//   opts:   { dir, bin, mcpBin, engine } — absolute paths from the CLI flags
//           (bin = competitor binary, mcpBin = graphify-mcp, engine = our cli.mjs).
// adapter = {
//   key: server,
//   spawn(dir) -> { cmd, args, cwd?, env? },      // stdio MCP server argv
//   prime(dir)? -> { ok, reason? } | undefined,   // untimed one-time artifact
//                                                 // build; artifacts KEPT
//   cleanCold(dir)? -> void,                      // remove on-disk artifacts so
//                                                 // the next activation is cold
//   tasks(toolNames) -> { find, refs, overview }, // builders introspected from
//     // the tools/list names; each entry is (ctx) => {name, arguments} or
//     // undefined when the server lacks the tool. ctx = {dir, symbol, file,
//     // defFile} (defFile only set for refs/overview, parsed from find).
//   extractText(result) -> string,                // tools/call result -> text
//   defFileFrom(text, ctx)? -> string | undefined // repo-relative def file of
//     // the symbol, parsed from the find response (serena's refs need it as
//     // relative_path; also reported as defFile).
// }
// Open point for the adapters phase: graphify's file-overview miss fallback
// (spec §2.2, degrade to query_graph) needs a response-dependent retry — the
// adapter will have to extend `tasks` builders (e.g. candidate lists) then.

import { fileURLToPath } from "node:url";
import { startMcpClient } from "./mcp-client.mjs";

const byteLen = (s) => Buffer.byteLength(s ?? "", "utf8");
const round1 = (x) => Math.round(x * 10) / 10;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

let printed = false;
function emit(obj) {
  if (printed) return;
  printed = true;
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
const fail = (reason) => emit({ ok: false, reason: String(reason) });

function parseArgs(argv) {
  const a = { server: "", dir: "", symbol: "", file: "", runs: 5, slowRuns: 3, slowThreshold: 60_000, bin: undefined, mcpBin: undefined, engine: undefined };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--server") a.server = argv[++i];
    else if (f === "--dir") a.dir = argv[++i];
    else if (f === "--symbol") a.symbol = argv[++i];
    else if (f === "--file") a.file = argv[++i];
    else if (f === "--runs") a.runs = Math.max(1, parseInt(argv[++i], 10) || 5);
    else if (f === "--slow-runs") a.slowRuns = Math.max(1, parseInt(argv[++i], 10) || 3);
    else if (f === "--slow-threshold") a.slowThreshold = Math.max(0, parseInt(argv[++i], 10) || 60_000);
    else if (f === "--bin") a.bin = argv[++i];
    else if (f === "--mcp-bin") a.mcpBin = argv[++i];
    else if (f === "--engine") a.engine = argv[++i];
    else return { error: `unknown flag: ${f}` };
  }
  for (const k of ["server", "dir", "symbol", "file"]) {
    if (!a[k]) return { error: `missing --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` };
  }
  return a;
}

// TEMPORARY inline adapter for self-testing the probe before mcp-adapters.mjs
// exists. Mirrors spec §2.4 exactly (tool names/params verified against the
// real server: find_symbol{repo,namePath}, find_references{repo,name},
// symbols_overview{repo,file} — `repo` REQUIRED in every call). DELETE once
// mcp-adapters.mjs lands: loadAdapter prefers the real module.
function inlineCodeindexAdapter(opts) {
  // engine.mjs is a pure module (no main guard); the runnable entry is cli.mjs.
  const cli = opts.engine ?? fileURLToPath(new URL("../cli.mjs", import.meta.url));
  return {
    key: "codeindex",
    spawn(dir) { return { cmd: process.execPath, args: [cli, "mcp"], cwd: dir }; },
    // no prime/cleanCold: artifacts are built in-process per call, nothing on disk.
    tasks(toolNames) {
      const has = (n) => toolNames.includes(n);
      return {
        find: has("find_symbol")
          ? (ctx) => ({ name: "find_symbol", arguments: { repo: ctx.dir, namePath: ctx.symbol } })
          : undefined,
        refs: has("find_references")
          ? (ctx) => ({ name: "find_references", arguments: { repo: ctx.dir, name: ctx.symbol } })
          : undefined,
        overview: has("symbols_overview")
          ? (ctx) => ({ name: "symbols_overview", arguments: { repo: ctx.dir, file: ctx.file } })
          : undefined,
      };
    },
    extractText(result) {
      return (result?.content ?? []).map((c) => c?.text ?? "").join("");
    },
    defFileFrom(text) {
      try { return JSON.parse(text)?.[0]?.file; } catch { return undefined; }
    },
  };
}

async function loadAdapter(server, opts) {
  try {
    const m = await import("./mcp-adapters.mjs");
    const a = m.adapterFor?.(server, opts);
    if (a) return a;
  } catch { /* module lands next phase — fall through to the inline adapter */ }
  return server === "codeindex" ? inlineCodeindexAdapter(opts) : undefined;
}

// One tools/call, timed. isError content counts as failure (its text is the reason).
async function timedCall(client, adapter, call) {
  const t0 = performance.now();
  const r = await client.request("tools/call", call);
  const ms = performance.now() - t0;
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.result?.isError) return { ok: false, reason: `tool error: ${adapter.extractText(r.result).slice(0, 300)}` };
  return { ok: true, ms, result: r.result };
}

// One activation iteration: cleanCold -> spawn -> handshake -> tools/list ->
// find. The timed region is spawn -> find response OK (readiness-to-first-
// answer). On failure the session is closed and {ok:false, reason} returned.
async function activateOnce(adapter, a) {
  try { adapter.cleanCold?.(a.dir); } catch (e) { return { ok: false, reason: `cleanCold: ${e?.message ?? e}` }; }
  const spec = adapter.spawn(a.dir);
  const t0 = performance.now();
  const client = startMcpClient(spec.cmd, spec.args, { cwd: spec.cwd ?? a.dir, env: spec.env });
  const bail = async (reason) => { await client.close(); return { ok: false, reason }; };
  const hs = await client.handshake();
  if (!hs.ok) return bail(`handshake: ${hs.reason}`);
  const tl = await client.request("tools/list");
  if (!tl.ok) return bail(`tools/list: ${tl.reason}`);
  const toolNames = (tl.result?.tools ?? []).map((t) => t?.name).filter(Boolean);
  const tasks = adapter.tasks(toolNames);
  const buildFind = tasks?.find;
  if (!buildFind) return bail(`find tool missing (tools: ${toolNames.slice(0, 8).join(", ")}…)`);
  const call = buildFind({ dir: a.dir, symbol: a.symbol, file: a.file, defFile: undefined });
  if (!call) return bail("find task builder returned nothing");
  const r = await timedCall(client, adapter, call);
  if (!r.ok) return bail(`find: ${r.reason}`);
  const ms = performance.now() - t0;
  return { ok: true, ms, client, tasks, findCall: call, findResult: r.result };
}

// warmup + N timed calls of the same tools/call; N downgrades to slowRuns when
// the warmup crosses the threshold (same rule as bench.mjs runMedian).
async function medianCalls(client, adapter, a, call) {
  const warm = await timedCall(client, adapter, call);
  if (!warm.ok) return warm;
  const n = warm.ms > a.slowThreshold ? Math.min(a.runs, a.slowRuns) : a.runs;
  const times = [];
  let last = warm;
  for (let i = 0; i < n; i++) {
    const x = await timedCall(client, adapter, call);
    if (!x.ok) return x;
    times.push(x.ms);
    last = x;
  }
  return { ok: true, ms: median(times), runs: n, text: adapter.extractText(last.result) };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) return fail(a.error);

  const adapter = await loadAdapter(a.server, { dir: a.dir, bin: a.bin, mcpBin: a.mcpBin, engine: a.engine });
  if (!adapter) return fail(`no adapter for server: ${a.server}`);

  // Untimed one-time prime; artifacts kept for the whole probe.
  if (adapter.prime) {
    let p;
    try { p = adapter.prime(a.dir); } catch (e) { return fail(`prime: ${e?.message ?? e}`); }
    if (p && p.ok === false) return fail(`prime failed: ${p.reason ?? "unknown"}`);
  }

  // ---- activation loop: warmup + N, child killed between iterations --------
  const warm = await activateOnce(adapter, a);
  if (!warm.ok) return fail(`activation warmup: ${warm.reason}`);
  const n = warm.ms > a.slowThreshold ? Math.min(a.runs, a.slowRuns) : a.runs;
  await warm.client.close();

  const times = [];
  let live;
  for (let i = 0; i < n; i++) {
    const it = await activateOnce(adapter, a);
    if (!it.ok) return fail(`activation run ${i + 1}/${n}: ${it.reason}`);
    times.push(it.ms);
    if (i < n - 1) await it.client.close();
    else live = it; // last session stays live for the query loop
  }
  const activation = { ms: round1(median(times)), runs: n };

  // ---- query loop on the last live session ---------------------------------
  const { client, tasks, findCall, findResult } = live;
  const defFile = adapter.defFileFrom?.(adapter.extractText(findResult), { dir: a.dir, symbol: a.symbol, file: a.file }) ?? null;
  const ctx = { dir: a.dir, symbol: a.symbol, file: a.file, defFile };

  const out = {
    queries: { findMs: null, refsMs: null, overviewMs: null, runs: null },
    bytes: { find: null, refs: null, overview: null },
    toolUsed: { find: null, refs: null, overview: null },
  };
  const effRuns = [];
  for (const [task, msKey] of [["find", "findMs"], ["refs", "refsMs"], ["overview", "overviewMs"]]) {
    const call = task === "find" ? findCall : tasks[task]?.(ctx);
    if (!call) continue; // server lacks the tool — nulls render as n/a upstream
    const r = await medianCalls(client, adapter, a, call);
    if (!r.ok) { await client.close(); return fail(`${task}: ${r.reason}`); }
    out.queries[msKey] = round1(r.ms);
    out.bytes[task] = byteLen(r.text);
    out.toolUsed[task] = call.name;
    effRuns.push(r.runs);
  }
  out.queries.runs = effRuns.length ? Math.min(...effRuns) : null;

  await client.close();
  emit({
    ok: true,
    activation,
    queries: out.queries,
    bytes: out.bytes,
    toolUsed: out.toolUsed,
    defFile,
    overviewFile: a.file,
  });
}

process.on("uncaughtException", (e) => { fail(`uncaught: ${e?.message ?? e}`); process.exit(0); });
process.on("unhandledRejection", (e) => { fail(`unhandled: ${e?.message ?? e}`); process.exit(0); });

main()
  .catch((e) => fail(e?.stack ?? e?.message ?? e))
  .finally(() => { if (!printed) fail("probe produced no result"); process.exit(0); });
