// Behavioral analytics mined from git history (code-maat lineage): change
// coupling (files that change TOGETHER, revealing hidden dependencies no
// import edge shows) and hotspot ranking (churn × size — the ~few % of files
// where most future work and most defects concentrate). Deterministic for a
// given HEAD; degrades loudly outside a git repo like gitChurn.
import type { RepoScan } from "./scan.js";
import type { Graph } from "./types.js";
import { readHistory, repoPaths } from "./git.js";
import { byStr } from "./sort.js";
import { isTestPath } from "./tests-map.js";

export interface ChangeCoupling {
  a: string; // path relative to --repo (a < b lexicographically)
  b: string;
  together: number; // commits touching both
  totalA: number; // commits touching a (within the analysed window)
  totalB: number;
  // together / min(totalA, totalB) — 1.0 means "every change to the less-
  // churned file also touched the other". The classic logical-coupling ratio.
  strength: number;
  // Lower bound of the 95% Wilson interval for `strength` over those
  // min(totalA, totalB) commits: how strong the coupling is WITH confidence.
  // The ranking key — 3/3 scores 0.44 and 200/210 scores 0.91, where raw
  // strength ranked the former first and filled the top with thinly
  // evidenced 1.0s.
  confidence: number;
  // Set when a graph was given: whether an edge (import, call, use, extends,
  // implements, doc-link — either direction) already links the two files.
  // false = a hidden dependency, what coupling exists to find.
  linked?: boolean;
}

export interface CouplingOptions {
  since?: string; // only mine commits after this ref, or since this date
  // Commits touching more than this many files are skipped as mass refactors
  // (renames, formatting sweeps) that would couple everything to everything.
  maxCommitFiles?: number; // default 30
  minTogether?: number; // drop pairs seen together fewer times (default 3)
  maxPairs?: number; // cap the result (default 100)
  // The index of `dir`. Pairs are then restricted to indexed files — so
  // deleted and renamed-away paths, --scope/--include/--exclude and ignore
  // rules all apply — and each pair says whether the graph links it.
  graph?: Pick<Graph, "files" | "fileEdges">;
  hidden?: boolean; // with graph: keep only the pairs no edge links
}

export interface CouplingResult {
  ok: boolean;
  error?: string; // why ok is false
  shallow?: boolean; // a shallow clone: counts are lower bounds
  couplings: ChangeCoupling[];
}

