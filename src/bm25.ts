// Keyless lexical search (issue #4): BM25 ranking over deterministic per-file
// documents, so "where is auth handled?"-style questions get a ranked answer
// with ZERO API keys — no embeddings, no network, no model. Each file's
// document is built from its symbol names (split into camelCase/snake_case
// subtokens, originals kept), its path segments, its markdown headings, and its
// one-line summary/doc-comment. Scoring is textbook BM25 (k1=1.2, b=0.75) with
// a non-negative Robertson idf; both sides fold diacritics (util foldText) and
// the query reuses util keywords, so query and haystack always tokenize alike.
// Deterministic: files are scored in scan order (sorted by rel), scores are
// fixed to 4 decimal places, and ties break by path.
//
// Trigram fuzzy fallback (v2.9.0): a query term that matches NOTHING in the
// corpus (document frequency == 0 — checked STRICTLY, so any term that
// already matches anywhere is never touched) is expanded against the corpus
// vocabulary via character-trigram Dice similarity (threshold 0.6, top-3
// candidates, deterministic tie-break). This keeps every currently-matching
// query byte-identical: the expansion only ever engages on terms that would
// otherwise contribute nothing.
import type { RepoScan } from "./scan.js";
import { foldText, keywords } from "./util.js";
import { byStr } from "./sort.js";

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 20;
const TOP_SYMBOLS = 5;
const FUZZY_DICE_THRESHOLD = 0.6;
const FUZZY_CAP = 3;

export interface SearchOptions {
  // Maximum results returned (default 20).
  limit?: number;
  // Trigram fuzzy fallback for query terms with zero document frequency
  // (default true). Safe as an always-on default: the df==0 gate means it
  // only ever engages on terms that would otherwise match nothing, so a
  // query where every term already hits is completely unaffected.
  fuzzy?: boolean;
}

export interface SearchResult {
  file: string; // repo-relative path
  score: number; // BM25 score, fixed to 4 decimal places
  matchedTerms: string[]; // query tokens present in this file's document, sorted
  topSymbols: string[]; // symbols whose name matches the most query tokens (cap 5)
  // Query terms (df==0) resolved via trigram fuzzy fallback that contributed
  // to this result, sorted. Present only when >=1 term used the fallback —
  // purely additive, never present for an all-exact-match result.
  fuzzyTerms?: string[];
}

// Split an identifier/phrase into lowercase, diacritic-folded subtokens:
// camelCase and ACRONYMWord boundaries become spaces, then any non-alphanumeric
// run splits (snake_case, kebab-case, dots, prose whitespace). The ORIGINAL
// token (lowercased) is kept alongside its parts so an exact identifier query
// ("HttpClient") still matches a compound definition. 1-char fragments are
// dropped as noise; letter↔digit runs stay together ("sha1", "bm25").
export function subtokens(raw: string): string[] {
  const folded = foldText(raw)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string): void => {
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  // The whole identifier (lowercased) is a term of its own — but only for
  // single tokens: gluing a prose heading into one mega-token would index junk.
  if (!/\s/.test(raw.trim())) push(foldText(raw).toLowerCase().replace(/[^a-z0-9_]+/g, ""));
  for (const part of folded.split(/[^A-Za-z0-9]+/)) push(part.toLowerCase());
  return out;
}

interface Doc {
  file: string;
  tf: Map<string, number>;
  len: number; // total token occurrences (the BM25 length normalizer)
  symbols: string[]; // deduped symbol names, declaration order
}

function addTerms(doc: Doc, text: string): void {
  for (const t of subtokens(text)) {
    doc.tf.set(t, (doc.tf.get(t) ?? 0) + 1);
    doc.len++;
  }
}

