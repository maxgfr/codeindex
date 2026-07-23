import type { RepoScan } from "../scan.js";
import { rrf } from "../util.js";
import { byStr } from "../sort.js";
import { searchIndex, type SearchOptions, type SearchResult } from "../bm25.js";
import { encode, intDot } from "./encode.js";
import type { EmbeddingIndex } from "./index.js";
import type { StaticEmbedModel } from "./model.js";

const DEFAULT_LIMIT = 20;
const RRF_K = 60; // reuse the engine-wide RRF damping constant

export interface SemanticSearchOptions extends SearchOptions {
  // The loaded static model, needed to encode the QUERY into the same int8 space
  // as the corpus. Absent → the search degrades to pure lexical (no throw).
  model?: StaticEmbedModel;
  // RRF damping (default 60), exposed for parity with the shared rrf helper.
  rrfK?: number;
}

// A fused result. Extends the lexical SearchResult additively: `semanticSymbol`
// is the corpus symbol whose embedding was closest to the query for this file
// (absent when the file was contributed only by the lexical side, or when the
// search degraded to lexical).
export interface SemanticSearchResult extends SearchResult {
  semanticSymbol?: string;
}

// RRF-fused semantic + lexical search. The two rankings live on incomparable
// scales (BM25 score vs integer dot product), so we fuse by RANK via the shared
// `rrf` helper (k=60) rather than any linear score blend. Deterministic end to
// end: lexical is deterministic, the semantic ranking sorts by exact integer dot
// (ties broken by path), and the fused list sorts by RRF score (ties by path).
//
// DEGRADATION: with no model, no index, or an empty index, this returns the pure
// lexical ranking unchanged (as SemanticSearchResult[] with no `semanticSymbol`)
// — the caller stays on exit 0 and simply prints a note.
export function searchSemantic(
  scan: RepoScan,
  query: string,
  index: EmbeddingIndex | undefined,
  opts: SemanticSearchOptions = {},
): SemanticSearchResult[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // Pull a deeper lexical list than the final limit so RRF has enough overlap to
  // fuse meaningfully, then trim after fusion.
  const lexical = searchIndex(scan, query, { limit: Math.max(limit, 50), fuzzy: opts.fuzzy });

  if (!opts.model || !index || index.records.length === 0) {
    return lexical.slice(0, limit); // pure-lexical degradation
  }

  const q = encode(opts.model, query);
  // Best (highest integer dot) record per file, remembering its symbol.
  const bestByFile = new Map<string, { score: number; symbol?: string }>();
  for (const r of index.records) {
    const dot = intDot(q, r.vec);
    const prev = bestByFile.get(r.file);
    if (!prev || dot > prev.score) bestByFile.set(r.file, { score: dot, symbol: r.symbol });
  }

  // Semantic ranked file list: positive similarity only, best-first, ties by path.
  const semList = [...bestByFile.entries()]
    .filter(([, v]) => v.score > 0)
    .sort((a, b) => b[1].score - a[1].score || byStr(a[0], b[0]))
    .map(([file]) => file);
  const lexList = lexical.map((r) => r.file);

  // Fuse the two ranked lists (identity keyOf — items are already file paths).
  const fused = rrf<string>([lexList, semList], (f) => f, opts.rrfK ?? RRF_K);

  const lexByFile = new Map(lexical.map((r) => [r.file, r] as const));
  const results: SemanticSearchResult[] = [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))
    .map(([file, score]) => {
      const lex = lexByFile.get(file);
      const res: SemanticSearchResult = {
        file,
        score: Number(score.toFixed(4)),
        matchedTerms: lex?.matchedTerms ?? [],
        topSymbols: lex?.topSymbols ?? [],
      };
      const sem = bestByFile.get(file);
      if (sem?.symbol) res.semanticSymbol = sem.symbol;
      if (lex?.fuzzyTerms) res.fuzzyTerms = lex.fuzzyTerms;
      return res;
    });
  return results.slice(0, limit);
}

export { DEFAULT_LIMIT as SEMANTIC_DEFAULT_LIMIT };
