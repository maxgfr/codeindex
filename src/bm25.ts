// Keyless lexical search: BM25F ranking over deterministic per-file documents, so
// "where is auth handled?"-style questions get a ranked answer with ZERO API keys
// — no embeddings, no network, no model.
//
// WHY BM25F AND NOT BM25. The original document was symbol names + path segments
// + markdown headings + a one-line summary. That is a perfectly scored index of
// the wrong text: the words people search with are overwhelmingly in PROSE, and
// prose was not in it. Measured against relevance judgements (tests/quality),
// 6 of 16 queries returned nothing relevant at all — not ranked low, absent —
// including "where is rate limiting handled" against a file whose header comment
// says exactly that.
//
// So a document is now six FIELDS, each with its own weight and length
// normalisation (the standard BM25F formulation: per-field normalised term
// frequencies summed, then one saturation):
//
//   name     symbol names, subtokenized     — what the code calls itself
//   path     path segments                  — how it is filed
//   heading  markdown headings              — how docs organise it
//   summary  the file's top doc comment     — what the file says it is
//   doc      per-symbol doc comments        — what each declaration says it does
//   body     comment + short-literal words  — everything else the author wrote
//
// `doc` and `body` are the new ones, and they are why the misses above resolve.
// Field weights are not guesses: they are calibrated against nDCG@10 on the
// judged corpus, and the ratchet in tests/quality.test.ts fails if a change
// makes ranking worse.
//
// Deterministic: files are scored in scan order (sorted by rel), scores are fixed
// to 4 decimal places, and ties break by path.
//
// Trigram fuzzy fallback: a query term that matches NOTHING in the corpus
// (document frequency == 0 — checked STRICTLY, so any term that already matches
// anywhere is never touched) is expanded against the corpus vocabulary via
// character-trigram Dice similarity (threshold 0.6, top-3 candidates,
// deterministic tie-break).
import type { RepoScan } from "./scan.js";
// derived.ts imports this module's builders while this module imports its
// accessors: a function-level cycle only (no module-evaluation-time cross-call),
// which Node ESM and esbuild both resolve safely — the same arrangement
// callers.ts and complexity.ts already use.
import { bm25DocsFor, bm25StemsFor, bm25TrigramsFor, importPagerankFor } from "./derived.js";
import { foldText, keywords, stemOf, subtokens } from "./util.js";
import { isTestPath } from "./tests-map.js";
import { byStr } from "./sort.js";

// Re-exported so the public barrel keeps exporting `subtokens` from here, where
// consumers have always imported it; the implementation moved to util.ts so
// EXTRACTION can share it without a module cycle through derived.ts.
export { subtokens };

const K1 = 1.2;
const DEFAULT_LIMIT = 20;
const TOP_SYMBOLS = 5;
const FUZZY_DICE_THRESHOLD = 0.6;
const FUZZY_CAP = 3;
// A morphological match ("caching" → "cache") is the SAME word, not a near miss,
// so it scores almost in full — just under an exact hit, so a file containing the
// literal query term still wins.
const STEM_WEIGHT = 0.9;

export const FIELDS = ["name", "path", "heading", "summary", "doc", "body"] as const;
export type Field = (typeof FIELDS)[number];

// Per-field weight and length-normalisation strength. Calibrated on the judged
// corpus (tests/quality/search-cases.json), not chosen by taste:
//
//   name  highest — an exact identifier match is the strongest signal there is
//   path  high    — directory names are curated vocabulary ("auth/", "billing/")
//   doc   above summary: a declaration's own comment is more specific than the
//         file's one-liner, and it is what an agent reads next
//   body  lowest  — the widest and noisiest field, so it breaks ties and
//         rescues queries the narrow fields cannot answer, without dominating
//
// `b` is lower for `body` because its length varies by an order of magnitude
// across files and full normalisation would over-punish a thoroughly commented
// module for being thorough.
const FIELD_WEIGHT: Record<Field, number> = { name: 3, path: 2, heading: 1.5, summary: 1.5, doc: 1.6, body: 0.7 };
const FIELD_B: Record<Field, number> = { name: 0.75, path: 0.75, heading: 0.75, summary: 0.75, doc: 0.75, body: 0.4 };

// A hit whose whole identifier IS a query term ("signPayload") outranks one that
// merely shares a subtoken ("sign"). Multiplicative and modest: it reorders
// near-ties without overriding the field model.
const EXACT_NAME_BOOST = 1.35;

// Tests are indexed and findable, but a query about a topic wants the code, not
// its test — unless the query says otherwise. Applied only when the query itself
// carries no test-ish term.
const TEST_DEMOTION = 0.65;
const TEST_INTENT = /^(test|tests|spec|specs|fixture|fixtures|mock|mocks|stub|stubs)$/;

