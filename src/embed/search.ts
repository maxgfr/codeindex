import type { RepoScan } from "../scan.js";
import { rrf } from "../util.js";
import { byStr } from "../sort.js";
import { explainQuery, type QueryExplanation, type SearchOptions, type SearchResult } from "../bm25.js";
import { encode, intDot } from "./encode.js";
import type { EmbeddingIndex } from "./index.js";
import type { StaticEmbedModel } from "./model.js";

const DEFAULT_LIMIT = 20;
const RRF_K = 60; // reuse the engine-wide RRF damping constant

export interface SemanticSearchOptions extends SearchOptions {
  // The loaded static model, needed to encode the QUERY into the same int8 space
  // as the corpus. Absent → the search degrades to pure lexical (no throw).
  model?: StaticEmbedModel;
  // A pre-encoded int8 query vector — the endpoint tier's escape hatch: it has
  // no local model but has already quantized the endpoint's float query vector
  // through the SAME pipeline as the corpus. Wins over `model` when both are set.
  queryVec?: Int8Array;
  // RRF damping (default 60), exposed for parity with the shared rrf helper.
  rrfK?: number;
}

// A fused result. Extends the lexical SearchResult additively: `semanticSymbol`
// is the corpus symbol whose embedding was closest to the query for this file
// (absent when the file was contributed only by the lexical side, or when the
// search degraded to lexical). A file the lexical side also ranked keeps every
// lexical field (matchedFields, line, symbolHits, fuzzyTerms, bridgedOnly), so
// --semantic answers are as navigable as plain ones; a file only the embedding
// side found carries the `line` of its closest symbol.
export interface SemanticSearchResult extends SearchResult {
  semanticSymbol?: string;
}

// The lexical diagnosis, restated for the fused list. The lexical explanation
// alone would describe rows the user never sees ("No file matches" above three
// embedding hits): its term facts (df, bridges, the whole identifier) are about
// the corpus and stay, but the verdict, the counts and the note are recomputed
// from what the fused list actually holds.
export interface SemanticQueryExplanation extends QueryExplanation {
  /** Rows only the embedding side found — no lexical match at all. */
  semanticOnlyResults: number;
}

export interface ExplainedSemanticSearch {
  results: SemanticSearchResult[];
  explain: QueryExplanation | SemanticQueryExplanation;
}

// RRF-fused semantic + lexical search. The two rankings live on incomparable
// scales (BM25 score vs integer dot product), so we fuse by RANK via the shared
// `rrf` helper (k=60) rather than any linear score blend. Deterministic end to
// end: lexical is deterministic, the semantic ranking sorts by exact integer dot
// (ties broken by path), and the fused list sorts by RRF score (ties by path).
//
// The lexical side honours every lexical option: `exact` drops its bridged-only
// rows (so none can reach the fused list through it) and `rank` applies its
// prior. The embedding side has no notion of either — a file it contributes on
// its own has no lexical match to be exact about, and is labelled by
// `semanticSymbol` and an empty `matchedTerms` instead.
//
// DEGRADATION: with no model, no index, or an empty index, this returns the pure
// lexical ranking and explanation unchanged — exactly explainQuery's — so the
// caller stays on exit 0 and simply prints a note.
export function explainSemantic(
  scan: RepoScan,
  query: string,
  index: EmbeddingIndex | undefined,
  opts: SemanticSearchOptions = {},
): ExplainedSemanticSearch {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const lexOpts: SearchOptions = {
    ...(opts.fuzzy !== undefined ? { fuzzy: opts.fuzzy } : {}),
    ...(opts.exact ? { exact: true } : {}),
    ...(opts.rank ? { rank: opts.rank } : {}),
  };
  // Resolve the query vector: an already-encoded one (endpoint tier) wins;
  // otherwise encode via the local model. No vector, no index, or an empty index
  // → pure-lexical degradation.
  const q = opts.queryVec ?? (opts.model ? encode(opts.model, query) : undefined);
  if (!q || !index || index.records.length === 0) {
    return explainQuery(scan, query, { ...lexOpts, limit });
  }
  // Pull a deeper lexical list than the final limit so RRF has enough overlap to
  // fuse meaningfully, then trim after fusion. This is the ONE lexical scoring
  // pass: its explanation feeds the fused one below.
  const lexical = explainQuery(scan, query, { ...lexOpts, limit: Math.max(limit, 50) });

  // Best (highest integer dot) record per file, remembering its symbol.
  const bestByFile = new Map<string, { score: number; symbol?: string; line?: number }>();
  for (const r of index.records) {
    const dot = intDot(q, r.vec);
    const prev = bestByFile.get(r.file);
    if (!prev || dot > prev.score) bestByFile.set(r.file, { score: dot, symbol: r.symbol, line: r.line });
  }

  // Semantic ranked file list: positive similarity only, best-first, ties by path.
  const semList = [...bestByFile.entries()]
    .filter(([, v]) => v.score > 0)
    .sort((a, b) => b[1].score - a[1].score || byStr(a[0], b[0]))
    .map(([file]) => file);
  const lexList = lexical.results.map((r) => r.file);

  // Fuse the two ranked lists (identity keyOf — items are already file paths).
  const fused = rrf<string>([lexList, semList], (f) => f, opts.rrfK ?? RRF_K);

  const lexByFile = new Map(lexical.results.map((r) => [r.file, r] as const));
  const results: SemanticSearchResult[] = [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))
    .slice(0, limit)
    .map(([file, score]) => {
      const lex = lexByFile.get(file);
      const sem = bestByFile.get(file);
      // Spreading the lexical row keeps its field order; `score` is replaced
      // in place by the fused one.
      const res: SemanticSearchResult = lex
        ? { ...lex, score: Number(score.toFixed(4)) }
        : { file, score: Number(score.toFixed(4)), matchedTerms: [], topSymbols: [], ...(sem?.line ? { line: sem.line } : {}) };
      if (sem?.symbol) res.semanticSymbol = sem.symbol;
      return res;
    });
  return { results, explain: explainFused(lexical.explain, results, lexByFile) };
}

