import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { parseGitignore, isIgnored, type IgnoreRule } from "./ignore.js";

// Directories that never carry signal for a documentation/code question and
// would bloat the index (dependencies, build output, VCS internals, caches).
// .codeindex is the engine's OWN output (index artifacts, pulled models, MCP
// memories) — indexing it would feed memories into search and churn the scan
// fingerprint on every write_memory (issue #12).
// Exported so grep.ts can align ripgrep's universe with the walker's.
export const IGNORE_DIRS = new Set([
  ".git", "node_modules", ".pnpm", "bower_components", "vendor", "dist", "build", "out",
  "target", ".next", ".nuxt", ".svelte-kit", ".turbo", "coverage", "__pycache__", ".venv",
  "venv", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".idea", ".vscode", ".cache",
  "tmp", ".ultraindex", ".codeindex", "Pods", "DerivedData", ".terraform", "elm-stuff", ".dart_tool",
]);

// Lockfiles: huge, machine-generated, and pure noise for a code/docs question —
// they'd otherwise rank as keyword-dense "code" hits (e.g. package-lock.json
// matching a dependency name). Skipped entirely.
export const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "composer.lock", "cargo.lock", "poetry.lock", "pipfile.lock", "gemfile.lock", "go.sum",
  "flake.lock", "packages.lock.json", "podfile.lock", "mix.lock",
]);

// Binary / non-source extensions to skip when reading file contents.
export const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns", ".svg", ".pdf", ".zip",
  ".gz", ".tar", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".class", ".so", ".dylib",
  ".dll", ".exe", ".bin", ".o", ".a", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3",
  ".mp4", ".mov", ".avi", ".webm", ".wav", ".flac", ".ogg", ".lock", ".min.js", ".map",
]);

export interface WalkOptions {
  maxFileBytes?: number; // skip files larger than this (default 1 MiB)
  maxFiles?: number; // hard cap on indexed files (default 20000)
  // Honor .gitignore files (root and nested, with negation/anchoring/dir-only
  // semantics — see ignore.ts). Default TRUE: an ignored file is noise for
  // every consumer; pass false to index generated/ignored trees deliberately.
  gitignore?: boolean;
  // Directory names to skip, REPLACING the default set entirely (not merging
  // with it). IGNORE_DIRS is a public export, so consumers compose
  // `[...IGNORE_DIRS, "extra"]` — or filter it — themselves; replace is the
  // simplest contract. Deliberate scope boundary: grep.ts (the ripgrep
  // universe) and the MCP server keep the DEFAULT set — recall consumers
  // (e.g. ultrasec) consume scan/extract, not grep.
  ignoreDirs?: string[];
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
  // Files that were SEEN and rejected by the size/lockfile/binary/minified/
  // gitignore rules. Ignored DIRECTORIES (node_modules, gitignored trees…)
  // are not counted — their contents were never even listed.
  excluded: number;
}

export const DEFAULT_MAX_FILES = 20_000;

// Recursively list source-like files under `root`, applying ignore rules. Pure
// filesystem walk — no git dependency, so it works on any directory. Returns a
// `capped` flag (never a silent truncation) so the caller can warn when the
// maxFiles cap stopped the walk with files still unindexed.
export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const useGitignore = opts.gitignore !== false;
  // Effective ignored-directory set, built once: the caller's replacement when
  // given (see WalkOptions.ignoreDirs — replace, never merge), else the default.
  const ignoreDirs = opts.ignoreDirs ? new Set(opts.ignoreDirs) : IGNORE_DIRS;
  const out: WalkedFile[] = [];
  let capped = false;
  let excluded = 0;

  // Containment root for the symlink-escape guard: a symlinked file or
  // directory whose real path leaves the repo must not be indexed (it would
  // read foreign content and emit citations no one can open).
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { files: out, capped, excluded };
  }
  const contained = (real: string): boolean => real === rootReal || real.startsWith(rootReal + sep);

  // Each frame carries the ignore-rule chain inherited from its ancestors;
  // rules from deeper .gitignore files are appended after (later rules win).
  const stack: { dir: string; rel: string; rules: readonly IgnoreRule[] }[] = [
    { dir: root, rel: "", rules: [] },
  ];
  const seenDirs = new Set<string>(); // resolved real dirs already walked
  walking: while (stack.length) {
    const frame = stack.pop()!;
    // Cycle guard: a directory symlink pointing at an ancestor would otherwise
    // make walk() loop, flooding the index with phantom duplicate files. Resolve
    // the real path and skip any directory we've already descended into.
    let real: string;
    try {
      real = realpathSync(frame.dir);
    } catch {
      continue;
    }
    if (seenDirs.has(real)) continue;
    seenDirs.add(real);
    if (!contained(real)) continue; // dir symlink escaping the repo
    let entries: string[];
    try {
      // Sorted so the walk order — and therefore WHICH files survive a
      // maxFiles cap — is identical across filesystems and machines.
      entries = readdirSync(frame.dir).sort();
    } catch {
      continue;
    }
    let rules = frame.rules;
    if (useGitignore && entries.includes(".gitignore")) {
      const parsed = parseGitignore(readText(join(frame.dir, ".gitignore")), frame.rel);
      if (parsed.length) rules = [...rules, ...parsed];
    }
    for (const name of entries) {
      const abs = join(frame.dir, name);
      const rel = frame.rel ? `${frame.rel}/${name}` : name;
      let st;
      let isLink: boolean;
      try {
        st = statSync(abs);
        isLink = lstatSync(abs).isSymbolicLink();
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (ignoreDirs.has(name)) continue;
        // An in-repo DIRECTORY symlink is skipped entirely: its target is (or
        // will be) walked under its canonical name, and letting both paths race
        // through the cycle guard would keep whichever readdir served first —
        // aliased, filesystem-order-dependent indexes. Out-of-repo links are
        // covered by the containment guard above.
        if (isLink) continue;
        if (useGitignore && rules.length && isIgnored(rules, rel, true)) continue;
        stack.push({ dir: abs, rel, rules });
        continue;
      }
      if (!st.isFile()) continue;
      // Each rejection below is a file the walk SAW and dropped — counted in
      // `excluded` so consumers can report how much was filtered, not capped.
      if (st.size > maxFileBytes) {
        excluded++;
        continue;
      }
      if (LOCKFILES.has(name.toLowerCase())) {
        excluded++;
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        excluded++;
        continue;
      }
      if (name.endsWith(".min.js") || name.endsWith(".min.css")) {
        excluded++;
        continue;
      }
      if (useGitignore && rules.length && isIgnored(rules, rel, false)) {
        excluded++;
        continue;
      }
      // Symlink-escape guard for files (statSync above follows links).
      if (isLink) {
        try {
          if (!contained(realpathSync(abs))) continue;
        } catch {
          continue;
        }
      }
      // The cap is enforced HERE, on kept files, so a flat directory cannot
      // silently overshoot it and `capped` is set exactly when a file was
      // actually dropped (never a silent truncation).
      if (out.length >= maxFiles) {
        capped = true;
        break walking;
      }
      out.push({ rel: rel.split(sep).join("/"), abs, size: st.size, ext, mtimeMs: st.mtimeMs });
    }
  }
  return { files: out, capped, excluded };
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
