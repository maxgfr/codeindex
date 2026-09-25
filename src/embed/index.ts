import type { RepoScan } from "../scan.js";
import type { CodeSymbol } from "../types.js";
import { sha1 } from "../hash.js";
import { encode } from "./encode.js";
import { EMBED_VERSION, type StaticEmbedModel } from "./model.js";

// The corpus embedding artifact. Granularity is PER-SYMBOL (each symbol gets its
// own record, so search can surface the exact symbol that matched), with a
// PER-FILE fallback record for files that declare no symbols (docs, config) so
// every file with content is still represented. Deterministic: records follow
// scan order (files sorted by rel) then declaration order within a file.
export interface EmbeddingRecord {
  file: string; // repo-relative path
  symbol?: string; // the declared symbol this vector represents (absent for a file-level record)
  line?: number; // 1-based symbol line (absent for a file-level record)
  // unitHash of the text this vector encodes. It is what lets a later build
  // reuse the vector instead of re-encoding (or, for the endpoint tier,
  // re-POSTing) the same text. Absent only on a hand-built index.
  textHash?: string;
  vec: Int8Array; // length === dim
}

export interface EmbeddingIndex {
  embedVersion: number;
  modelId: string;
  dim: number;
  records: EmbeddingRecord[];
}

// The text encoded for one symbol: its name (camelCase-split by the tokenizer),
// its signature, its own doc comment, the owning file's one-line summary, and
// the file's path segments — the same signal bm25 indexes, but pooled into a
// single vector. Newline-joined so the tokenizer's non-alphanumeric split
// cleanly separates the parts.
//
// The doc comment is the one field that says what a symbol is FOR in words a
// query uses, which is exactly what an embedding can match without sharing a
// token. Without it the tier lost to plain BM25 on every measured set; with it
// (potion-base-8M, MRR over 38/40/16 labelled queries) flask goes 0.7934 →
// 0.8307, gin 0.7500 → 0.7862 and the judged corpus 0.9219 → 0.9583, all now
// above lexical (0.8232, 0.7642, 0.9375).
function symbolText(rel: string, s: CodeSymbol, summary: string | undefined): string {
  return [s.name, s.signature ?? "", s.doc ?? "", summary ?? "", rel.replace(/\//g, " ")].join("\n");
}

// A re-export names a declaration made in another module (`export { x } from
// "./x"`, `export * from`, Python's `from .x import y as y`). The defining
// file already has that symbol's unit; a barrel's copy would only let it
// outrank the definition on the definition's own name. bm25 indexes these as
// prose for the same reason.
const REEXPORT_KINDS = new Set(["reexport", "reexport-all"]);

// A file-level record's text (symbol-less files): title, summary, headings, path.
function fileText(rel: string, title: string | undefined, summary: string | undefined, headings: string[]): string {
  return [title ?? "", summary ?? "", ...headings, rel.replace(/\//g, " ")].join("\n");
}

// One corpus item to embed: its target (file, optional symbol/line) plus the
// exact text to encode. This is the SINGLE definition of "what the corpus is",
// shared by the static tier (buildEmbeddingIndex) and the endpoint tier
// (buildEndpointIndex) so both embed byte-identical texts in the same order and
// differ ONLY in the encoder. Deterministic: scan order (files by rel) then
// declaration order within a file, deduped by symbol name (bm25 parity).
export interface EmbeddingUnit {
  file: string;
  symbol?: string;
  line?: number;
  text: string;
}

// The fingerprint of one unit's text: 64 bits of sha1, ample to tell 10^5-10^6
// texts apart, and short enough to keep in embeddings.bin's header per record.
// A vector is a pure function of (model, text), so equal hashes under the same
// model mean an equal vector — the whole basis of reuse below.
export function unitHash(text: string): string {
  return sha1(text).slice(0, 16);
}

// The vectors of a previously built index that this build may reuse, keyed by
// unitHash. Only an index written by this EMBED_VERSION (same units, same
// encode) with the same model — modelId, and dim when the caller knows it —
// qualifies; anything else contributes nothing and every unit is encoded.
export function reusableVectors(previous: EmbeddingIndex | undefined, modelId: string, dim?: number): Map<string, Int8Array> {
  const out = new Map<string, Int8Array>();
  if (!previous || previous.embedVersion !== EMBED_VERSION || previous.modelId !== modelId) return out;
  if (dim !== undefined && previous.dim !== dim) return out;
  for (const r of previous.records) {
    if (r.textHash && (dim === undefined || r.vec.length === dim)) out.set(r.textHash, r.vec);
  }
  return out;
}

// True when two indexes hold the same records in the same order under the same
// model — i.e. a rebuild changed nothing worth writing back.
export function sameEmbeddings(a: EmbeddingIndex | undefined, b: EmbeddingIndex): boolean {
  if (!a || a.embedVersion !== b.embedVersion || a.modelId !== b.modelId || a.dim !== b.dim) return false;
  if (a.records.length !== b.records.length) return false;
  return a.records.every((r, i) => {
    const o = b.records[i]!;
    return r.file === o.file && r.symbol === o.symbol && r.line === o.line && r.textHash === o.textHash;
  });
}

export function embeddingUnits(scan: RepoScan): EmbeddingUnit[] {
  const units: EmbeddingUnit[] = [];
  for (const f of scan.files) {
    const seen = new Set<string>();
    let hadSymbol = false;
    for (const s of f.symbols) {
      if (REEXPORT_KINDS.has(s.kind)) continue; // a pure barrel falls back to a file-level unit
      if (seen.has(s.name)) continue; // dedupe by name within a file (bm25 parity)
      seen.add(s.name);
      hadSymbol = true;
      units.push({ file: f.rel, symbol: s.name, line: s.line, text: symbolText(f.rel, s, f.summary) });
    }
    if (!hadSymbol) {
      const text = fileText(f.rel, f.title, f.summary, f.headings);
      if (text.replace(/\s+/g, "")) units.push({ file: f.rel, text });
    }
  }
  return units;
}

// Build the corpus embedding index from a scan + a loaded model. Pure and
// deterministic (encode is byte-stable, scan order is fixed) → two builds of an
// unchanged repo produce byte-identical serialized bytes.
//
// `previous` (typically embeddings.bin read back) donates the vector of every
// unit whose text it already encoded under this model. Encoding is the whole
// cost of this function — 9.4 s for microsoft/TypeScript's 245k units — and a
// reused vector is bit-identical to a re-encoded one, so the result (and its
// serialized bytes) is the same with or without it.
export function buildEmbeddingIndex(scan: RepoScan, model: StaticEmbedModel, opts: { previous?: EmbeddingIndex } = {}): EmbeddingIndex {
  const reuse = reusableVectors(opts.previous, model.modelId, model.dim);
  const records: EmbeddingRecord[] = embeddingUnits(scan).map((u) => {
    const textHash = unitHash(u.text);
    return unitRecord(u, textHash, reuse.get(textHash) ?? encode(model, u.text));
  });
  return { embedVersion: EMBED_VERSION, modelId: model.modelId, dim: model.dim, records };
}

// One record, in the fixed key order both tiers share.
export function unitRecord(u: EmbeddingUnit, textHash: string, vec: Int8Array): EmbeddingRecord {
  return {
    file: u.file,
    ...(u.symbol !== undefined ? { symbol: u.symbol } : {}),
    ...(u.line !== undefined ? { line: u.line } : {}),
    textHash,
    vec,
  };
}

const MAGIC = "CIE1"; // codeindex embeddings, format 1

// Serialize to embeddings.bin: a fixed ASCII magic, a uint32-LE header length, a
// UTF-8 JSON header (per-record metadata in build order, each record's unit
// text hash included — carries NO absolute path or timestamp), then the packed
// int8 body (count × dim signed bytes). The header JSON key order is fixed by
// construction, and every body byte is written explicitly, so the bytes are
// fully deterministic. Returns a Uint8Array (a Buffer at runtime) so the public
// type surface stays free of the Node `Buffer` global — a consumer
// type-checking without @types/node still resolves it.
export function serializeEmbeddings(index: EmbeddingIndex): Uint8Array {
  const header = JSON.stringify({
    embedVersion: index.embedVersion,
    modelId: index.modelId,
    dim: index.dim,
    count: index.records.length,
    records: index.records.map((r) => ({ file: r.file, symbol: r.symbol ?? "", line: r.line ?? 0, hash: r.textHash ?? "" })),
  });
  const headerBuf = new TextEncoder().encode(header);
  const bodyLength = index.records.length * index.dim;
  const out = new Uint8Array(8 + headerBuf.length + bodyLength);
  out.set([0x43, 0x49, 0x45, 0x31], 0); // CIE1
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(4, headerBuf.length, true);
  out.set(headerBuf, 8);
  let off = 8 + headerBuf.length;
  for (const r of index.records) {
    for (let d = 0; d < index.dim; d++) out[off++] = r.vec[d] ?? 0;
  }
  return out;
}

// Inverse of serializeEmbeddings. Accepts any Uint8Array (e.g. a fs.readFileSync
// Buffer). Throws on anything that is not a well-formed artifact — bad magic,
// truncation, a header that is not the expected shape — so a caller fails
// loudly rather than misreading arbitrary bytes; readEmbeddingsFile
// (persist.ts) is the never-throwing wrapper a search path uses. The body is
// copied ONCE into a single Int8Array that every record's vector views, so the
// result neither aliases the caller's buffer nor allocates per record.
export function deserializeEmbeddings(bytes: Uint8Array): EmbeddingIndex {
  if (bytes.byteLength < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) {
    throw new Error("embeddings.bin: bad magic (not a codeindex embeddings artifact)");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = data.getUint32(4, true);
  if (8 + headerLen > bytes.byteLength) throw new Error("embeddings.bin: truncated header");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLen))) as {
    embedVersion: number;
    modelId: string;
    dim: number;
    count: number;
    records: { file: string; symbol: string; line: number; hash?: string }[];
  };
  const { dim } = header;
  if (
    typeof header.embedVersion !== "number" ||
    typeof header.modelId !== "string" ||
    !Number.isInteger(dim) ||
    dim < 0 ||
    !Array.isArray(header.records) ||
    header.records.length !== header.count
  ) {
    throw new Error("embeddings.bin: malformed header");
  }
  const bodyOff = 8 + headerLen;
  const bodyLen = header.records.length * dim;
  if (bodyOff + bodyLen > bytes.byteLength) throw new Error("embeddings.bin: truncated body");
  const body = new Int8Array(bodyLen);
  body.set(new Int8Array(bytes.buffer, bytes.byteOffset + bodyOff, bodyLen));
  const records: EmbeddingRecord[] = header.records.map((m, i) => {
    return {
      file: m.file,
      ...(m.symbol ? { symbol: m.symbol } : {}),
      ...(m.line ? { line: m.line } : {}),
      ...(m.hash ? { textHash: m.hash } : {}),
      vec: body.subarray(i * dim, (i + 1) * dim),
    };
  });
  return { embedVersion: header.embedVersion, modelId: header.modelId, dim, records };
}
