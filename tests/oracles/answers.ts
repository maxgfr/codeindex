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
  cases: AnswerCase[];
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
  const byName = new Map<string, string[]>();
  for (const { file, name } of declarations) {
    if (name.length < 4 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    // A namespace descriptor whose name IS the filename is scip-typescript
    // describing the module, not a declaration anyone would search for.
    if (name === basename(file).replace(/\.[^.]+$/, "")) continue;
    const arr = byName.get(name) ?? [];
    arr.push(file);
    byName.set(name, arr);
  }

  const unique: AnswerCase[] = [];
  for (const [symbol, files] of byName) {
    if (files.length !== 1) continue; // ambiguous — no single right answer
    unique.push({ repo, symbol, declaredIn: files[0]!, distractors: [] });
  }

  // Deterministic selection: sort by name and take a prefix, rather than
  // sampling. A benchmark whose question set moves between runs cannot be a
  // ratchet, and every other number in this project is reproducible.
  unique.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return unique.slice(0, limit);
}

export type Grade = "correct" | "incomplete" | "wrong" | "empty";

/**
 * Grade one answer against the compiler's.
 *
 * Three outcomes rather than a boolean, because "named the right file among
 * five" and "named the right file" are different qualities and collapsing them
 * hides the thing an agent actually pays for: reading four files it did not
 * need. `empty` is kept separate from `wrong` for the same reason — a tool that
 * says nothing is less harmful than one that says something false.
 */
export function gradeAnswer(expected: string, filesInAnswer: string[]): Grade {
  if (!filesInAnswer.length) return "empty";
  const hit = filesInAnswer.some((f) => f === expected || f.endsWith(`/${expected}`) || expected.endsWith(`/${f}`));
  if (!hit) return "wrong";
  return filesInAnswer.length === 1 ? "correct" : "incomplete";
}

/**
 * Every repo-relative-looking path in a tool's response text.
 *
 * Deliberately shape-based rather than schema-based: the three servers return
 * three different JSON shapes, and grading them through a per-server extractor
 * would make the grader part of what is being compared. Extracting paths from
 * the raw text treats all three identically — which is the only way the
 * comparison is fair.
 */
export function pathsIn(text: string, knownFiles: Set<string>): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/[\w./-]+\.[A-Za-z]{1,5}\b/g)) {
    const candidate = match[0].replace(/^\.\//, "");
    if (knownFiles.has(candidate)) out.add(candidate);
  }
  return [...out].sort();
}
