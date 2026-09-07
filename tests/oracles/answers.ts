// Ground truth for the answer-quality benchmark, written by a compiler.
//
// Every table in BENCHMARKS.md measures a COST — milliseconds, tokens, bytes,
// determinism. None of them measures whether the answer is RIGHT, which is the
// only claim that matters when someone says a different tool is "more powerful
// for an AI". This produces the questions that make that measurable.
//
// The questions are derived from scip-typescript's index — the real TypeScript
// compiler — for the same reason the extraction oracles use it: this project
// does not get to be the authority on whether this project answers correctly.
// A question is only kept when the compiler's answer is UNAMBIGUOUS, because a
// question with two defensible answers grades noise.

import { basename } from "node:path";

/** One question with the answer a compiler already knows. */
export interface AnswerCase {
  repo: string;
  kind?: "location";
  /** "where is X declared" — the symbol asked about. */
  symbol: string;
  /** The repo-relative file the compiler says declares it. Exactly one. */
  declaredIn: string;
  /** Files that also mention the name — a wrong answer is one of these. */
  distractors: string[];
}

export interface AnswerCorpus {
  generatedAt: string;
  tool: string;
  cases: (AnswerCase | ReferenceCase)[];
  unavailable?: { repo: string; reason: string }[];
  revisions?: Record<string, string>;
  provenance?: Record<string, { generatedAt: string; tool: string; revision?: string; refreshed: boolean }>;
}

/**
 * Turn a compiler index into questions worth asking.
 *
 * `declarations` is the oracle's (file, name) list — the same unit the
 * extraction differential compares on. A name declared in exactly ONE file is a question
 * with one right answer; a name declared in several is dropped, because
 * "correct" would then depend on which one the tool happened to return first
 * and the grade would measure luck.
 *
 * Names shorter than four characters are dropped too: `New`, `get` and `id`
 * match half a repository by substring, so a tool can be graded correct for a
 * coincidence. That bias would flatter every tool equally, which is exactly
 * what makes the resulting table say nothing.
 */
export function casesFromPairs(repo: string, declarations: { file: string; name: string }[], limit = 25): AnswerCase[] {
  const byName = new Map<string, Set<string>>();
  for (const { file, name } of declarations) {
    if (name.length < 4 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    // A namespace descriptor whose name IS the filename is scip-typescript
    // describing the module, not a declaration anyone would search for.
    if (name === basename(file).replace(/\.[^.]+$/, "")) continue;
    const arr = byName.get(name) ?? new Set<string>();
    arr.add(file);
    byName.set(name, arr);
  }

  const unique: AnswerCase[] = [];
  for (const [symbol, files] of byName) {
    if (files.size !== 1) continue; // ambiguous — no single right answer
    unique.push({ repo, symbol, declaredIn: [...files][0]!, distractors: [] });
  }

  // Deterministic selection: sort by name and take a prefix, rather than
  // sampling. A benchmark whose question set moves between runs cannot be a
  // ratchet, and every other number in this project is reproducible.
  unique.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return unique.slice(0, limit);
}

export { gradeAnswer, gradeFiles, pathsIn, type Grade } from "../../scripts/bench/answer-grading.mjs";

/** Compiler symbol identity is retained so homonyms cannot blend references. */
export interface ScipOccurrence {
  file: string;
  symbol: string;
  name: string;
  definition: boolean;
}

export interface ReferenceCase extends Omit<AnswerCase, "kind"> {
  kind: "references";
  /** General references, not necessarily calls; declaration file excluded. */
  referencedIn: string[];
}

export function referenceCasesFromOccurrences(repo: string, occurrences: ScipOccurrence[], limit = 25): ReferenceCase[] {
  const definitions = new Map<string, ScipOccurrence[]>();
  for (const occ of occurrences) {
    if (!occ.definition) continue;
    const list = definitions.get(occ.name) ?? [];
    if (!list.some((d) => d.file === occ.file && d.symbol === occ.symbol)) list.push(occ);
    definitions.set(occ.name, list);
  }
  const out: ReferenceCase[] = [];
  for (const c of casesFromPairs(repo, occurrences.filter((o) => o.definition), Infinity)) {
    const defs = definitions.get(c.symbol)!;
    if (defs.length !== 1) continue;
    const identity = defs[0]!.symbol;
    const referencedIn = [...new Set(occurrences.filter((o) => !o.definition && o.symbol === identity && o.file !== c.declaredIn).map((o) => o.file))].sort();
    if (referencedIn.length) out.push({ ...c, kind: "references", referencedIn });
  }
  return out.slice(0, limit);
}


/** A bounded refresh retains other repositories' cases with their own dates. */
export function mergeAnswerCorpora(previous: AnswerCorpus | undefined, generated: AnswerCorpus, selected?: string[]): AnswerCorpus {
  const provenance: NonNullable<AnswerCorpus["provenance"]> = {};
  for (const repo of new Set(generated.cases.map((c) => c.repo))) {
    provenance[repo] = { generatedAt: generated.generatedAt, tool: generated.tool, revision: generated.revisions?.[repo], refreshed: true };
  }
  const retained = selected && previous ? previous.cases.filter((c) => !selected.includes(c.repo)) : [];
  const retainedRepos = new Set(retained.map((c) => c.repo));
  for (const repo of retainedRepos) {
    provenance[repo] = { ...(previous!.provenance?.[repo] ?? { generatedAt: previous!.generatedAt, tool: previous!.tool, revision: previous!.revisions?.[repo] }), refreshed: false };
  }
  return {
    ...generated,
    cases: [...retained, ...generated.cases],
    provenance,
    unavailable: generated.unavailable?.map((entry) => retainedRepos.has(entry.repo)
      ? { repo: entry.repo, reason: "not refreshed in bounded generation; prior compiler cases retained with original provenance" } : entry),
  };
}
