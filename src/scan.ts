import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { FileRecord, FileKind } from "./types.js";
import { walk, readText, type WalkEntry, type WalkOptions, type WalkResult, type WalkSkip, type WalkedFile } from "./walk.js";
import { headCommit } from "./git.js";
import { sha1 } from "./hash.js";
import { classify, MARKDOWN_EXT } from "./classify.js";
import { extToLang } from "./lang/registry.js";
import { compileDirExcludes, compileDirGlobs, compileGlobs } from "./glob.js";
import { byKey } from "./sort.js";
import { extractMarkdown } from "./extract/markdown.js";
import { extractCode } from "./extract/code.js";
import { extractConfigLiterals } from "./extract/config.js";

export interface RepoScan {
  root: string;
  commit?: string;
  files: FileRecord[];
  languages: Record<string, number>;
  // Raw content of doc files, kept so the graph's mention pass does not re-read
  // them from disk (they were already read here). Docs only — bounding memory to
  // prose, never the whole source tree. A doc served by the stat fastpath is
  // not read during the scan: its text loads on the first lookup (see
  // LazyDocText), so a run that reuses the artifacts never reads it at all.
  docText: Map<string, string>;
  // rel → last-modified ms for every kept file, so build.ts can persist the
  // (size,mtime) fastpath key into cache.json for the next build.
  mtimes: Map<string, number>;
  capped: boolean; // the walk hit --max-files and the index is partial
  // Files the walk saw and rejected (size/lockfile/binary/minified/gitignore
  // rules — see WalkResult.excluded), plus, under --scope/--include/--exclude,
  // the files those left out in the directories the walk entered. Surfaced so
  // a consumer can report how much of the tree was filtered out of the index.
  excluded: number;
  // Change-tracking flags. DERIVED ONLY — they never influence records or
  // ordering, so artifacts stay byte-identical whether or not anyone reads them.
  //
  // True iff a cache was supplied AND every kept file reused its cached record
  // (via the stat fastpath or an exact content-hash match) AND the kept file
  // set equals the cache's key set — i.e. this scan proved the indexed content
  // identical to the previous build's.
  contentUnchanged: boolean;
  // True iff persisting this scan's cache would change at least one byte of the
  // previous cache: some kept file's (hash, size, mtimeMs) differs from its
  // cache entry, the kept file set differs from the cache's key set, or no
  // cache was supplied at all. False means a cache rewrite would be pure churn.
  cacheDirty: boolean;
}

export interface ScanOptions {
  // Repo-rooted globs (see glob.ts): `*.ts` matches top-level files only,
  // `**/*.ts` any depth. A path passes when it matches some include (or none
  // is given) and no exclude.
  include?: string[];
  exclude?: string[];
  // One directory or file to restrict the scan to, relative to the repo (see
  // normalizeScope). ANDed with include/exclude: `scope: "src"` with
  // `include: ["**/*.md"]` keeps the markdown under src/, not all markdown
  // plus all of src/.
  scope?: string;
  // Honor .gitignore files (default true — see WalkOptions.gitignore).
  gitignore?: boolean;
  // Directory names to skip — REPLACES the default set, except `.git` and
  // `.codeindex` which are always skipped (see WalkOptions.ignoreDirs; compose
  // with the IGNORE_DIRS export to extend it).
  ignoreDirs?: string[];
  maxBytes?: number;
  maxFiles?: number;
  // Per-file call-site cap for extraction (default 512, both AST and regex
  // tiers). Raising it trades index size for call-graph recall; dedup/sort
  // semantics are unchanged. Absent, output is byte-identical to before.
  maxCallsPerFile?: number;
  // Absolute output dir to exclude from the scan (self-index guard). Inside the
  // repo, the whole dir is skipped; at the repo root, only the index artifacts
  // written there (INDEX_ARTIFACTS); above the root, nothing.
  out?: string;
  // Previous build's extraction cache (rel → {hash, record, size?, mtimeMs?}). A
  // file whose (size,mtime) key matches skips read+hash entirely (the stat
  // fastpath); one whose content hash is unchanged reuses its record and skips
  // re-extraction.
  cache?: Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }>;
  // Disable the stat fastpath: read and re-hash every file (see BuildOptions).
  fullHash?: boolean;
  // A walk result to use INSTEAD of walking here. MUST come from
  // walk(root, scanWalkOptions(root, <this scan's options>)) — a walk of a
  // different root or with different walk options would silently
  // desynchronize the records from the tree. The one tolerated difference is
  // a walk without the path filter (the MCP server's freshness walk): every
  // file is tested against it again here. Exists for callers that already
  // walked (e.g. a freshness probe) so scanRepo does not pay a second full
  // directory traversal.
  precomputedWalk?: WalkResult;
  // Records a worker pool already extracted (rel → record + the stat the worker
  // itself observed). Consulted after the cache fastpaths and before the read,
  // and only when the worker's stat matches the walk's. Records are built by the
  // shared buildCodeRecord, so a hit is byte-identical to extracting here.
  // Populated by scanRepoParallel — never set this by hand.
  extracted?: Map<string, ExtractedRecord>;
  // Observe every path the scan leaves out, and why (see ScanSkip). A
  // precomputed walk already ran without it: only the scan's own skips are
  // reported then.
  onSkip?: (skip: ScanSkip) => void;
}

