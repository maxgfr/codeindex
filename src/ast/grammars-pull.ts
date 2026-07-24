import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { ENGINE_VERSION } from "../types.js";

// The slim grammars-pull tier (v2.14.0). The tree-sitter wasm sidecar
// (scripts/grammars/, ~22 MB) is OPTIONAL and opt-in by presence, exactly like
// the embedding model (src/embed/model.ts): no wasm resolvable anywhere → the
// engine silently stays on the regex tier (src/ast/loader.ts). This module lets
// a consumer that vendors ONLY the zero-dependency engine.mjs (no adjacent
// grammars/) fetch the same committed wasms into a shared, version-scoped cache
// — `codeindex grammars pull` — and get byte-identical AST extraction from the
// cache as from a bundle-adjacent dir (same wasm bytes → same AST → same
// symbols). NOTHING here runs during indexing; a failed/absent pull only ever
// leaves the cache empty, never throws into the scan.
//
// Zero runtime dependencies: global fetch (Node ≥18, follows GitHub → CDN
// redirects — mirrors `embed pull`), node:crypto for sha256, node:zlib for
// gunzip, and a tiny inline ustar reader below (Node has no built-in tar). We
// deliberately do NOT spawn the system `tar`: the embed-pull precedent is pure
// Node stdlib, and an in-process reader is cross-platform-deterministic and
// lets us guard path traversal precisely before a single byte hits disk.

// The official grammars asset, published as a normal release asset on the
// engine's own `v<ENGINE_VERSION>` tag (built + uploaded by the release
// workflow, per-version). `grammars pull` uses this when CODEINDEX_GRAMMARS_URL
// is unset.
export const DEFAULT_GRAMMARS_URL = `https://github.com/maxgfr/codeindex/releases/download/v${ENGINE_VERSION}/grammars-${ENGINE_VERSION}.tar.gz`;

// What `grammars pull` fetches, and how to verify it. CODEINDEX_GRAMMARS_URL
// wins outright (the user's explicit override / private mirror) and carries NO
// checksum, so a custom asset keeps the un-verified behavior — exactly like
// resolveEmbedPullUrl's custom-mirror rule. With no env we fall back to the
// built-in default AND its `.sha256` SIDECAR asset. Unlike the embed model (a
// single fixed release whose hash is pinned as a code constant), the grammars
// tarball is cut fresh on EVERY release, so its hash cannot be a compile-time
// constant; the checksum travels next to the asset and is fetched at pull time.
export interface GrammarsPullTarget {
  url: string;
  sha256Url?: string; // present only for the built-in default → fetch + verify
}

export function resolveGrammarsPullTarget(): GrammarsPullTarget {
  const env = process.env.CODEINDEX_GRAMMARS_URL;
  if (env && env.trim()) return { url: env.trim() };
  return { url: DEFAULT_GRAMMARS_URL, sha256Url: `${DEFAULT_GRAMMARS_URL}.sha256` };
}

// Fetch the tarball bytes over HTTP, following redirects. When `expectedSha256`
// is given, the downloaded bytes are hashed and MUST match or this throws with
// a clear message (so a corrupt/tampered default asset never reaches disk). A
// non-2xx response also throws. I/O + verification are split from the CLI so
// both the success and the sha-mismatch paths are unit-testable — mirrors
// fetchEmbedModel.
export async function fetchGrammarsTarball(url: string, expectedSha256?: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (expectedSha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== expectedSha256) {
      throw new Error(`sha256 mismatch: expected ${expectedSha256}, got ${got}`);
    }
  }
  return buf;
}

// Wrap any Uint8Array as a Buffer VIEW over the same memory (no copy) so the
// tar reader can use Buffer's string decoders. Keeps the public API on
// Uint8Array — the engine's convention — while avoiding a Node-only `Buffer`
// type in the shipped .d.mts (consumers may lack @types/node).
function asBuffer(u: Uint8Array): Buffer {
  return Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength);
}

// Fetch + parse the `.sha256` sidecar (a `<hex>` or `<hex>  <filename>` line),
// returning the lowercased 64-hex digest. Throws on a non-2xx or a malformed
// body so a bad sidecar degrades the pull to a clear error rather than silently
// skipping verification.
export async function fetchExpectedSha256(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  const hex = (text.trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`invalid sha256 sidecar at ${url}`);
  return hex;
}

// One parsed tar entry (header fields we care about + its raw data slice).
interface TarEntry {
  name: string;
  type: string; // typeflag char: "0"/"\0" = regular file, "5" = dir, …
  data: Buffer;
}

// Read a C-string (NUL-terminated, else the whole field) from a 512-byte header.
function cstr(block: Buffer, start: number, len: number): string {
  const slice = block.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.toString("utf8", 0, nul === -1 ? slice.length : nul);
}

// A minimal ustar/gnu reader — enough for the flat, short-named wasm archive we
// publish (no long-name/PAX/sparse entries). Yields every entry in order; the
// caller decides which to keep. Stops at the end-of-archive zero block.
function* readTar(buf: Buffer): Generator<TarEntry> {
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break; // end-of-archive marker
    const name = cstr(block, 0, 100);
    const prefix = cstr(block, 345, 155); // ustar long-path prefix (usually empty)
    const sizeStr = cstr(block, 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const type = String.fromCharCode(block[156] ?? 0);
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    yield { name: prefix ? `${prefix}/${name}` : name, type, data };
  }
}

// Normalize a tar entry name to a SAFE relative path, or null to reject it.
// Rejects absolute paths (POSIX "/…", Windows "C:…" or "\…"), any ".." segment,
// and embedded NULs; drops "." and empty segments. This is the path-traversal
// guard: a "../../etc/x" or "/etc/x" entry can never escape the destination.
function safeRelPath(name: string): string | null {
  if (!name || name.includes("\0")) return null;
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return null;
  const out: string[] = [];
  for (const part of name.split(/[/\\]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    out.push(part);
  }
  return out.length ? out.join("/") : null;
}

// Extract every regular file from a RAW (already-gunzipped) tar into destDir,
// returning the relative paths written. Throws on the FIRST unsafe entry BEFORE
// writing it (defense in depth: also verifies the resolved path stays within
// destDir). Non-regular entries (dirs, symlinks, headers) are skipped. Callers
// extract into a throwaway tmp dir, so a mid-stream throw leaves nothing
// half-installed once that tmp dir is discarded.
export function extractTarInto(rawTar: Uint8Array, destDir: string): string[] {
  const root = resolve(destDir);
  const written: string[] = [];
  for (const entry of readTar(asBuffer(rawTar))) {
    if (entry.type !== "0" && entry.type !== "\0") continue; // regular files only
    const rel = safeRelPath(entry.name);
    if (rel === null) throw new Error(`refusing unsafe tar entry: ${entry.name}`);
    const dest = resolve(destDir, rel);
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw new Error(`tar entry escapes destination: ${entry.name}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
    written.push(rel);
  }
  return written;
}

// gunzip (when the bytes are gzip-framed) then extract. The default asset is a
// `.tar.gz`; a custom CODEINDEX_GRAMMARS_URL serving a plain `.tar` is handled
// too (magic-byte sniff), so the tier does not force a compression format.
export function extractGrammarsTarball(bytes: Uint8Array, destDir: string): string[] {
  const b = asBuffer(bytes);
  const raw = b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b;
  return extractTarInto(raw, destDir);
}
