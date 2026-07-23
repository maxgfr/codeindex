import { foldText } from "../util.js";
import type { StaticEmbedModel } from "./model.js";

// The pure-JS deterministic encoder — the reason this whole tier can produce
// goldens. Every step is chosen to be byte-identical on any platform:
//   1. tokenize  : foldText (NFKD, strip combining marks) + camelCase/ACRONYM
//                  split + lowercase + split on non-alphanumeric runs.
//   2. wordpiece : greedy longest-match against the model vocab, with BERT-style
//                  "##" continuation pieces; an unsplittable word → the UNK row
//                  (or nothing when the model has no UNK).
//   3. gather    : look up each token's row (double precision).
//   4. mean-pool : sum rows in FIXED token order, divide by token count. IEEE-754
//                  double add/div is deterministic for a fixed evaluation order.
//   5. L2-norm   : divide by sqrt(Σ v²) — sqrt is correctly-rounded per IEEE-754,
//                  so identical across engines.
//   6. quantize  : multiply the unit vector by 127, round-half-to-EVEN (NOT
//                  Math.round, which is half-up), clamp to [-127, 127] → int8.
// The fixed 1/127 scale means ranking is a PURE INTEGER dot product (no per-vector
// float scale to store or multiply): for a fixed query every corpus vector shares
// the same scale, so the integer dot Σ q·c is monotonic with the cosine estimate.

const QUANT = 127;

// Split raw text into lowercase, diacritic-folded alphanumeric words. camelCase
// and ACRONYMWord boundaries become spaces FIRST (so "verifyAuthToken" exposes
// "verify","auth","token" as separate words to wordpiece), then any
// non-alphanumeric run splits. Mirrors the boundary rules bm25 `subtokens` uses,
// keeping the two search tiers tokenizing code identifiers alike.
export function basicTokenize(text: string): string[] {
  const spaced = foldText(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out: string[] = [];
  for (const part of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part) out.push(part);
  }
  return out;
}

// Greedy longest-match wordpiece for ONE word. The first piece is looked up as
// written; every subsequent piece is looked up with a "##" prefix. If no piece
// matches at some position the whole word is unresolvable → [unkId] (or [] when
// the model has no UNK row). Deterministic: longest-match is a fixed scan.
export function wordpiece(word: string, model: StaticEmbedModel): number[] {
  if (!word) return [];
  const ids: number[] = [];
  let start = 0;
  const n = word.length;
  while (start < n) {
    let end = n;
    let match = -1;
    while (end > start) {
      const piece = start === 0 ? word.slice(start, end) : "##" + word.slice(start, end);
      const id = model.vocab.get(piece);
      if (id !== undefined) {
        match = id;
        break;
      }
      end--;
    }
    if (match === -1) return model.unkId >= 0 ? [model.unkId] : []; // whole word is OOV
    ids.push(match);
    start = end;
  }
  return ids;
}

// Full token-id sequence for a text: tokenize → wordpiece each word, concatenated
// in order. The order is load-bearing for determinism, but mean-pooling is
// order-independent anyway; the fixed order simply makes reasoning trivial.
export function tokenize(text: string, model: StaticEmbedModel): number[] {
  const ids: number[] = [];
  for (const word of basicTokenize(text)) {
    for (const id of wordpiece(word, model)) ids.push(id);
  }
  return ids;
}

// Round half to EVEN (banker's rounding). JS `Math.round` rounds half toward
// +∞, which is not symmetric and would bias quantization; half-to-even is the
// IEEE-754 default and keeps quantize(x) === -quantize(-x).
export function roundHalfToEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1; // exactly .5 → nearest even
}

// Encode a text to an int8 unit-ish vector. Empty / all-OOV / zero-norm inputs
// yield an all-zero vector (dot-products against it are 0 — it simply ranks
// last), never NaN. Pure and deterministic: same model + text → same bytes.
export function encode(model: StaticEmbedModel, text: string): Int8Array {
  const { dim, weights } = model;
  const out = new Int8Array(dim);
  const ids = tokenize(text, model);
  if (ids.length === 0) return out;

  // mean-pool in double precision, fixed order.
  const pooled = new Float64Array(dim);
  for (const id of ids) {
    const base = id * dim;
    for (let d = 0; d < dim; d++) pooled[d]! += weights[base + d]!;
  }
  const inv = 1 / ids.length;
  for (let d = 0; d < dim; d++) pooled[d]! *= inv;

  // L2-normalize.
  let sumsq = 0;
  for (let d = 0; d < dim; d++) sumsq += pooled[d]! * pooled[d]!;
  const norm = Math.sqrt(sumsq);
  if (norm === 0) return out; // zero vector — nothing to rank on

  // quantize to int8 at the fixed 1/127 scale, round-half-to-even, clamp.
  for (let d = 0; d < dim; d++) {
    let q = roundHalfToEven((pooled[d]! / norm) * QUANT);
    if (q > QUANT) q = QUANT;
    else if (q < -QUANT) q = -QUANT;
    out[d] = q;
  }
  return out;
}

// Integer dot product of two int8 vectors (the ranking primitive). Widened to a
// JS number (double), but every operand and partial sum is an exact integer
// (max |Σ| for dim 512 ≈ 512·127² ≈ 8.3M, far inside 2⁵³) — so this is an EXACT
// integer computation, deterministic everywhere.
export function intDot(a: Int8Array, b: Int8Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}