// A path the scan leaves out: a walk skip (WalkSkip — ignore rules, size,
// lockfile, binary, filters, symlinks, nested repos), or a file of the index
// the scan must not describe (see selfIndexGuard).
export type ScanSkip = WalkSkip | { rel: string; reason: "index-output"; directory: false; size: number };

export interface ExtractedRecord {
  size: number;
  mtimeMs: number;
  hash: string; // sha1 of the content the worker read
  // Absent when that hash equalled the cache entry's: the worker skipped the
  // extraction whose result the cache's hash-hit branch would discard.
  record?: FileRecord;
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

// The FileRecord for ONE code file. Factored out because the worker pool builds
// records off the main thread and they must be identical to the sequential
// ones, byte for byte — sharing this function is what guarantees that rather
// than two copies of the same logic drifting apart.
export function buildCodeRecord(
  rel: string,
  ext: string,
  size: number,
  content: string,
  hash: string,
  lang: string,
  opts: { maxCallsPerFile?: number } = {},
): FileRecord {
  const record: FileRecord = {
    rel,
    ext,
    size,
    lines: countLines(content),
    hash,
    kind: "code",
    lang,
    headings: [],
    symbols: [],
    refs: [],
  };
  if (content) {
    const code = extractCode(rel, ext, content, { maxCallsPerFile: opts.maxCallsPerFile });
    record.title = basename(rel);
    record.summary = code.summary;
    record.symbols = code.symbols;
    record.refs = code.refs;
    record.pkg = code.pkg;
    record.idents = code.idents;
    record.calls = code.calls;
    record.importedNames = code.importedNames;
    record.truncated = code.truncated;
    record.relations = code.relations;
    record.terms = code.terms;
    record.literals = code.literals;
  } else {
    record.title = basename(rel);
  }
  return record;
}

// RepoScan.docText with the reads deferred. The mention pass needs every doc's
// text, but only when the pipeline actually runs; a warm `index` or a read
// command against a fresh index reuses the artifacts and never asks. Docs used
// to be exempt from the stat fastpath for this reason alone, so every such run
// read and hashed all of them: 7.5k docs, 21.7MB kept in memory, ~250ms on
// typescript-go. A doc the fastpath serves is registered here unread and
// loaded on its first lookup.
//
// A Map subclass so RepoScan.docText keeps its public type. Lookups load one
// doc; anything that enumerates (size, iteration) loads every pending doc
// first, so no consumer can tell a deferred entry from an eager one. Empty
// text is not stored, exactly as the eager path skips it.
class LazyDocText extends Map<string, string> {
  private readonly pending = new Map<string, string>(); // rel → abs, not read yet

  defer(rel: string, abs: string): void {
    this.pending.set(rel, abs);
  }

  private load(rel: string): void {
    const abs = this.pending.get(rel);
    if (abs === undefined) return;
    this.pending.delete(rel);
    const text = readText(abs);
    if (text) super.set(rel, text);
  }

  private loadAll(): void {
    for (const rel of [...this.pending.keys()]) this.load(rel);
  }

