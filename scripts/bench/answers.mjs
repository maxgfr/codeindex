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
//   2. The grader is SHAPE-BASED, not per-server. It pulls repo-relative paths
//      out of the raw response text and checks the expected file is among them.
//      A per-server response parser would make the grader a variable in the
//      experiment it is supposed to referee.
//   3. Only questions with exactly ONE correct answer are asked. A name declared
//      in two files grades luck.
//
// Reported alongside the token cost of each answer, because "correct" bought
// with ten times the context is a different result from "correct".

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startMcpClient } from "./mcp-client.mjs";
import { adapterFor } from "./mcp-adapters.mjs";

export const CORPUS_PATH = fileURLToPath(new URL("../../tests/quality/answer-cases.json", import.meta.url));

export function loadCorpus() {
  if (!existsSync(CORPUS_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  } catch {
    return undefined;
  }
}

/** Grade one answer. Mirrors tests/oracles/answers.ts — see there for why. */
export function gradeAnswer(expected, filesInAnswer) {
  if (!filesInAnswer.length) return "empty";
  const hit = filesInAnswer.some((f) => f === expected || f.endsWith(`/${expected}`) || expected.endsWith(`/${f}`));
  if (!hit) return "wrong";
  return filesInAnswer.length === 1 ? "correct" : "incomplete";
}

/** Every path in `text` that names a file the repository actually contains. */
export function pathsIn(text, knownFiles) {
  const out = new Set();
  for (const match of text.matchAll(/[\w./-]+\.[A-Za-z]{1,5}\b/g)) {
    const candidate = match[0].replace(/^\.\//, "");
    if (knownFiles.has(candidate)) out.add(candidate);
    else {
      // Servers report against their own root. Try the suffix too, so a path
      // convention is never graded as a wrong answer.
      const suffix = [...knownFiles].find((f) => candidate.endsWith(`/${f}`) || f.endsWith(`/${candidate}`));
      if (suffix) out.add(suffix);
    }
  }
  return [...out].sort();
}

/**
 * Ask one server every question for one repo, in ONE session.
 *
 * One session rather than one-per-call, unlike the latency probes: this
 * measures answers, not activation, and re-spawning per question would spend
 * minutes measuring process startup all over again. Server-specific failures
 * are recorded per question rather than failing the run — a tool that cannot
 * answer a question has produced a result, and it is `empty`.
 */
export async function askAll(server, dir, cases, knownFiles, opts = {}) {
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
    if (!tasks.find) return bail("server has no find-symbol equivalent");

    const grades = { correct: 0, incomplete: 0, wrong: 0, empty: 0 };
    let bytes = 0;
    for (const c of cases) {
      const call = tasks.find({ dir, symbol: c.symbol, file: undefined, defFile: undefined });
      if (!call) {
        grades.empty++;
        continue;
      }
      const r = await client.request("tools/call", call);
      if (!r.ok || r.result?.isError) {
        grades.empty++;
        continue;
      }
      const text = adapter.extractText(r.result);
      bytes += Buffer.byteLength(text);
      grades[gradeAnswer(c.declaredIn, pathsIn(text, knownFiles))]++;
    }
    return { ok: true, grades, asked: cases.length, tokens: Math.round(bytes / 4 / Math.max(1, cases.length)) };
  } catch (e) {
    return bail(e instanceof Error ? e.message : String(e));
  } finally {
    await client.close();
  }
}
