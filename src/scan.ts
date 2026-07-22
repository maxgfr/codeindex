import { basename } from "node:path";
import type { FileRecord } from "./types.js";
import { walk, readText } from "./walk.js";
import { headCommit } from "./git.js";
import { sha1 } from "./hash.js";
import { classify, MARKDOWN_EXT } from "./classify.js";
import { extToLang } from "./lang/registry.js";
import { compileGlobs } from "./glob.js";
import { byKey } from "./sort.js";
import { extractMarkdown } from "./extract/markdown.js";
import { extractCode } from "./extract/code.js";

export interface RepoScan {
  root: string;
  commit?: string;
  files: FileRecord[];
  languages: Record<string, number>;
  // Raw content of doc files, kept so the graph's mention pass does not re-read
  // them from disk (they were already read here). Docs only — bounding memory to
  // prose, never the whole source tree.
  docText: Map<string, string>;
  // rel → last-modified ms for every kept file, so build.ts can persist the
  // (size,mtime) fastpath key into cache.json for the next build.
  mtimes: Map<string, number>;
  capped: boolean; // the walk hit --max-files and the index is partial
}

export interface ScanOptions {
  include?: string[];
  exclude?: string[];
  maxBytes?: number;
  maxFiles?: number;
  out?: string; // absolute output dir to exclude from the scan (self-index guard)
  // Previous build's extraction cache (rel → {hash, record, size?, mtimeMs?}). A
  // file whose (size,mtime) key matches skips read+hash entirely (the stat
  // fastpath); one whose content hash is unchanged reuses its record and skips
  // re-extraction.
  cache?: Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }>;
  // Disable the stat fastpath: read and re-hash every file (see BuildOptions).
  fullHash?: boolean;
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// Walk the repo once and turn every in-scope file into a FileRecord. Pure file
// I/O + deterministic extraction — never reads the repo into the model.
export function scanRepo(root: string, opts: ScanOptions = {}): RepoScan {
  const include = compileGlobs(opts.include);
  const exclude = compileGlobs(opts.exclude);
  const { files: walked, capped } = walk(root, { maxFileBytes: opts.maxBytes, maxFiles: opts.maxFiles });
  // Never index our own output (e.g. a committed `docs/ultraindex/`), or builds
  // would describe the encyclopedia instead of the code.
  const outPrefix = opts.out ? opts.out.replace(/\/+$/, "") + "/" : null;

  const files: FileRecord[] = [];
  const languages: Record<string, number> = {};
  const docText = new Map<string, string>();
  const mtimes = new Map<string, number>();

  for (const f of walked) {
    if (outPrefix && (f.abs === opts.out || f.abs.startsWith(outPrefix))) continue;
    if (include && !include(f.rel)) continue;
    if (exclude && exclude(f.rel)) continue;

    const kind = classify(f.rel, f.ext);
    const lang = extToLang(f.ext);
    languages[lang] = (languages[lang] ?? 0) + 1;
    mtimes.set(f.rel, f.mtimeMs); // persist the fastpath key for the next build

    const cached = opts.cache?.get(f.rel);

    // Stat fastpath: a NON-DOC file whose size AND mtime both match its cache
    // entry is treated as unchanged and reuses its record WITHOUT a read or hash.
    // Docs are EXEMPT — the graph's mention pass needs their raw content (docText)
    // every build, so a doc is always read regardless. --full-hash disables the
    // fastpath. The (size,mtime) pair is the heuristic here (not the exact content
    // hash below): a real editor bumps mtime on every save, and --full-hash /
    // --no-cache are the escape hatches for the astronomically-unlikely edit that
    // preserves both.
    if (
      kind !== "doc" &&
      !opts.fullHash &&
      cached &&
      cached.size !== undefined &&
      cached.mtimeMs !== undefined &&
      cached.size === f.size &&
      cached.mtimeMs === f.mtimeMs
    ) {
      files.push(cached.record);
      continue;
    }

    // Read + hash (the staleness oracle stays exact); only EXTRACTION is cached. A
    // hash hit reuses the previous record — content is byte-identical, so every
    // derived field is too. classify()/extToLang() depend only on the path, so
    // kind/lang are stable across the hit.
    const content = readText(f.abs);
    const hash = sha1(content);
    if (cached && cached.hash === hash) {
      files.push(cached.record);
      if (kind === "doc" && content) docText.set(f.rel, content);
      continue;
    }

    const record: FileRecord = {
      rel: f.rel,
      ext: f.ext,
      size: f.size,
      lines: countLines(content),
      hash,
      kind,
      lang,
      headings: [],
      symbols: [],
      refs: [],
    };

    if (content) {
      if (kind === "doc" && MARKDOWN_EXT.has(f.ext)) {
        const md = extractMarkdown(content);
        record.title = md.title ?? basename(f.rel);
        record.summary = md.summary;
        record.headings = md.headings;
        record.refs = md.refs;
      } else if (kind === "doc") {
        // Non-markdown prose (.rst/.txt): title from basename, no link graph.
        record.title = basename(f.rel);
      } else if (kind === "code") {
        const code = extractCode(f.rel, f.ext, content);
        record.title = basename(f.rel);
        record.summary = code.summary;
        record.symbols = code.symbols;
        record.refs = code.refs;
        record.pkg = code.pkg;
        record.idents = code.idents;
        record.calls = code.calls;
        record.importedNames = code.importedNames;
      } else {
        record.title = basename(f.rel);
      }
    } else {
      record.title = basename(f.rel);
    }

    // Retain doc content for the graph's mention pass (docs only) so it is read
    // once here, not a second time from disk.
    if (kind === "doc" && content) docText.set(f.rel, content);

    files.push(record);
  }

  files.sort(byKey((f) => f.rel));
  return { root, commit: headCommit(root), files, languages, docText, mtimes, capped };
}