export function changeCoupling(dir: string, opts: CouplingOptions = {}): CouplingResult {
  const maxCommitFiles = opts.maxCommitFiles ?? 30;
  const minTogether = opts.minTogether ?? 3;
  const maxPairs = opts.maxPairs ?? 100;
  const res = readHistory(dir, opts.since);
  if (!res.ok) return { ok: false, error: res.error, couplings: [] };
  const { log } = res;

  // Eligible files get a rank in name order, so a pair is two small ints
  // (lo < hi ⇔ a < b) and its key a single number. String pair keys cost
  // 7.8x on a 20k-commit history: ~6M concatenations for 48k surviving pairs.
  const indexed = opts.graph ? new Set(opts.graph.files.map((f) => f.rel)) : undefined;
  const rel = repoPaths(log);
  const names = rel.filter((p): p is string => p !== undefined && (!indexed || indexed.has(p))).sort(byStr);
  const rankOf = new Map(names.map((name, i) => [name, i]));
  const rank = rel.map((p) => (p === undefined ? -1 : rankOf.get(p) ?? -1));
  const m = names.length;

  const totals = new Int32Array(m);
  const pairs = new Map<number, number>();
  const seen = new Int32Array(log.paths.length).fill(-1); // dedupe within a commit
  const files: number[] = [];
  for (let c = 0; c + 1 < log.starts.length; c++) {
    let size = 0;
    files.length = 0;
    for (let k = log.starts[c]!; k < log.starts[c + 1]!; k++) {
      const id = log.ids[k]!;
      if (seen[id] === c) continue;
      seen[id] = c;
      size++;
      if (rank[id]! >= 0) files.push(rank[id]!);
    }
    // The size is the WHOLE commit's, files outside --repo included: a sweep
    // across a monorepo is a mass refactor even where it lands on 3 files.
    if (size === 0 || size > maxCommitFiles) continue;
    files.sort((x, y) => x - y);
    for (let i = 0; i < files.length; i++) {
      const lo = files[i]!;
      totals[lo]!++;
      for (let j = i + 1; j < files.length; j++) {
        const key = lo * m + files[j]!;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  let linked: Set<number> | undefined;
  if (opts.graph) {
    linked = new Set();
    for (const e of opts.graph.fileEdges) {
      // A prose mention is not a dependency; a dangling edge links nothing.
      if (e.dangling || e.kind === "mention" || e.kind === "contains") continue;
      const x = rankOf.get(e.from);
      const y = rankOf.get(e.to);
      if (x === undefined || y === undefined || x === y) continue;
      linked.add(x < y ? x * m + y : y * m + x);
    }
  }

  const out: ChangeCoupling[] = [];
  for (const [key, together] of pairs) {
    if (together < minTogether) continue;
    const isLinked = linked?.has(key) ?? false;
    if (opts.hidden && isLinked) continue;
    const lo = Math.floor(key / m);
    const hi = key - lo * m;
    if (stem(names[lo]!) === stem(names[hi]!)) continue;
    const totalA = totals[lo]!;
    const totalB = totals[hi]!;
    const n = Math.min(totalA, totalB);
    out.push({
      a: names[lo]!,
      b: names[hi]!,
      together,
      totalA,
      totalB,
      strength: round3(together / n),
      confidence: round3(wilsonLower(together, n)),
      ...(linked ? { linked: isLinked } : {}),
    });
  }
  out.sort(
    (x, y) =>
      y.confidence - x.confidence || y.strength - x.strength || y.together - x.together || byStr(x.a, y.a) || byStr(x.b, y.b),
  );
  return { ok: true, ...(log.shallow ? { shallow: true } : {}), couplings: out.slice(0, maxPairs) };
}

// A path up to the first dot of its file name (a dotfile's own leading dot
// aside). Two files sharing it sit in one directory and are NAMED as a pair —
// x.po/x.mo, x.js/x.min.js, dev.in/dev.txt, x.ts/x.test.ts: a generated
// artifact or a declared companion. Their co-change is what the name already
// says, never the hidden dependency coupling exists to find, and such pairs
// crowded the top of an i18n-heavy history (34 of django's top 100).
function stem(path: string): string {
  const dot = path.indexOf(".", path.lastIndexOf("/") + 2);
  return dot < 0 ? path : path.slice(0, dot);
}

// Lower bound of the 95% Wilson score interval for k successes in n trials.
function wilsonLower(k: number, n: number): number {
  const z2 = 1.96 * 1.96;
  const p = k / n;
  return (p + z2 / (2 * n) - Math.sqrt(z2 * (p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

const round3 = (x: number): number => Number(x.toFixed(3));

export interface Hotspot {
  rel: string;
  lines: number;
  commits: number;
  // commits × log2(lines+1): frequent change to substantial files. The
  // CodeScene insight — effort concentrates in few files — with a size damper
  // so a churned 5-line config does not outrank a churned 2000-line module.
  score: number;
  // A test file. Kept in the ranking, but labelled: churn in a suite is often
  // the tests keeping up with the code rather than risk of its own.
  test?: true;
}

// Rank the scanned files by churn × size. `churn` comes from gitChurn(). Only
// files that changed in the window rank: a file with no commits scores 0, and
// padding the list with those — ordered by size alone — presented unchanged
// files as hotspots (16 of gin's top 20 under a short --since).
export function rankHotspots(scan: RepoScan, churn: Map<string, number>, top = 20): Hotspot[] {
  const out: Hotspot[] = [];
  for (const f of scan.files) {
    if (f.kind !== "code") continue;
    const commits = churn.get(f.rel) ?? 0;
    const score = Number((commits * Math.log2(f.lines + 1)).toFixed(2));
    if (score <= 0) continue;
    out.push({ rel: f.rel, lines: f.lines, commits, score, ...(isTestPath(f.rel) ? { test: true as const } : {}) });
  }
  out.sort((a, b) => b.score - a.score || b.lines - a.lines || byStr(a.rel, b.rel));
  return out.slice(0, top);
}
