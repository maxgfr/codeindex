import type { RepoScan } from "../scan.js";
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
  vec: Int8Array; // length === dim
}

export interface EmbeddingIndex {
  embedVersion: number;
  modelId: string;
  dim: number;
  records: EmbeddingRecord[];
}

// The text encoded for one symbol: its name (camelCase-split by the tokenizer),
// its signature, the owning file's one-line summary, and the file's path segments
// — the same signal bm25 indexes, but pooled into a single vector. Newline-joined
// so the tokenizer's non-alphanumeric split cleanly separates the parts.
function symbolText(rel: string, name: string, signature: string | undefined, summary: string | undefined): string {
  return [name, signature ?? "", summary ?? "", rel.replace(/\//g, " ")].join("\n");
}

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

export function embeddingUnits(scan: RepoScan): EmbeddingUnit[] {
  const units: EmbeddingUnit[] = [];
  for (const f of scan.files) {
    const seen = new Set<string>();
    let hadSymbol = false;
    for (const s of f.symbols) {
      if (seen.has(s.name)) continue; // dedupe by name within a file (bm25 parity)
      seen.add(s.name);
      hadSymbol = true;
      units.push({ file: f.rel, symbol: s.name, line: s.line, text: symbolText(f.rel, s.name, s.signature, f.summary) });
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
export function buildEmbeddingIndex(scan: RepoScan, model: StaticEmbedModel): EmbeddingIndex {
  const records: EmbeddingRecord[] = embeddingUnits(scan).map((u) => {
    const rec: EmbeddingRecord = { file: u.file, vec: encode(model, u.text) };
    if (u.symbol !== undefined) rec.symbol = u.symbol;
    if (u.line !== undefined) rec.line = u.line;
    return rec;
  });
  return { embedVersion: EMBED_VERSION, modelId: model.modelId, dim: model.dim, records };
}

const MAGIC = "CIE1"; // codeindex embeddings, format 1

// Serialize to embeddings.bin: a fixed ASCII magic, a uint32-LE header length, a
// UTF-8 JSON header (per-record metadata in build order — carries NO absolute
// path or timestamp), then the packed int8 body (count × dim signed bytes). The
// header JSON key order is fixed by construction, and every body byte is written
// explicitly, so the bytes are fully deterministic. Returns a Uint8Array (a
// Buffer at runtime) so the public type surface stays free of the Node `Buffer`
// global — a consumer type-checking without @types/node still resolves it.
export function serializeEmbeddings(index: EmbeddingIndex): Uint8Array {
  const header = JSON.stringify({
    embedVersion: index.embedVersion,
    modelId: index.modelId,
    dim: index.dim,
    count: index.records.length,
    records: index.records.map((r) => ({ file: r.file, symbol: r.symbol ?? "", line: r.line ?? 0 })),
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
// Buffer) and wraps it as a Buffer VIEW (no copy) for the numeric reads. Throws
// on a bad magic (a corrupt or foreign file) so a caller fails loudly rather
// than misreading arbitrary bytes.
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
    records: { file: string; symbol: string; line: number }[];
  };
  const bodyOff = 8 + headerLen;
  const { dim } = header;
  if (bodyOff + header.records.length * dim > bytes.byteLength) throw new Error("embeddings.bin: truncated body");
  const records: EmbeddingRecord[] = header.records.map((m, i) => {
    const vec = new Int8Array(bytes.buffer.slice(bytes.byteOffset + bodyOff + i * dim, bytes.byteOffset + bodyOff + (i + 1) * dim));
    const rec: EmbeddingRecord = { file: m.file, vec };
    if (m.symbol) rec.symbol = m.symbol;
    if (m.line) rec.line = m.line;
    return rec;
  });
  return { embedVersion: header.embedVersion, modelId: header.modelId, dim, records };
}
