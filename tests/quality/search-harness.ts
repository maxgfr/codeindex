// The search-relevance harness: how well does ranking put the right file first?
//
// WHY THIS EXISTS. `tests/bm25.test.ts` proves the scorer is BM25 and that it is
// deterministic. Neither property implies the ranking is USEFUL: an index built
// only from symbol names and path segments scores a perfect BM25 over a corpus
// that simply does not contain the words people search with. "where is rate
// limiting handled" cannot rank anything if the phrase lives in a comment the
// index never read.
//
// So this measures retrieval quality against hand-written relevance judgements
// (tests/quality/search-cases.json) over a fixture service where every topic
// lives in exactly one file. The metrics are the standard IR three:
//
//   MRR       — 1/rank of the FIRST relevant hit, averaged. "Is the answer on top?"
//   nDCG@10   — graded gain discounted by rank, normalised by the ideal ordering.
//   recall@5  — fraction of relevant files that made the top 5.
//
// Frozen into baseline.json and ratcheted by tests/quality.test.ts, exactly like
// the extraction scores.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../../src/scan.js";
import { searchIndex } from "../../src/bm25.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEARCH_CASES_PATH = join(HERE, "search-cases.json");

interface SearchCase {
  query: string;
  relevant: string[];
}

interface SearchCaseFile {
  repo: string;
  cases: SearchCase[];
}

export interface SearchReport {
  cases: number;
  mrr: number;
  ndcg10: number;
  recall5: number;
  /** Cases with no relevant file anywhere in the top 10 — the outright misses. */
  misses: string[];
}

const K = 10;

// Ideal DCG for `n` relevant documents under binary relevance: the best any
// ranking could do is put all of them in the first n slots.
function idealDcg(n: number): number {
  let dcg = 0;
  for (let i = 0; i < n; i++) dcg += 1 / Math.log2(i + 2);
  return dcg;
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

export function scoreSearch(): SearchReport {
  const spec = JSON.parse(readFileSync(SEARCH_CASES_PATH, "utf8")) as SearchCaseFile;
  const root = join(HERE, "..", "fixtures", spec.repo);
  // One scan, reused across every query — the derived BM25 documents are
  // memoised per scan (src/derived.ts), so this also mirrors how a real session
  // issues many queries against one index.
  const scan = scanRepo(root);

  let rrSum = 0;
  let ndcgSum = 0;
  let recallSum = 0;
  const misses: string[] = [];

  for (const c of spec.cases) {
    const results = searchIndex(scan, c.query, { limit: K });
    const ranked = results.map((r) => r.file);
    const relevant = new Set(c.relevant);

    const firstHit = ranked.findIndex((f) => relevant.has(f));
    rrSum += firstHit === -1 ? 0 : 1 / (firstHit + 1);
    if (firstHit === -1) misses.push(c.query);

    let dcg = 0;
    for (let i = 0; i < ranked.length && i < K; i++) {
      if (relevant.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
    }
    ndcgSum += dcg / idealDcg(Math.min(relevant.size, K));

    const top5 = ranked.slice(0, 5).filter((f) => relevant.has(f)).length;
    recallSum += top5 / relevant.size;
  }

  const n = spec.cases.length || 1;
  return {
    cases: spec.cases.length,
    mrr: round(rrSum / n),
    ndcg10: round(ndcgSum / n),
    recall5: round(recallSum / n),
    misses,
  };
}

export interface SearchBaseline {
  mrr: number;
  ndcg10: number;
  recall5: number;
}

export function searchBaselineOf(r: SearchReport): SearchBaseline {
  return { mrr: r.mrr, ndcg10: r.ndcg10, recall5: r.recall5 };
}

export const RATCHETED_SEARCH_METRICS = ["mrr", "ndcg10", "recall5"] as const satisfies readonly (keyof SearchBaseline)[];

export function formatSearchReport(r: SearchReport): string {
  const rows = [
    `search      cases=${r.cases}  MRR=${(r.mrr * 100).toFixed(1)}%  nDCG@10=${(r.ndcg10 * 100).toFixed(1)}%  recall@5=${(r.recall5 * 100).toFixed(1)}%`,
  ];
  if (r.misses.length) {
    rows.push(`  ${r.misses.length} queries with NO relevant file in the top ${K}:`);
    for (const q of r.misses) rows.push(`    · ${q}`);
  }
  return rows.join("\n");
}
