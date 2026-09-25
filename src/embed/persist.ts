import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deserializeEmbeddings, type EmbeddingIndex } from "./index.js";

// Reading a persisted embedding index back, for REUSE only. Node-only (fs), so
// it lives apart from index.ts, which the browser bundle also carries.
//
// Nothing read here is trusted as an answer: buildEmbeddingIndex /
// buildEndpointIndex take it as `previous` and reuse a vector only when the
// EMBED_VERSION and model match and the unit's text hash is identical, so a
// stale, foreign or partial file costs at most a re-encode, never a wrong
// ranking.

// embeddings.bin (or an endpoint cache file) → its index, or undefined when it
// is missing, unreadable, truncated or malformed. NEVER throws: a search that
// finds a broken sidecar just encodes from scratch, as it did before reuse.
export function readEmbeddingsFile(path: string): EmbeddingIndex | undefined {
  try {
    return deserializeEmbeddings(readFileSync(path));
  } catch {
    return undefined;
  }
}

// Write through a temp file + rename, so a concurrent reader (another search,
// the MCP server) sees the old file or the new one, never half of one. Best
// effort: a read-only index dir must not fail the search that tried to cache.
export function writeEmbeddingsFileAtomic(path: string, bytes: Uint8Array): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
    return true;
  } catch {
    rmSync(tmp, { force: true });
    return false;
  }
}
