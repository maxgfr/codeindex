import { createHash } from "node:crypto";

// Stable content hash used for the manifest's staleness oracle and for the
// `ui:gen` region fingerprints. sha1 is plenty for change detection (not
// security) and keeps the manifest compact.
export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

// A short fingerprint for embedding in region fences without bloating the file.
export function shortHash(s: string, n = 8): string {
  return sha1(s).slice(0, n);
}