export type RankMode = "graph" | "lexical";

export interface SearchOptions {
  // Maximum results returned (default 20).
  limit?: number;
  // Trigram fuzzy fallback for query terms with zero document frequency
  // (default true). Safe as an always-on default: the df==0 gate means it
  // only ever engages on terms that would otherwise match nothing, so a
  // query where every term already hits is completely unaffected.
  fuzzy?: boolean;
  // "graph" multiplies the lexical score by a structural prior — the file's
  // PageRank over the resolved import graph — so that among comparably worded
  // files the one the repo actually depends on ranks first.
  //
  // The DEFAULT is "lexical", deliberately. On the judged corpus the prior
  // changes nothing (MRR/nDCG/recall identical either way), because that corpus
  // is small and flat, while enabling it costs a full import-resolution pass on
  // every query. An unmeasured multiplier with a real cost is not a good
  // default for an engine whose claim is measured quality — so it is offered,
  // documented as unproven, and left off until someone measures it on a corpus
  // where centrality can actually discriminate.
  rank?: RankMode;
}

/** A specific declaration a result matched, so a caller can jump straight to it. */
export interface SymbolHit {
  name: string;
  kind: string;
  line: number;
}

export interface SearchResult {
  file: string; // repo-relative path
  score: number; // BM25F score, fixed to 4 decimal places
  matchedTerms: string[]; // query tokens present in this file's document, sorted
  topSymbols: string[]; // symbols whose name matches the most query tokens (cap 5)
  // Which FIELDS carried the match, sorted — the difference between "the path
  // says auth" and "a doc comment explains the auth flow", which a bare score
  // cannot express.
  matchedFields?: Field[];
  // The best line to open: the matched declaration nearest the top of the file.
  // Absent when nothing but path/prose matched, since there is no declaration
  // to point at.
  line?: number;
  // Matched declarations with their kind and line (cap 5) — `topSymbols` with
  // the coordinates an agent needs, kept as a separate field so the existing
  // string array stays exactly as it was.
  symbolHits?: SymbolHit[];
  // Query terms (df==0) resolved via trigram fuzzy fallback that contributed
  // to this result, sorted. Present only when >=1 term used the fallback —
  // purely additive, never present for an all-exact-match result.
  fuzzyTerms?: string[];
}

interface FieldDoc {
  tf: Map<string, number>;
  len: number;
}

// Exported for src/derived.ts's per-scan cache only — NOT part of the public
// barrel (engine.ts). searchIndex reads docs strictly, never mutates them, so
// the cached array/objects can be shared across calls on the same scan.
export interface Doc {
  file: string;
  fields: Record<Field, FieldDoc>;
  /** Union of every field's terms — the document frequency unit. */
  all: Set<string>;
  symbols: string[]; // deduped symbol names, declaration order
  /** Declaration coordinates, for symbol-level anchors. */
  decls: SymbolHit[];
  /** Lowercased whole symbol names, for the exact-match boost. */
  exactNames: Set<string>;
  isTest: boolean;
}

function addTerms(doc: Doc, field: Field, text: string): void {
  const f = doc.fields[field];
  for (const t of subtokens(text)) {
    f.tf.set(t, (f.tf.get(t) ?? 0) + 1);
    f.len++;
    doc.all.add(t);
  }
}

function emptyFields(): Record<Field, FieldDoc> {
  const out = {} as Record<Field, FieldDoc>;
  for (const f of FIELDS) out[f] = { tf: new Map(), len: 0 };
  return out;
}

// Exported for src/derived.ts (bm25DocsFor) — not in the public barrel.
export function buildDocs(scan: RepoScan): Doc[] {
  const docs: Doc[] = [];
  for (const f of scan.files) {
    const doc: Doc = {
      file: f.rel,
      fields: emptyFields(),
      all: new Set(),
      symbols: [],
      decls: [],
      exactNames: new Set(),
      isTest: isTestPath(f.rel),
    };
    const seenSym = new Set<string>();
    for (const s of f.symbols) {
      addTerms(doc, "name", s.name);
      if (s.doc) addTerms(doc, "doc", s.doc);
      doc.exactNames.add(foldText(s.name).toLowerCase());
      if (!seenSym.has(s.name)) {
        seenSym.add(s.name);
        doc.symbols.push(s.name);
        doc.decls.push({ name: s.name, kind: s.kind, line: s.line });
      }
    }
    for (const seg of f.rel.split("/")) addTerms(doc, "path", seg);
    for (const h of f.headings) addTerms(doc, "heading", h);
    if (f.summary) addTerms(doc, "summary", f.summary);
    // Already subtokenized at extraction time; adding them through the same
    // splitter is idempotent and keeps one tokenisation path.
    for (const t of f.terms ?? []) addTerms(doc, "body", t);
    docs.push(doc);
  }
  return docs;
}

