import { readdirSync, statSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";

// Directories that never carry signal for a documentation/code question and
// would bloat the index (dependencies, build output, VCS internals, caches).
const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".pnpm", "bower_components", "vendor", "dist", "build", "out",
  "target", ".next", ".nuxt", ".svelte-kit", ".turbo", "coverage", "__pycache__", ".venv",
  "venv", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vscode", ".cache",
  "tmp", ".ultraindex", "Pods", "DerivedData", ".terraform", "elm-stuff", ".dart_tool",
]);

// Lockfiles: huge, machine-generated, and pure noise for a code/docs question —
// they'd otherwise rank as keyword-dense "code" hits (e.g. package-lock.json
// matching a dependency name). Skipped entirely.
const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "composer.lock", "cargo.lock", "poetry.lock", "pipfile.lock", "gemfile.lock", "go.sum",
  "flake.lock", "packages.lock.json", "podfile.lock", "mix.lock",
]);

// Binary / non-source extensions to skip when reading file contents.
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".svg", ".pdf", ".zip",
  ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".class", ".so", ".dylib",
  ".dll", ".exe", ".bin", ".o", ".a", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3",
  ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac", ".ogg", ".lock", ".min.js", ".map",
]);

export interface WalkOptions {
  maxFileBytes?: number; // skip files larger than this (default 1 MiB)
  maxFiles?: number; // hard cap on indexed files (default 20000)
}

export interface WalkedFile {
  rel: string; // path relative to root, posix-style
  abs: string;
  size: number;
  ext: string;
  mtimeMs: number; // last-modified ms — the stat fastpath's freshness key with size
}

export interface WalkResult {
  files: WalkedFile[];
  capped: boolean; // true when the maxFiles cap was hit and the walk stopped early
}

export const DEFAULT_MAX_FILES = 20_000;

// Recursively list source-like files under `root`, applying ignore rules. Pure
// filesystem walk — no git dependency, so it works on any directory. Returns a
// `capped` flag (never a silent truncation) so the caller can warn when the
// maxFiles cap stopped the walk with files still unindexed.
export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const out: WalkedFile[] = [];
  let capped = false;

  const stack: string[] = [root];
  const seenDirs = new Set<string>(); // resolved real dirs already walked
  while (stack.length) {
    if (out.length >= maxFiles) {
      capped = true;
      break;
    }
    const dir = stack.pop()!;
    // Cycle guard: a directory symlink pointing at an ancestor would otherwise
    // make walk() loop, flooding the index with phantom duplicate files. Resolve
    // the real path and skip any directory we've already descended into.
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (IGNORE_DIRS.has(name)) continue;
        stack.push(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > maxFileBytes) continue;
      if (LOCKFILES.has(name.toLowerCase())) continue;
      const ext = extname(name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      if (name.endsWith(".min.js") || name.endsWith(".min.css")) continue;
      out.push({ rel: relative(root, abs).split(sep).join("/"), abs, size: st.size, ext, mtimeMs: st.mtimeMs });
    }
  }
  return { files: out, capped };
}

// Read a file as text, returning "" on any error (unreadable, vanished). Honours
// a Unicode BOM before the binary sniff — a UTF-16 source file is full of NUL
// bytes and would otherwise be misread as binary and dropped, and a UTF-8 BOM
// would otherwise glue "﻿" onto the first token (breaking line-1 extraction
// and a `[file:1]` citation). Otherwise UTF-8, with a Latin-1 fallback and a
// whole-buffer NUL sniff for genuinely-binary content.
export function readText(abs: string): string {
  try {
    const buf = readFileSync(abs);
    // UTF-16LE/BE BOM. Truncate to an even byte length first so an odd trailing
    // byte can't make swap16() throw (toString already tolerates it; mirror that).
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2, 2 + ((buf.length - 2) & ~1)).toString("utf16le");
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
      swapped.swap16(); // UTF-16BE → LE so Node can decode it
      return swapped.toString("utf16le");
    }
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
    // Binary sniff over the WHOLE buffer, not just the first 4 KiB — a NUL after
    // 4 KiB still means binary (else the symbol right after it is dropped and the
    // content hash is poisoned).
    if (buf.includes(0)) return "";
    const text = buf.toString("utf8");
    // Invalid UTF-8 surfaces as U+FFFD; a Latin-1/Windows-1252 source decodes
    // cleanly there (every byte maps to a code point), so prefer that over baking
    // mojibake into symbols, signatures, and the content hash.
    return text.includes("�") ? buf.toString("latin1") : text;
  } catch {
    return "";
  }
}
