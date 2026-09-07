// The answer-quality probe: ask each MCP server the same questions and record
// whether it answered them.
//
// Every other scenario in this harness measures a COST — milliseconds, bytes,
// tokens, disk. This one measures whether the answer is RIGHT, which is the
// claim people actually argue about and the one nobody had numbers for.
//
// Three rules keep it a measurement rather than a demonstration:
//
//   1. The questions come from scip-typescript — the real TypeScript compiler —
//      via tests/quality/answer-cases.json. This project does not author the
//      answer key to a table this project appears in.
//   2. One path resolver and set grader handles every server; absolute and
//      package-relative paths resolve only when unambiguous in the repository.
//   3. Location questions require one declaration file. Reference questions
//      require one compiler symbol identity and score precision AND recall.
//      The LSP variant grades its explicitly labelled reference block, retaining
//      its agreement evidence separately from files offered as the answer.
//
// Reported alongside the token cost of each answer, because "correct" bought
// with ten times the context is a different result from "correct".

import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMcpClient } from "./mcp-client.mjs";
import { adapterFor } from "./mcp-adapters.mjs";

export const CORPUS_PATH = fileURLToPath(new URL("../../tests/quality/answer-cases.json", import.meta.url));

export function loadCorpus(path = process.env.CODEINDEX_ANSWER_CORPUS ?? CORPUS_PATH) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

import { gradeFiles, pathsIn } from "./answer-grading.mjs";
export { gradeAnswer, gradeFiles, pathsIn } from "./answer-grading.mjs";

/** Inventory source paths independently of the tool being graded. */
export function repositoryFiles(dir, prefix = "") {
  const ignored = new Set([".git", "node_modules", ".codeindex", ".serena", "graphify-out"]);
  return new Set(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const rel = prefix + entry.name;
    return entry.isDirectory() ? [...repositoryFiles(join(dir, entry.name), `${rel}/`)] : [rel];
  }));
}

/**
 * Ask one server every question for one repo, in ONE session.
 *
 * One session rather than one-per-call, unlike the latency probes: this
 * measures answers, not activation, and re-spawning per question would spend
 * minutes measuring process startup all over again. Server-specific failures
 * are recorded per question. Unsupported tools and degraded LSP results are
 * not measured; failed calls to supported tools are empty answers.
 */
export async function askAll(server, dir, cases, knownFiles, opts = {}) {
  if (!cases.length) return { ok: false, reason: "no compiler-derived questions" };
  const adapter = adapterFor(server, opts);
  if (!adapter) return { ok: false, reason: `no adapter for ${server}` };

  // PRIME FIRST. graphify's get_node reads a graph.json that `graphify update`
  // has to write; without it the server answers nothing and would score zero
  // for a setup mistake rather than for the quality of its answers. serena and
  // codeindex both prime too, so all three are asked on a warm index — the
  // same untimed one-time build the latency scenarios already give them.
  const primed = adapter.prime ? adapter.prime(dir) : { ok: true };
  if (!primed.ok) return { ok: false, reason: `prime: ${primed.reason}` };

  const spec = adapter.spawn(dir);
  const client = startMcpClient(spec.cmd, spec.args, { cwd: spec.cwd ?? dir, env: spec.env });
  const bail = async (reason) => {
    await client.close();
    return { ok: false, reason };
  };

  try {
    const hs = await client.handshake();
    if (!hs.ok) return bail(`handshake: ${hs.reason}`);
    const listed = await client.request("tools/list", {});
    if (!listed.ok) return bail(`tools/list: ${listed.reason}`);
    const tasks = adapter.tasks(listed.result?.tools ?? []);
    const records = [];
    for (const c of cases) {
      const task = c.kind === "references" ? tasks.refs : tasks.find;
      if (!task) {
        records.push({ symbol: c.symbol, measured: false, reason: "server has no equivalent tool" });
        continue;
      }
      // All servers get the same compiler-provided declaration location.
      const call = task({ dir, symbol: c.symbol, file: c.declaredIn, defFile: c.declaredIn, lsp: opts.lsp === true });
      if (!call) {
        records.push({ symbol: c.symbol, measured: false, reason: "adapter cannot construct this question" });
        continue;
      }
      const start = performance.now();
      const r = await client.request("tools/call", call);
      const ms = performance.now() - start;
      const text = r.ok ? adapter.extractText(r.result) : "";
      const record = scoreResponse(c, text, knownFiles, { lsp: opts.lsp === true, failed: !r.ok || r.result?.isError });
      records.push({ symbol: c.symbol, ...record, ms, bytes: Buffer.byteLength(text), ...(opts.includeResponses ? { response: text } : {}) });
    }
    const measured = records.filter((r) => r.measured);
    if (!measured.length) return { ok: false, reason: [...new Set(records.map((r) => r.reason))].join("; "), records };
    const grades = { correct: 0, incomplete: 0, wrong: 0, empty: 0 };
    for (const r of measured) grades[r.grade]++;
    const times = measured.map((r) => r.ms).sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    return {
      ok: true, grades, asked: cases.length, measured: measured.length, unavailable: cases.length - measured.length,
      tokens: Math.round(measured.reduce((n, r) => n + r.bytes, 0) / 4 / measured.length),
      precision: measured.reduce((n, r) => n + r.precision, 0) / measured.length,
      recall: measured.reduce((n, r) => n + r.recall, 0) / measured.length,
      ms: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
      records,
    };
  } catch (e) {
    return bail(e instanceof Error ? e.message : String(e));
  } finally {
    await client.close();
  }
}


/** The LSP row measures the LSP tier, never static fallback or agreement paths. */
export function scoreResponse(c, text, knownFiles, opts = {}) {
  let answerText = text;
  let agreement;
  if (opts.lsp && !opts.failed) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* not a valid LSP response */ }
    if (!parsed?.lsp?.ok) return { measured: false, reason: parsed?.lsp?.reason ?? "LSP tier unavailable" };
    answerText = JSON.stringify(parsed.lsp.refs);
    agreement = parsed.lsp.agreement;
  }
  const expected = c.kind === "references" ? c.referencedIn : [c.declaredIn];
  const files = opts.failed ? [] : pathsIn(answerText, knownFiles).filter((f) => c.kind !== "references" || f !== c.declaredIn);
  return { measured: true, ...gradeFiles(expected, files), files, ...(agreement ? { agreement } : {}) };
}