function buildDocs(scan: RepoScan): Doc[] {
  const docs: Doc[] = [];
  for (const f of scan.files) {
    const doc: Doc = { file: f.rel, tf: new Map(), len: 0, symbols: [] };
    const seenSym = new Set<string>();
    for (const s of f.symbols) {
      addTerms(doc, s.name);
      if (!seenSym.has(s.name)) {
        seenSym.add(s.name);
        doc.symbols.push(s.name);
      }
    }
    for (const seg of f.rel.split("/")) addTerms(doc, seg);
    for (const h of f.headings) addTerms(doc, h);
    if (f.summary) addTerms(doc, f.summary);
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

// Trigram index of the corpus vocabulary: every distinct doc token mapped to
// its trigram set. Built LAZILY by searchIndex — only when >=1 query term has
// df==0 — so a fully-matched query never pays this cost.
function buildTrigramIndex(docs: Doc[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const d of docs) {
    for (const term of d.tf.keys()) {
      if (!index.has(term)) index.set(term, charTrigrams(term));
    }
  }
  return index;
}

// Rank the scanned files against a natural-language (or identifier) query.
// Pure and deterministic: same scan + query → the same results, byte-for-byte.
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

  const docs = buildDocs(scan);
  const n = docs.length;
  if (!n) return [];
  let totalLen = 0;
  for (const d of docs) totalLen += d.len;
  const avgLen = totalLen / n || 1;

  // Document frequency per query term, for idf.
  const df = new Map<string, number>();
  for (const t of terms) {
    let count = 0;
    for (const d of docs) if (d.tf.has(t)) count++;
    df.set(t, count);
  }

  // Fuzzy fallback: STRICT df==0 gate — a term that matches anywhere, even
  // once, is never expanded. The trigram index of the corpus vocabulary is
  // built lazily, only when at least one term needs it, so a fully-matched
  // query (the common case) pays zero extra cost and stays byte-identical.
  const fuzzyEnabled = opts.fuzzy ?? true;
  const fuzzyCandidates = new Map<string, { term: string; dice: number }[]>();
  if (fuzzyEnabled) {
    const unmatched = terms.filter((t) => df.get(t) === 0);
    if (unmatched.length) {
      const trigramIndex = buildTrigramIndex(docs);
      for (const t of unmatched) {
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
  // df cache for expanded vocab terms (distinct from query-term df above).
  const vocabDf = new Map<string, number>();
  const dfOfVocabTerm = (term: string): number => {
    const known = df.get(term) ?? vocabDf.get(term);
    if (known !== undefined) return known;
    let count = 0;
    for (const d of docs) if (d.tf.has(term)) count++;
    vocabDf.set(term, count);
    return count;
  };

  const results: SearchResult[] = [];
  for (const d of docs) {
    let score = 0;
    const matched: string[] = [];
    const symbolTerms = new Set<string>(); // matched ∪ fuzzy-expanded vocab terms, for topSymbols ranking
    const fuzzyHit = new Set<string>(); // original query terms resolved via fuzzy fallback, for this doc
    for (const t of terms) {
      const tf = d.tf.get(t);
      if (tf) {
        matched.push(t);
        symbolTerms.add(t);
        const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * d.len) / avgLen));
        continue;
      }
      // Only ever reached for a term with df==0 (or absent from THIS doc but
      // matched elsewhere — fuzzyCandidates has no entry for those, so the
      // lookup below is a no-op and behavior is identical to before v2.9.0).
      const candidates = fuzzyCandidates.get(t);
      if (!candidates) continue;
      for (const cand of candidates) {
        const ctf = d.tf.get(cand.term);
        if (!ctf) continue;
        const cdf = dfOfVocabTerm(cand.term);
        const idf = Math.log(1 + (n - cdf + 0.5) / (cdf + 0.5));
        const contribution = (idf * (ctf * (K1 + 1))) / (ctf + K1 * (1 - B + (B * d.len) / avgLen));
        score += contribution * cand.dice; // near-miss always scores below an exact hit (dice < 1)
        symbolTerms.add(cand.term);
        fuzzyHit.add(t);
      }
    }
    if (!matched.length && !fuzzyHit.size) continue;

    // Symbols ranked by how many query tokens (exact or fuzzy-expanded) their
    // name carries, then by name.
    const scored = d.symbols
      .map((name) => {
        const toks = new Set(subtokens(name));
        let hits = 0;
        for (const t of symbolTerms) if (toks.has(t)) hits++;
        return { name, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || byStr(a.name, b.name));

    const result: SearchResult = {
      file: d.file,
      score: Number(score.toFixed(4)),
      matchedTerms: matched.sort(byStr),
      topSymbols: scored.slice(0, TOP_SYMBOLS).map((s) => s.name),
    };
    if (fuzzyHit.size) result.fuzzyTerms = [...fuzzyHit].sort(byStr);
    results.push(result);
  }

  // Rounded score first (so 4-dp ties resolve stably), then path.
  results.sort((a, b) => b.score - a.score || byStr(a.file, b.file));
  return results.slice(0, opts.limit ?? DEFAULT_LIMIT);
}
