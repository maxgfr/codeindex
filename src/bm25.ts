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
import type { RepoScan } from "./scan.js";
import { foldText, keywords } from "./util.js";
import { byStr } from "./sort.js";

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 20;
const TOP_SYMBOLS = 5;

export interface SearchOptions {
  // Maximum results returned (default 20).
  limit?: number;
}

export interface SearchResult {
  file: string; // repo-relative path
  score: number; // BM25 score, fixed to 4 decimal places
  matchedTerms: string[]; // query tokens present in this file's document, sorted
  topSymbols: string[]; // symbols whose name matches the most query tokens (cap 5)
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

  const results: SearchResult[] = [];
  for (const d of docs) {
    let score = 0;
    const matched: string[] = [];
    for (const t of terms) {
      const tf = d.tf.get(t);
      if (!tf) continue;
      matched.push(t);
      const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
      score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * d.len) / avgLen));
    }
    if (!matched.length) continue;

    // Symbols ranked by how many query tokens their name carries, then by name.
    const scored = d.symbols
      .map((name) => {
        const toks = new Set(subtokens(name));
        let hits = 0;
        for (const t of matched) if (toks.has(t)) hits++;
        return { name, hits };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || byStr(a.name, b.name));

    results.push({
      file: d.file,
      score: Number(score.toFixed(4)),
      matchedTerms: matched.sort(byStr),
      topSymbols: scored.slice(0, TOP_SYMBOLS).map((s) => s.name),
    });
  }

  // Rounded score first (so 4-dp ties resolve stably), then path.
  results.sort((a, b) => b.score - a.score || byStr(a.file, b.file));
  return results.slice(0, opts.limit ?? DEFAULT_LIMIT);
}
