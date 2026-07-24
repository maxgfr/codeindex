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
//     toolUsed: {find, refs, overview}, taskErrors: {find, refs, overview},
//     defFile, overviewFile }
//
// A per-TASK failure (tool error / timeout on one call) never voids the
// session: the task's ms/bytes stay null and its reason lands in taskErrors,
// while activation and the other tasks keep their measurements — the
// orchestrator renders per-cell n/a. Only activation/prime failures fail the
// whole probe.
//
// activation  = spawn -> first successful find response on PRIMED artifacts
//               (prime() once before the loop, artifacts kept; child killed
//               between iterations), median of warmup+N (N downgraded to
//               --slow-runs when the warmup crosses --slow-threshold,
//               mirroring bench runMedian). The probe never cleans artifacts:
//               graphify-mcp / `falcon mcp serve` cannot start without them,
//               and cold builds are timed by the bench cold scenario instead.
// queries     = per-call medians on the LAST live session of the activation
//               loop; runs = the smallest effective N across the three tasks.
// bytes       = Buffer.byteLength of the last response text per task.
//
// ---- mcp-adapters.mjs import contract ------------------------------------
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
//     // the next BUILD is cold — bench cold-scenario hook; the probe itself
//     // never calls it (MCP sessions run on primed artifacts)
//   tasks(tools) -> { find, refs, overview },     // builders introspected from
//     // the tools/list entries ({name, inputSchema}; bare name strings are
//     // tolerated); each entry is (ctx) => {name, arguments} or undefined
//     // when the server lacks the tool (renders n/a). ctx = {dir, symbol,
//     // file, defFile} (defFile only set for refs/overview, parsed from find).
//   extractText(result) -> string,                // tools/call result -> text
//   defFileFrom(text, ctx)? -> string | undefined // repo-relative def file of
//     // the symbol, parsed from the find response (serena's refs need it as
//     // relative_path; also reported as defFile).
// }
// Adapters may also carry perRepoSupport(repoLang) for the bench orchestrator;
// the probe ignores it. graphify's file-overview is undefined by design: file
// nodes are labeled by basename (collision-prone) and the query_graph miss-
// fallback would need a response-dependent retry this one-call contract
// cannot express — the cell renders n/a.

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

// The adapter registry stays a dynamic import so an adapter-module defect
// degrades to {ok:false, reason} instead of crashing the probe before it can
// print its one JSON line.
async function loadAdapter(server, opts) {
  try {
    const m = await import("./mcp-adapters.mjs");
    return m.adapterFor?.(server, opts);
  } catch { return undefined; }
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

// One activation iteration: spawn -> handshake -> tools/list -> find, on
// primed artifacts. The timed region is spawn -> find response OK (readiness-
// to-first-answer). On failure the session is closed and {ok:false, reason}
// returned.
async function activateOnce(adapter, a) {
  const spec = adapter.spawn(a.dir);
  const t0 = performance.now();
  const client = startMcpClient(spec.cmd, spec.args, { cwd: spec.cwd ?? a.dir, env: spec.env });
  const bail = async (reason) => { await client.close(); return { ok: false, reason }; };
  const hs = await client.handshake();
  if (!hs.ok) return bail(`handshake: ${hs.reason}`);
  const tl = await client.request("tools/list");
  if (!tl.ok) return bail(`tools/list: ${tl.reason}`);
  const tools = tl.result?.tools ?? [];
  const toolNames = tools.map((t) => t?.name).filter(Boolean);
  const tasks = adapter.tasks(tools);
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
    taskErrors: { find: null, refs: null, overview: null },
  };
  const effRuns = [];
  for (const [task, msKey] of [["find", "findMs"], ["refs", "refsMs"], ["overview", "overviewMs"]]) {
    const call = task === "find" ? findCall : tasks[task]?.(ctx);
    if (!call) continue; // server lacks the tool — nulls render as n/a upstream
    const r = await medianCalls(client, adapter, a, call);
    if (!r.ok) { out.taskErrors[task] = r.reason; continue; } // this task -> n/a; keep the rest
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
    taskErrors: out.taskErrors,
    defFile,
    overviewFile: a.file,
  });
}

process.on("uncaughtException", (e) => { fail(`uncaught: ${e?.message ?? e}`); process.exit(0); });
process.on("unhandledRejection", (e) => { fail(`unhandled: ${e?.message ?? e}`); process.exit(0); });

main()
  .catch((e) => fail(e?.stack ?? e?.message ?? e))
  .finally(() => { if (!printed) fail("probe produced no result"); process.exit(0); });