  override get(rel: string): string | undefined {
    this.load(rel);
    return super.get(rel);
  }
  override has(rel: string): boolean {
    this.load(rel);
    return super.has(rel);
  }
  override set(rel: string, text: string): this {
    this.pending?.delete(rel); // `?.`: Map's constructor may call set before fields exist
    return super.set(rel, text);
  }
  override delete(rel: string): boolean {
    const deferred = this.pending.delete(rel);
    return super.delete(rel) || deferred;
  }
  override clear(): void {
    this.pending.clear();
    super.clear();
  }
  override get size(): number {
    this.loadAll();
    return super.size;
  }
  override forEach(fn: (text: string, rel: string, map: Map<string, string>) => void, thisArg?: unknown): void {
    this.loadAll();
    super.forEach(fn, thisArg);
  }
  override entries(): MapIterator<[string, string]> {
    this.loadAll();
    return super.entries();
  }
  override keys(): MapIterator<string> {
    this.loadAll();
    return super.keys();
  }
  override values(): MapIterator<string> {
    this.loadAll();
    return super.values();
  }
  override [Symbol.iterator](): MapIterator<[string, string]> {
    return this.entries();
  }
}

// --scope as a repo-relative posix path. Every spelling of one place names the
// same scope — `./src`, `src/`, `src\lib`, an absolute path inside the repo —
// where each used to become a glob that silently matched nothing. A scope
// outside the repo is returned as given and matches nothing; "" means the
// whole repo.
export function normalizeScope(root: string, scope: string): string {
  let s = scope.replace(/\\/g, "/");
  if (isAbsolute(s)) {
    const rel = relative(resolve(root), resolve(s)).split(sep).join("/");
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return s;
    s = rel;
  }
  s = posix.normalize(s).replace(/\/+$/, "");
  return s === "." ? "" : s;
}

// An include/exclude glob with the spellings of the repo root removed: a
// leading `./`, or the repo's own absolute path. Anything else is the glob.
function normalizeGlob(root: string, glob: string): string {
  const abs = resolve(root).split(sep).join("/") + "/";
  let g = glob.startsWith(abs) ? glob.slice(abs.length) : glob;
  while (g.startsWith("./")) g = g.slice(2);
  return g;
}

// The --scope/--include/--exclude test, in the shape of WalkOptions.filter:
// files must pass all three, and a directory is entered only when it can
// still hold such a file. Undefined when none is given.
//
// Applied INSIDE the walk, not to its result. Filtering afterwards let
// --max-files count files the filter then dropped: `--scope src/flask
// --max-files 10` stopped on the first ten root files and kept none of them.
// And a walk that cannot prune stats the whole tree for a one-directory scope.
export function scanPathFilter(root: string, opts: ScanOptions): ((entry: WalkEntry) => boolean) | undefined {
  const scope = opts.scope === undefined ? "" : normalizeScope(root, opts.scope);
  // A scope is a path (a directory, or a single file), matched as the globs
  // `<scope>` and `<scope>/**`, so a glob character in it still works.
  const scopeGlobs = scope ? [scope, `${scope}/**`] : undefined;
  const includeGlobs = opts.include?.map((g) => normalizeGlob(root, g));
  const excludeGlobs = opts.exclude?.map((g) => normalizeGlob(root, g));
  const inScope = compileGlobs(scopeGlobs);
  const include = compileGlobs(includeGlobs);
  const exclude = compileGlobs(excludeGlobs);
  if (!inScope && !include && !exclude) return undefined;
  const scopeDirs = compileDirGlobs(scopeGlobs);
  const includeDirs = compileDirGlobs(includeGlobs);
  const excludeDirs = compileDirExcludes(excludeGlobs);
  return ({ rel, directory }) =>
    directory
      ? (!scopeDirs || scopeDirs(rel)) && (!includeDirs || includeDirs(rel)) && !excludeDirs?.(rel)
      : (!inScope || inScope(rel)) && (!include || include(rel)) && !exclude?.(rel);
}

// Which of --scope/--include/--exclude leaves the file `rel` out, for `scan
// --why`: the scope it lies outside of, the include globs none of which
// matches it, the first exclude glob that does — each as the caller spelled
// it, tested in scanPathFilter's normalized form. undefined when the filter
// keeps the file.
export function explainPathFilter(
  root: string,
  opts: ScanOptions,
  rel: string,
): { scope?: string; include?: string[]; exclude?: string } | undefined {
  const matches = (globs: string[]): boolean => compileGlobs(globs.map((g) => normalizeGlob(root, g)))?.(rel) ?? true;
  const scope = opts.scope === undefined ? "" : normalizeScope(root, opts.scope);
  const out: { scope?: string; include?: string[]; exclude?: string } = {};
  if (scope && !matches([scope, `${scope}/**`])) out.scope = opts.scope;
  if (opts.include?.length && !matches(opts.include)) out.include = opts.include;
  const exclude = opts.exclude?.find((g) => matches([g]));
  if (exclude !== undefined) out.exclude = exclude;
  return out.scope !== undefined || out.include || out.exclude !== undefined ? out : undefined;
}

// The walk a scan with these options performs. ONE builder for every walk that
// feeds a scan — scanRepo's own, the CLI's grammar-warm walk handed over as
// precomputedWalk, scanRepoParallel's and preloadSessionLazy's — so none of
// them can drift from the others (each used to spell the options out, and none
// passed the path filter).
export function scanWalkOptions(root: string, opts: ScanOptions): WalkOptions {
  const filter = scanPathFilter(root, opts);
  return {
    maxFileBytes: opts.maxBytes,
    maxFiles: opts.maxFiles,
    gitignore: opts.gitignore,
    ignoreDirs: opts.ignoreDirs,
    ...(filter ? { filter } : {}),
    ...(opts.onSkip ? { onSkip: opts.onSkip } : {}),
  };
}

// Which walked files this scan keeps, and how each is labelled. Shared by
// scanRepo and scanSummary so the two can never disagree on a file count or a
// language histogram — the summary path is exactly this loop, stopped early.
function* keptFiles(
  root: string,
  opts: ScanOptions,
): Generator<{ f: WalkedFile; kind: FileKind; lang: string }, WalkTotals, void> {
  const walkOpts = scanWalkOptions(root, opts);
  const { files: walked, capped, excluded } = opts.precomputedWalk ?? walk(root, walkOpts);
  // Never index our own output (e.g. a committed `docs/ultraindex/`), or builds
  // would describe the encyclopedia instead of the code.
  const guard = selfIndexGuard(root, opts.out);
  // Re-applied for a precomputed walk that ran without it (see precomputedWalk).
  const filter = opts.precomputedWalk ? walkOpts.filter : undefined;

  for (const f of walked) {
    if (guard && guard(f)) {
      opts.onSkip?.({ rel: f.rel, reason: "index-output", directory: false, size: f.size });
      continue;
    }
    if (filter && !filter({ rel: f.rel, abs: f.abs, directory: false })) {
      opts.onSkip?.({ rel: f.rel, reason: "filter", directory: false, size: f.size });
      continue;
    }
    yield { f, kind: classify(f.rel, f.ext), lang: extToLang(f.ext) };
  }
  return { capped, excluded };
}

interface WalkTotals {
  capped: boolean;
  excluded: number;
}

// The files `codeindex index` writes into its --out dir, plus the
// `<name>.tmp-<pid>` sibling each is staged under before its atomic rename.
const INDEX_ARTIFACTS = ["graph.json", "symbols.json", "cache.json", "embeddings.bin"];
const isIndexArtifact = (name: string): boolean =>
  INDEX_ARTIFACTS.some((a) => name === a || name.startsWith(`${a}.tmp-`));

// Which walked files an --out dir takes out of the scan. Excluding everything
// under --out is right while --out sits INSIDE the repo, but `index --out .`
// (or --out at any ancestor of --repo) put every file under it: the scan came
// back empty, and the run still exited 0 with a 0-file graph. There the only
// files the index itself contributes are its artifacts — directly in --out,
// which for an ancestor is outside the repo, so nothing is excluded at all.
function selfIndexGuard(root: string, out: string | undefined): ((f: WalkedFile) => boolean) | undefined {
  if (!out) return undefined;
  const up = relative(resolve(out), resolve(root));
  if (up === "") return (f) => !f.rel.includes("/") && isIndexArtifact(f.rel);
  if (up !== ".." && !up.startsWith(`..${sep}`) && !isAbsolute(up)) return undefined;
  const dir = out.replace(/\/+$/, "");
  const prefix = dir + "/";
  return (f) => f.abs === dir || f.abs.startsWith(prefix);
}

// The code files this scan would extract, in the same order scanRepo sees them.
// The worker pool builds its job list from here so the set it extracts is
// exactly the set scanRepo would have extracted — no file gets a worker record
// that the sequential loop would have skipped, and vice versa.
export function keptCodeFiles(root: string, opts: ScanOptions = {}): { f: WalkedFile; lang: string }[] {
  const out: { f: WalkedFile; lang: string }[] = [];
  const it = keptFiles(root, opts);
  for (let step = it.next(); !step.done; step = it.next()) {
    if (step.value.kind === "code") out.push({ f: step.value.f, lang: step.value.lang });
  }
  return out;
}

// Every file this scan would keep, unread, in walk order: the file set and the
// stats a freshness check compares against cache.json (status.ts), without a
// record being built.
export function keptWalkedFiles(root: string, opts: ScanOptions = {}): { files: WalkedFile[]; capped: boolean } {
  const files: WalkedFile[] = [];
  const it = keptFiles(root, opts);
  let step = it.next();
  for (; !step.done; step = it.next()) files.push(step.value.f);
  return { files, capped: step.value.capped };
}

// File count + language histogram WITHOUT reading or parsing a single file.
// `codeindex scan` and the MCP `scan_summary` tool only ever report these, but
// used to pay a full scanRepo — i.e. tree-sitter over the whole repo — to get
// them (6.5s on a 7k-file repo, versus ~0.1s here).
export interface ScanSummary {
  root: string;
  commit?: string;
  fileCount: number;
  languages: Record<string, number>;
  capped: boolean;
  excluded: number;
}

export function scanSummary(root: string, opts: ScanOptions = {}): ScanSummary {
  const languages: Record<string, number> = {};
  let fileCount = 0;
  const it = keptFiles(root, opts);
  let step = it.next();
  for (; !step.done; step = it.next()) {
    languages[step.value.lang] = (languages[step.value.lang] ?? 0) + 1;
    fileCount++;
  }
  return { root, commit: headCommit(root), fileCount, languages, capped: step.value.capped, excluded: step.value.excluded };
}

// Walk the repo once and turn every in-scope file into a FileRecord. Pure file
// I/O + deterministic extraction — never reads the repo into the model.
export function scanRepo(root: string, opts: ScanOptions = {}): RepoScan {
  const files: FileRecord[] = [];
  const languages: Record<string, number> = {};
  const docText = new LazyDocText();
  const mtimes = new Map<string, number>();

  // Change-tracking accumulators (see RepoScan.contentUnchanged / cacheDirty).
  // Derived only — nothing below feeds them back into records or ordering.
  const cache = opts.cache;
  // Every kept file so far reused its cached record (fastpath or hash match).
  // Starts false with no cache: nothing can be proven unchanged against nothing.
  let allReused = cache !== undefined;
  // With no cache, persisting one is all new bytes — dirty by definition.
  let cacheDirty = cache === undefined;

  const it = keptFiles(root, opts);
  let step = it.next();
  for (; !step.done; step = it.next()) {
    const { f, kind, lang } = step.value;
    languages[lang] = (languages[lang] ?? 0) + 1;
    mtimes.set(f.rel, f.mtimeMs); // persist the fastpath key for the next build

    const cached = opts.cache?.get(f.rel);

    // Stat fastpath: a file whose size AND mtime both match its cache entry is
    // treated as unchanged and reuses its record WITHOUT a read or hash. A doc
    // is registered for a deferred read instead (see LazyDocText): the mention
    // pass reads it only if the pipeline runs. --full-hash disables the
    // fastpath. The (size,mtime) pair is the heuristic here (not the exact content
    // hash below): a real editor bumps mtime on every save, and --full-hash /
    // --no-index-cache are the escape hatches for the astronomically-unlikely
    // edit that preserves both.
    if (
      !opts.fullHash &&
      cached &&
      cached.size !== undefined &&
      cached.mtimeMs !== undefined &&
      cached.size === f.size &&
      cached.mtimeMs === f.mtimeMs
    ) {
      files.push(cached.record);
      if (kind === "doc") docText.defer(f.rel, f.abs);
      continue;
    }

    // A record a worker already read, hashed and extracted for this exact file
    // (see pool.ts). Accepted only when the worker's own stat agrees with the
    // walk's, so a file rewritten between the two is re-read here instead.
    //
    // It supplies the HASH as well as the record, which is what lets the cache
    // comparison below stay in its original position. Consulting it any earlier
    // would skip the hash-hit branch, and a bare `touch` — same content, new
    // mtime — would then report the scan as changed and rewrite every artifact.
    //
    // A record-less entry (the worker's hash matched the cache) is usable only
    // while it still matches THIS cache entry, which sends it down the hash-hit
    // branch; anything else is read and extracted here.
    const pre = opts.extracted?.get(f.rel);
    const preUsable =
      pre && pre.size === f.size && pre.mtimeMs === f.mtimeMs && (pre.record || pre.hash === cached?.hash)
        ? pre
        : undefined;

    // Read + hash (the staleness oracle stays exact); only EXTRACTION is cached. A
    // hash hit reuses the previous record — content is byte-identical, so every
    // derived field is too. classify()/extToLang() depend only on the path, so
    // kind/lang are stable across the hit.
    const content = preUsable ? undefined : readText(f.abs);
    const hash = preUsable ? preUsable.hash : sha1(content!);
    if (cached && cached.hash === hash) {
      // The hash is over the DECODED text, so it is blind to bytes the decoder
      // drops: every binary hashes as sha1(""), a BOM or a UTF-16 odd trailing
      // byte vanishes. Such a file can change size under an equal hash, and
      // the record kept its stale size for good — the cache entry then missed
      // the stat fastpath on every later run and cache.json was rewritten each
      // time. Every other field derives from the decoded text, so only the
      // size is refreshed.
      files.push(cached.record.size === f.size ? cached.record : { ...cached.record, size: f.size });
      if (kind === "doc" && content) docText.set(f.rel, content);
      // Content proven identical, but a (size, mtimeMs) drift — e.g. a bare
      // touch, or an old cache without stat keys — still rewrites cache bytes.
      if (cached.size !== f.size || cached.mtimeMs !== f.mtimeMs) cacheDirty = true;
      continue;
    }

    // Past both reuse paths: this file is new to the cache or its content
    // changed — the scan is not proven unchanged and the cache must be rewritten.
    allReused = false;
    cacheDirty = true;

    if (preUsable?.record) {
      files.push(preUsable.record);
      continue;
    }

    // Keep code extraction in ONE builder shared with worker threads. A second
    // field-by-field copy here previously omitted `literals`, making parallel
    // and sequential graph output diverge.
    const record: FileRecord = kind === "code"
      ? buildCodeRecord(f.rel, f.ext, f.size, content!, hash, lang, opts)
      : {
          rel: f.rel,
          ext: f.ext,
          size: f.size,
          lines: countLines(content!),
          hash,
          kind,
          lang,
          headings: [],
          symbols: [],
          refs: [],
        };

    if (kind !== "code") {
      if (content && kind === "doc" && MARKDOWN_EXT.has(f.ext)) {
        const md = extractMarkdown(content);
        record.title = md.title ?? basename(f.rel);
        record.summary = md.summary;
        record.headings = md.headings;
        record.refs = md.refs;
      } else if (content && kind === "doc") {
        // Non-markdown prose (.rst/.txt): title from basename, no link graph.
        record.title = basename(f.rel);
      } else if (content && kind === "config") {
        // Config files carry no symbols, but they DO carry values — and a value
        // duplicated across a language boundary is the one no compiler checks.
        record.title = basename(f.rel);
        record.literals = extractConfigLiterals(content);
      } else {
        record.title = basename(f.rel);
      }
    }

    // Retain doc content for the graph's mention pass (docs only) so it is read
    // once here, not a second time from disk.
    if (kind === "doc" && content) docText.set(f.rel, content);

    files.push(record);
  }

  files.sort(byKey((f) => f.rel));
  // File-set equality: reuse requires a cache entry and rels are unique, so
  // with allReused the kept set is a subset of the cache keys — equality is
  // then exactly a count match. A count mismatch (file added, deleted, or
  // newly filtered) also means the persisted key set changes: dirty.
  if (cache !== undefined && files.length !== cache.size) {
    allReused = false;
    cacheDirty = true;
  }
  return {
    root,
    commit: headCommit(root),
    files,
    languages,
    docText,
    mtimes,
    capped: step.value.capped,
    excluded: step.value.excluded,
    contentUnchanged: allReused,
    cacheDirty,
  };
}