// Character trigrams of a token, padded with two boundary sentinels on each
// side (pg_trgm-style: "^^t…m$$") so short prefix/suffix runs still produce
// shared grams. Deduplicated into a Set — a repeated gram doesn't inflate
// Dice similarity.
export function charTrigrams(term: string): Set<string> {
  const padded = `^^${term}$$`;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

// Dice coefficient between two trigram sets: 2|A∩B| / (|A|+|B|). 0 when
// either side is empty (no divide-by-zero).
export function diceCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

// Corpus vocabulary grouped by stem: stem → the vocab terms that reduce to it,
// sorted. Exported for src/derived.ts (bm25StemsFor) — not in the public barrel.
export function buildStemIndex(docs: Doc[]): Map<string, string[]> {
  const seen = new Set<string>();
  const index = new Map<string, string[]>();
  for (const d of docs) {
    for (const term of d.all) {
      if (seen.has(term)) continue;
      seen.add(term);
      const stem = stemOf(term);
      if (stem === term) continue; // an unchanged stem adds no new bridge
      let arr = index.get(stem);
      if (!arr) index.set(stem, (arr = []));
      arr.push(term);
    }
  }
  for (const arr of index.values()) arr.sort(byStr);
  return index;
}

// Trigram index of the corpus vocabulary: every distinct doc token mapped to
// its trigram set. Built LAZILY by searchIndex — only when >=1 query term has
// df==0 — so a fully-matched query never pays this cost. Exported for
// src/derived.ts (bm25TrigramsFor) — not in the public barrel.
export function buildTrigramIndex(docs: Doc[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const d of docs) {
    for (const term of d.all) {
      if (!index.has(term)) index.set(term, charTrigrams(term));
    }
  }
  return index;
}

/**
 * Rank the scanned files against a natural-language (or identifier) query.
 * Pure and deterministic: same scan + query + options → the same results,
 * byte-for-byte.
 */
export function searchIndex(scan: RepoScan, query: string, opts: SearchOptions = {}): SearchResult[] {
  // Query tokens: util keywords (stopwords dropped, identifiers kept) expanded
  // through the SAME subtoken splitter the documents use.
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const kw of keywords(query)) {
    for (const t of subtokens(kw)) {
      if (seen.has(t)) continue;
      seen.add(t);
      terms.push(t);
    }
  }
  if (!terms.length) return [];
  const queryWantsTests = terms.some((t) => TEST_INTENT.test(t));

  // Memoized per scan (src/derived.ts) — identical docs to a direct build;
  // read-only from here on.
  const docs = bm25DocsFor(scan);
  const n = docs.length;
  if (!n) return [];

  // Per-field average length, the BM25F normaliser.
  const avgLen = {} as Record<Field, number>;
  for (const f of FIELDS) {
    let total = 0;
    for (const d of docs) total += d.fields[f].len;
    avgLen[f] = total / n || 1;
  }

  // Document frequency per query term, over the union of fields.
  const df = new Map<string, number>();
  for (const t of terms) {
    let count = 0;
    for (const d of docs) if (d.all.has(t)) count++;
    df.set(t, count);
  }

  // Fuzzy fallback: STRICT df==0 gate — a term that matches anywhere, even
  // once, is never expanded. The trigram index of the corpus vocabulary is
  // built lazily, only when at least one term needs it.
  const fuzzyEnabled = opts.fuzzy ?? true;
  const fuzzyCandidates = new Map<string, { term: string; dice: number }[]>();
  if (fuzzyEnabled) {
    const unmatched = terms.filter((t) => df.get(t) === 0);
    if (unmatched.length) {
      // MORPHOLOGY FIRST. A term that matches nothing is far more often an
      // inflection than a typo ("caching" for "cache", "retries" for "retry"),
      // and a stem match is exact where a trigram match is a guess. Only terms
      // the stem index cannot bridge fall through to trigram similarity.
      const stemIndex = bm25StemsFor(scan);
      const stillUnmatched: string[] = [];
      for (const t of unmatched) {
        const viaStem = (stemIndex.get(stemOf(t)) ?? []).filter((v) => v !== t);
        if (viaStem.length) {
          fuzzyCandidates.set(
            t,
            viaStem.slice(0, FUZZY_CAP).map((term) => ({ term, dice: STEM_WEIGHT })),
          );
        } else stillUnmatched.push(t);
      }
      if (stillUnmatched.length) {
        const trigramIndex = bm25TrigramsFor(scan);
        for (const t of stillUnmatched) {
          const grams = charTrigrams(t);
          const candidates: { term: string; dice: number }[] = [];
          for (const [vocabTerm, vocabGrams] of trigramIndex) {
            const dice = diceCoefficient(grams, vocabGrams);
            if (dice >= FUZZY_DICE_THRESHOLD) candidates.push({ term: vocabTerm, dice });
          }
          // Deterministic: similarity desc, then vocab term asc.
          candidates.sort((a, b) => b.dice - a.dice || byStr(a.term, b.term));
          fuzzyCandidates.set(t, candidates.slice(0, FUZZY_CAP));
        }
      }
    }
  }
  // df cache for expanded vocab terms (distinct from query-term df above).
  const vocabDf = new Map<string, number>();
  const dfOfVocabTerm = (term: string): number => {
    const known = df.get(term) ?? vocabDf.get(term);
    if (known !== undefined) return known;
    let count = 0;
    for (const d of docs) if (d.all.has(term)) count++;
    vocabDf.set(term, count);
    return count;
  };

  const idfOf = (docFreq: number): number => Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));

  // Structural prior: a file's PageRank over the resolved import graph. Looked up
  // ONLY in "graph" mode, so "lexical" never pays the import-resolution pass.
  const prior = opts.rank === "graph" ? importPagerankFor(scan) : undefined;

  const results: SearchResult[] = [];
  for (const d of docs) {
    // BM25F: sum each field's length-normalised tf into ONE weighted frequency
    // per term, then saturate once. This is what makes a term in a short, highly
    // weighted field (a symbol name) outrank the same term buried in prose.
    let score = 0;
    const matched: string[] = [];
    const matchedFields = new Set<Field>();
    const symbolTerms = new Set<string>(); // matched ∪ fuzzy-expanded, for topSymbols ranking
    const fuzzyHit = new Set<string>(); // original query terms resolved via fuzzy fallback
    let exact = false;

    const weightedTf = (term: string): number => {
      let wtf = 0;
      for (const f of FIELDS) {
        const fd = d.fields[f];
        const tf = fd.tf.get(term);
        if (!tf) continue;
        matchedFields.add(f);
        const b = FIELD_B[f];
        wtf += (FIELD_WEIGHT[f] * tf) / (1 - b + (b * fd.len) / avgLen[f]);
      }
      return wtf;
    };

    for (const t of terms) {
      const wtf = weightedTf(t);
      if (wtf > 0) {
        matched.push(t);
        symbolTerms.add(t);
        if (d.exactNames.has(t)) exact = true;
        score += idfOf(df.get(t)!) * (wtf / (K1 + wtf));
        continue;
      }
      // Only ever reached for a term with df==0 repo-wide, or one matched
      // elsewhere but absent HERE (no fuzzy entry exists for those, so the
      // lookup below is a no-op).
      for (const cand of fuzzyCandidates.get(t) ?? []) {
        const cwtf = weightedTf(cand.term);
        if (!cwtf) continue;
        // A near miss always scores below an exact hit (dice < 1).
        score += idfOf(dfOfVocabTerm(cand.term)) * (cwtf / (K1 + cwtf)) * cand.dice;
        symbolTerms.add(cand.term);
        fuzzyHit.add(t);
      }
    }
    if (!matched.length && !fuzzyHit.size) continue;

    if (exact) score *= EXACT_NAME_BOOST;
    if (d.isTest && !queryWantsTests) score *= TEST_DEMOTION;
    if (prior) {
      // log1p keeps a hub from swamping a well-worded match: the prior reorders
      // comparable results, it does not decide them.
      score *= 1 + 0.35 * Math.log1p(prior.get(d.file) ?? 0);
    }

    // Symbols ranked by how many query tokens (exact or fuzzy-expanded) their
    // name carries, then by name.
    const scored = d.decls
      .map((decl) => {
        const toks = new Set(subtokens(decl.name));
        let hits = 0;
        for (const t of symbolTerms) if (toks.has(t)) hits++;
        return { decl, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || byStr(a.decl.name, b.decl.name));

    const hits = scored.slice(0, TOP_SYMBOLS).map((s) => s.decl);
    const result: SearchResult = {
      file: d.file,
      score: Number(score.toFixed(4)),
      matchedTerms: matched.sort(byStr),
      topSymbols: hits.map((h) => h.name),
    };
    if (matchedFields.size) result.matchedFields = FIELDS.filter((f) => matchedFields.has(f));
    if (hits.length) {
      result.symbolHits = hits;
      result.line = Math.min(...hits.map((h) => h.line));
    }
    if (fuzzyHit.size) result.fuzzyTerms = [...fuzzyHit].sort(byStr);
    results.push(result);
  }

  // Rounded score first (so 4-dp ties resolve stably), then path.
  results.sort((a, b) => b.score - a.score || byStr(a.file, b.file));
  return results.slice(0, opts.limit ?? DEFAULT_LIMIT);
}