// searchSemantic is explainSemantic without the diagnosis — the historical API.
export function searchSemantic(
  scan: RepoScan,
  query: string,
  index: EmbeddingIndex | undefined,
  opts: SemanticSearchOptions = {},
): SemanticSearchResult[] {
  return explainSemantic(scan, query, index, opts).results;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Recompute verdict, counts and note for the rows the fused list kept. The
// verdict keeps its lexical meaning — "does the tree contain what was typed" —
// so an answer carried by the embedding side alone is `weak`, never `match`:
// similarity is a lead, not proof the identifier exists.
function explainFused(
  lex: QueryExplanation,
  results: SemanticSearchResult[],
  lexByFile: Map<string, SearchResult>,
): SemanticQueryExplanation {
  const semanticOnly = results.filter((r) => !lexByFile.has(r.file)).length;
  const bridged = results.filter((r) => r.bridgedOnly).length;
  const literal = results.length - semanticOnly - bridged;
  const missing = lex.wholeIdentifier?.df === 0 ? lex.wholeIdentifier.term : undefined;

  const { note: _lexNote, ...facts } = lex;
  const explain: SemanticQueryExplanation = {
    ...facts,
    verdict: !results.length ? "none" : missing !== undefined || literal === 0 ? "weak" : "match",
    bridgedOnlyResults: bridged,
    resultCount: results.length,
    semanticOnlyResults: semanticOnly,
  };
  if (!results.length) {
    // Nothing on either side, so the lexical sentence ("No file matches…") is
    // exactly right.
    if (lex.note) explain.note = lex.note;
    return explain;
  }
  if (explain.verdict === "match") return explain;

  // What the rows below actually are, by provenance.
  const parts: string[] = [];
  if (literal) {
    const on = lex.terms.filter((t) => t.df > 0 && t.term !== missing).map((t) => t.term);
    parts.push(`${plural(literal, "lexical match", "lexical matches")}${missing && on.length ? ` on its parts (${on.join(", ")})` : ""}`);
  }
  if (bridged) {
    const spelled = lex.terms
      .filter((t) => t.bridge)
      .map((t) => `"${t.term}" → ${t.bridge!.to.join(", ")}`)
      .join("; ");
    parts.push(`${plural(bridged, "near match", "near matches")}${spelled ? ` (${spelled})` : ""}`);
  }
  if (semanticOnly) parts.push(`${plural(semanticOnly, "embedding neighbour", "embedding neighbours")} with no lexical match (see semanticSymbol)`);
  const rows = `The ${plural(results.length, "result", "results")} below: ${parts.join("; ")}.`;

  if (missing !== undefined) {
    const near = lex.terms.find((t) => t.term === missing)?.bridge?.to ?? [];
    const suggestion = near.length ? ` Closest indexed name${near.length === 1 ? "" : "s"}: ${near.join(", ")}.` : "";
    explain.note = `No file in this index defines or mentions "${missing}". ${rows}${suggestion}`;
  } else {
    const absent = lex.unresolvedTerms;
    const nowhere = absent.length
      ? ` (${absent.length === 1 ? "the term" : "the terms"} ${absent.join(", ")} ${absent.length === 1 ? "appears" : "appear"} nowhere in this index)`
      : "";
    explain.note = `Nothing matched the query verbatim${nowhere}. ${rows}`;
  }
  return explain;
}

export { DEFAULT_LIMIT as SEMANTIC_DEFAULT_LIMIT };
