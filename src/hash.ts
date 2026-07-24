import { createHash } from "node:crypto";

// Stable content hash used for the manifest's staleness oracle and for the
// `ui:gen` region fingerprints. sha1 is plenty for change detection (not
// security) and keeps the manifest compact. Accepts raw bytes too (additive)
// so binary artifacts (e.g. embeddings.bin) hash without a lossy decode; a
// string is hashed as its UTF-8 bytes — identical to hashing the bytes
// writeFileSync would put on disk for that string.
export function sha1(s: string | Uint8Array): string {
  return createHash("sha1").update(s).digest("hex");
}

// A short fingerprint for embedding in region fences without bloating the file.
export function shortHash(s: string, n = 8): string {
  return sha1(s).slice(0, n);
}
