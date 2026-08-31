// The wire format of the Language Server Protocol, and nothing else.
//
// PURE: no I/O, no process, no clock. It turns bytes into messages and messages
// into bytes, which is why the whole framing layer — the part that actually
// breaks, because a language server's stdout arrives in chunks that respect no
// message boundary whatsoever — is testable without spawning anything.
//
// This is the client-side twin of src/mcp/protocol.ts. Same reasoning: a
// hand-rolled codec with the edge cases written down beats a dependency, and
// the edge cases here are real. A frame header can straddle a chunk boundary; a
// multi-byte UTF-8 character can straddle one too (Content-Length counts BYTES,
// not characters, which is the classic way a hand-rolled reader corrupts every
// message after the first accented identifier); and a server may send headers
// this client does not know about.

import { byStr } from "../sort.js";

export interface LspMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** A reference the LSP reported, normalised to the engine's 1-based lines. */
export interface LspRef {
  /** Repo-relative, posix separators — the same key every other artifact uses. */
  file: string;
  line: number;
  character?: number;
}

/**
 * The largest frame this client will assemble, in bytes.
 *
 * Not a performance knob: a malformed or hostile `Content-Length` is otherwise
 * an unbounded allocation driven by a process the user configured but did not
 * write. 32 MiB is far above any real `textDocument/references` response.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

const HEADER_END = "\r\n\r\n";

export function encodeMessage(msg: LspMessage): string {
  const body = JSON.stringify(msg);
  // Content-Length is a BYTE count. `body.length` is a UTF-16 code-unit count,
  // and they differ for every non-ASCII character — a bug that only shows up
  // once someone indexes a repository with accented identifiers.
  return `Content-Length: ${byteLength(body)}${HEADER_END}${body}`;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * An incremental frame reader.
 *
 * Feed it whatever arrives; it returns the messages that are complete. Buffers
 * BYTES rather than a string, because decoding each chunk on arrival is what
 * corrupts a multi-byte character split across two chunks.
 */
export function createFramer(): { push(chunk: Uint8Array | string): LspMessage[] } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);

  const append = (chunk: Uint8Array): void => {
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer);
    next.set(chunk, buffer.length);
    buffer = next;
  };

  // Index of the header terminator, searched over BYTES so it cannot be fooled
  // by a partially decoded chunk.
  const headerEnd = (): number => {
    for (let i = 0; i + 3 < buffer.length; i++) {
      if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i;
    }
    return -1;
  };

  return {
    push(chunk: Uint8Array | string): LspMessage[] {
      append(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      const out: LspMessage[] = [];

      for (;;) {
        const end = headerEnd();
        if (end < 0) return out;

        const headers = decoder.decode(buffer.subarray(0, end));
        // Case-insensitive, and tolerant of headers we do not know (a server is
        // allowed to send Content-Type, and some do).
        const match = /content-length:\s*(\d+)/i.exec(headers);
        if (!match) {
          // No length in a complete header block: unrecoverable for this frame.
          // Drop it and resynchronise rather than stalling forever on bytes
          // that will never become a message.
          buffer = buffer.subarray(end + 4);
          continue;
        }

        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
          buffer = buffer.subarray(end + 4);
          continue;
        }

        const start = end + 4;
        if (buffer.length < start + length) return out; // body still in flight

        const body = decoder.decode(buffer.subarray(start, start + length));
        buffer = buffer.subarray(start + length);
        try {
          out.push(JSON.parse(body) as LspMessage);
        } catch {
          // A server that emits non-JSON on stdout (a stray log line inside a
          // framed body) loses that message, not the session.
        }
      }
    },
  };
}

/** `file:///abs/path` for a repo-relative path, percent-encoding each segment. */
export function fileUri(root: string, rel: string): string {
  const rootPath = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const relPath = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = `${rootPath}/${relPath}`;
  if (abs.startsWith("//")) {
    const [host = "", ...segments] = abs.slice(2).split("/");
    return `file://${encodeURIComponent(host)}/${segments.map(encodeURIComponent).join("/")}`;
  }
  const drive = /^([A-Za-z]):/.exec(abs);
  const path = drive ? `/${abs}` : abs;
  return (
    "file://" +
    path
      .split("/")
      .map((segment, i) => (i === 0 || (i === 1 && /^[A-Za-z]:$/.test(segment)) ? segment : encodeURIComponent(segment)))
      .join("/")
  );
}

/** The inverse, or undefined when the URI points outside the repository. */
export function relFromUri(root: string, uri: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  let path: string;
  try {
    const encoded = uri.slice("file://".length);
    // A non-empty URI authority is a Windows UNC host. Local paths start with
    // '/', including canonical drive URIs (`file:///C:/...`).
    path = decodeURIComponent(encoded.startsWith("/") ? encoded : `//${encoded}`).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const windows = /^[A-Za-z]:/.test(base) || base.startsWith("//");
  const comparablePath = windows ? path.toLowerCase() : path;
  const comparableBase = windows ? base.toLowerCase() : base;
  if (comparablePath === comparableBase) return "";
  if (!comparablePath.startsWith(`${comparableBase}/`)) return undefined;
  return path.slice(base.length + 1);
}

interface RawPosition {
  line?: number;
  character?: number;
}
interface RawLocation {
  uri?: string;
  targetUri?: string;
  range?: { start?: RawPosition };
  targetSelectionRange?: { start?: RawPosition };
  targetRange?: { start?: RawPosition };
}

/**
 * Normalise whatever `textDocument/references` or `textDocument/definition`
 * returned into engine coordinates.
 *
 * Handles all three shapes the spec permits — a single Location, an array of
 * Locations, and an array of LocationLinks — because which one you get is a
 * per-server, per-request choice, and a client that assumes one silently
 * returns nothing against the others.
 *
 * LSP lines are 0-based; every line number in this engine is 1-based. Output is
 * deduped and sorted so an LSP answer is as deterministic as a static one, even
 * though the server's ordering is not guaranteed.
 */
export function locationsToRefs(root: string, raw: unknown): LspRef[] {
  const list: RawLocation[] = Array.isArray(raw) ? (raw as RawLocation[]) : raw && typeof raw === "object" ? [raw as RawLocation] : [];
  const seen = new Set<string>();
  const out: LspRef[] = [];

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const uri = item.uri ?? item.targetUri;
    if (!uri) continue;
    const file = relFromUri(root, uri);
    // Outside the repo — a definition inside node_modules or the standard
    // library. Real, but not addressable in an index keyed on repo-relative
    // paths, so dropped rather than reported under a path that does not exist.
    if (file === undefined || file === "") continue;

    const start = (item.range ?? item.targetSelectionRange ?? item.targetRange)?.start;
    const line = typeof start?.line === "number" ? start.line + 1 : 1;
    const character = typeof start?.character === "number" ? start.character : undefined;

    const key = `${file}:${line}:${character ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(character === undefined ? { file, line } : { file, line, character });
  }

  return out.sort((a, b) => byStr(a.file, b.file) || a.line - b.line || (a.character ?? 0) - (b.character ?? 0));
}
