// Everything the long-lived server memoizes: the scan/artifacts LRU keyed on
// (repo, scan options), the embedding corpus index, the static embed model, and
// the per-call grammar warm.
//
// These are the pieces that make a second tool call cheap. They are stateful by
// nature — which is exactly why they belong in one file with the invariants
// written down, rather than scattered through the request handler.
import { statSync } from "node:fs";
import { join } from "node:path";
import { buildArtifactsFromScan, type IndexArtifacts } from "../pipeline.js";
import { scanRepo, scanSummary, type RepoScan, type ScanOptions, type ScanSummary } from "../scan.js";
import { scanRepoParallel } from "../pool.js";
import { needsGrammarWarm, preloadSession, preloadSessionLazy, toCacheMap, type PersistedCacheEntry, type PersistedCacheMap } from "../preload.js";
import { walk, type WalkResult } from "../walk.js";
import { ensureGrammars, grammarKeysForExts } from "../ast/loader.js";
import { resolveEmbedModelDir, loadEmbedModel, type StaticEmbedModel } from "../embed/model.js";
import { type EmbeddingIndex } from "../embed/index.js";
import { sha1 } from "../hash.js";

// --- embedding index memoization --------------------------------------------
// The MCP server process is long-lived, but every `search` call used to redo
// the FULL corpus embedding build — N `buildEndpointIndex` HTTP round-trips,
// or a full `buildEmbeddingIndex` re-encode pass — even when nothing in the
// repo changed between requests. Memoize the last build behind a fingerprint
// of the scan contents plus the tier's identity, so an unchanged repo reuses
// the cached index and any file add/edit/remove (or a switch of endpoint/model)
// still rebuilds. RepoScan carries no fingerprint of its own (checked
// scan.ts/types.ts) — every FileRecord already carries a content hash, so
// hashing the (rel, hash) pairs is the staleness oracle scan.ts itself uses.
export function scanFingerprint(scan: RepoScan): string {
  return sha1(scan.files.map((f) => `${f.rel}:${f.hash}`).join("\n"));
}

export interface EmbeddingIndexCacheKey {
  mode: "endpoint" | "static";
  // Distinguishes cache entries across configs sharing the same scan: the
  // endpoint URL, or the model dir + modelId for the static tier.
  identity: string;
  scan: RepoScan;
}

// A SINGLE entry — never an unbounded map — holding the most recent build.
let embeddingIndexCache: { key: string; index: EmbeddingIndex } | undefined;

// Reuse the cached index when (mode, identity, scanFingerprint) matches the
// last build; otherwise call `build` and cache its result. A failed build is
// NEVER cached (matches today's per-call error behavior: the next request
// retries from scratch, and a still-valid previous entry — under a different
// key — is left untouched).
export async function memoizedEmbeddingIndex(
  key: EmbeddingIndexCacheKey,
  build: () => Promise<EmbeddingIndex> | EmbeddingIndex,
): Promise<EmbeddingIndex> {
  const cacheKey = `${key.mode}:${key.identity}:${scanFingerprint(key.scan)}`;
  if (embeddingIndexCache && embeddingIndexCache.key === cacheKey) return embeddingIndexCache.index;
  const index = await build();
  embeddingIndexCache = { key: cacheKey, index };
  return index;
}

// A SINGLE entry — never an unbounded map — holding the most recent parse.
let embedModelCache: { key: string; model: StaticEmbedModel } | undefined;

// model.json is 10-30 MB with the real asset; reading + JSON.parsing it on
// EVERY request dominates static-tier latency, so the parsed model is memoized
// across requests. One statSync per request keys the cache on
// (dir, mtimeMs, size) so an in-place re-pull invalidates on the next call.
// Same discipline as memoizedEmbeddingIndex: a failed load is NEVER cached —
// the throw propagates and the cache is left as it was, so the next request
// retries from scratch. A missing model.json returns undefined (the
// not-present case, exactly like loadEmbedModel).
export function memoizedEmbedModel(modelDir: string): StaticEmbedModel | undefined {
  let stat;
  try {
    stat = statSync(join(modelDir, "model.json"));
  } catch {
    return undefined;
  }
  const key = `${modelDir}:${stat.mtimeMs}:${stat.size}`;
  if (embedModelCache && embedModelCache.key === key) return embedModelCache.model;
  const model = loadEmbedModel(modelDir);
  if (model) embedModelCache = { key, model };
  return model;
}

// --- session-level scan + artifacts memoization ------------------------------
// Same single-entry discipline as the embedding caches above: the MCP server
// process is long-lived, but every tool call used to redo a FULL scanRepo walk
// + read + hash + extraction pass (and, for graph-shaped tools, the whole
// pipeline) even when nothing in the repo changed between requests. Cache the
// last (repo, scan-opts) scan and feed its records back to scanRepo as `cache`
// on the next call — scan.ts's EXISTING stat-fastpath + exact-hash machinery
// is the freshness oracle, so a cache hit costs one walk + per-file stats, not
// reads. When the oracle proves the content unchanged the SAME RepoScan object
// is returned, which keeps the per-scan WeakMap of derived structures
// (src/derived.ts) warm across requests. Artifacts are memoized on scan object
// identity. Rendered strings are NEVER memoized — a big repo's graph.json runs
// tens of MB, so renders stay per-call while the expensive structures behind
// them are reused.
//
// Determinism: reused records come from scan.ts's own reuse paths (stat
// fastpath / exact content-hash match), which produce records value-identical
// to a from-scratch scan — artifacts stay byte-identical; only repeated work
// disappears.

// The scan options a session entry is keyed on. `cache`/`precomputedWalk` are
// excluded from the contract: the session cache OWNS the cache it feeds back,
// and a caller-supplied stale walk would desynchronize the freshness oracle.
export type SessionScanOptions = Omit<ScanOptions, "cache" | "precomputedWalk">;

type SessionCacheEntry = PersistedCacheEntry;
type SessionCacheMap = PersistedCacheMap;

interface SessionEntry {
  key: string;
  scan: RepoScan;
  cacheMap: SessionCacheMap;
  arts?: IndexArtifacts;
  loadArtifacts?: () => IndexArtifacts | undefined;
}

// A SMALL bounded LRU — never an unbounded map.
//
// This was a single entry, which made two entirely normal agent behaviours
// pathological: alternating between two repos, and alternating between two
// `scope` values on one repo. Either one evicted the other on every call, so
// every call paid a full cold rebuild. Four entries covers those patterns while
// keeping the memory story the same order of magnitude as before.
const SESSION_CACHE_MAX = 4;
const sessionCaches: SessionEntry[] = []; // most-recently-used first

function sessionGet(key: string): SessionEntry | undefined {
  const i = sessionCaches.findIndex((e) => e.key === key);
  if (i < 0) return undefined;
  const [entry] = sessionCaches.splice(i, 1);
  sessionCaches.unshift(entry!);
  return entry;
}

function sessionPut(entry: SessionEntry): SessionEntry {
  const i = sessionCaches.findIndex((e) => e.key === entry.key);
  if (i >= 0) sessionCaches.splice(i, 1);
  sessionCaches.unshift(entry);
  sessionCaches.length = Math.min(sessionCaches.length, SESSION_CACHE_MAX);
  return entry;
}

// Drop every entry. Used by the symbolic-edit tools: an edit landing in the same
// mtime tick with the same byte count would pass the (size, mtimeMs) fastpath
// and serve a stale scan.
export function sessionClear(): void {
  sessionCaches.length = 0;
}

// Invalidate only the watched repository while retaining its incremental
// records and every other repo in the LRU. Removing one known path defeats the
// same-size/same-mtime fastpath for that file; an unknown filename keeps the
// entry but drops all record fastpaths. The next request still walks/stats and
// proves the complete repository state before returning anything.
export function sessionInvalidate(repo: string, rel?: string): void {
  const prefix = repo + "\0";
  for (const entry of sessionCaches) {
    if (!entry.key.startsWith(prefix)) continue;
    if (rel) entry.cacheMap.delete(rel);
    else entry.cacheMap.clear();
  }
}

// Fixed property order (and JSON.stringify dropping undefined) keeps the key
// deterministic regardless of how the caller assembled the options object.
export function sessionKey(repo: string, opts: SessionScanOptions): string {
  return (
    repo +
    "\0" +
    JSON.stringify({
      scope: opts.scope,
      include: opts.include,
      exclude: opts.exclude,
      gitignore: opts.gitignore,
      ignoreDirs: opts.ignoreDirs,
      maxBytes: opts.maxBytes,
      maxFiles: opts.maxFiles,
      maxCallsPerFile: opts.maxCallsPerFile,
      out: opts.out,
      fullHash: opts.fullHash,
    })
  );
}

// Re-exported for tests and for consumers that imported it from here before the
// preload machinery moved into src/preload.ts.
export { toCacheMap };

// The memoizing replacement for scanRepo inside callTool. Exported for tests.
export function getScan(repo: string, opts: SessionScanOptions = {}, walked?: WalkResult): RepoScan {
  const key = sessionKey(repo, opts);
  const hit = sessionGet(key);
  if (hit) {
    const fresh = scanRepo(repo, { ...opts, cache: hit.cacheMap, precomputedWalk: walked });
    if (fresh.contentUnchanged) {
      // Content proven identical → return the SAME object (object identity is
      // what keeps derived.ts's WeakMap and the memoized artifacts warm). A
      // stat-only drift (e.g. a bare touch) still refreshes the cache map so
      // the next call's stat fastpath keys on the new (size, mtimeMs).
      if (fresh.cacheDirty) hit.cacheMap = toCacheMap(fresh);
      // `commit` (headCommit(root)) is NOT part of the stat/hash freshness
      // oracle: a git HEAD move that leaves the worktree untouched — commit /
      // commit --amend / reset --soft / checkout to an identical-tree branch —
      // changes headCommit without altering any file's size or mtime, so
      // contentUnchanged stays true while the cached scan's commit went stale.
      // `fresh` recomputed it just now (exactly what a cold process reports), so
      // sync it onto the returned object; otherwise graph/scan metadata would
      // expose the old HEAD. Mutate the SAME scan object to preserve derived
      // indexes, but rebuild artifacts because Graph itself carries `commit`.
      if (hit.scan.commit !== fresh.commit) {
        hit.scan.commit = fresh.commit;
        hit.arts = undefined;
        hit.loadArtifacts = undefined;
      }
      return hit.scan;
    }
    sessionPut({ key, scan: fresh, cacheMap: toCacheMap(fresh) });
    return fresh;
  }
  // First touch of this (repo, opts): try the persisted-index preload before a
  // cold scan. A present, version-compatible .codeindex/cache.json seeds the
  // scan (and, when the guard holds, the artifacts); absent it, fall through to
  // the cold path EXACTLY as before.
  const preloaded = preloadSession(repo, { ...opts, precomputedWalk: walked });
  if (preloaded) {
    sessionPut({
      key,
      scan: preloaded.scan,
      cacheMap: preloaded.cacheMap,
      arts: preloaded.arts,
    });
    return preloaded.scan;
  }
  const scan = scanRepo(repo, { ...opts, precomputedWalk: walked });
  sessionPut({ key, scan, cacheMap: toCacheMap(scan) });
  return scan;
}

// Async cold-start companion used by the MCP request boundary. Existing warm
// entries and persisted indexes keep their proven cache paths; only a genuinely
// cold repo is extracted across workers. The resulting scan is inserted into
// the same LRU, so every synchronous query helper below observes one object and
// all derived WeakMap caches retain their identity semantics.
export async function getScanParallel(
  repo: string,
  opts: SessionScanOptions = {},
  walked?: WalkResult,
  warm: () => Promise<void> = async () => {},
): Promise<RepoScan> {
  const key = sessionKey(repo, opts);
  const existing = sessionCaches.find((entry) => entry.key === key);
  if (existing) {
    const originalCache = existing.cacheMap;
    const reuseUnchanged = (fresh: RepoScan): RepoScan => {
      if (fresh.cacheDirty) existing.cacheMap = toCacheMap(fresh);
      if (existing.scan.commit !== fresh.commit) {
        existing.scan.commit = fresh.commit;
        existing.arts = undefined;
        existing.loadArtifacts = undefined;
      }
      sessionGet(key);
      return existing.scan;
    };

    // A metadata change in a code file requires grammars, but not a throwaway
    // provisional extraction. Warm first and perform exactly one parallel scan.
    if (walked && needsGrammarWarm(walked, originalCache, opts.fullHash)) {
      await warm();
      const fresh = await scanRepoParallel(repo, { ...opts, cache: originalCache, precomputedWalk: walked });
      if (fresh.contentUnchanged) return reuseUnchanged(fresh);
      sessionPut({ key, scan: fresh, cacheMap: toCacheMap(fresh) });
      return fresh;
    }

    const provisional = scanRepo(repo, { ...opts, cache: originalCache, precomputedWalk: walked });
    if (provisional.contentUnchanged) {
      return reuseUnchanged(provisional);
    }
    // With a walk, the metadata proof above established that only docs/config,
    // deletions or scope changed; the provisional scan is already final. The
    // no-walk fallback retains the conservative warm + rescan contract.
    if (walked) {
      sessionPut({ key, scan: provisional, cacheMap: toCacheMap(provisional) });
      return provisional;
    }
    await warm();
    const scan = await scanRepoParallel(repo, { ...opts, cache: originalCache, precomputedWalk: walked });
    sessionPut({ key, scan, cacheMap: toCacheMap(scan) });
    return scan;
  }

  const preloaded = await preloadSessionLazy(repo, { ...opts, precomputedWalk: walked }, warm);
  if (preloaded) {
    sessionPut({
      key,
      scan: preloaded.scan,
      cacheMap: preloaded.cacheMap,
      arts: preloaded.arts,
      loadArtifacts: preloaded.loadArtifacts,
    });
    return preloaded.scan;
  }

  await warm();
  const scan = await scanRepoParallel(repo, { ...opts, precomputedWalk: walked });
  sessionPut({ key, scan, cacheMap: toCacheMap(scan) });
  return scan;
}

// The scan_summary numbers, without paying for a scan.
//
// A file count and a language histogram come from the walk plus the path-based
// classifiers — no read, no hash, no tree-sitter. Always use that path-only
// operation, even when the session holds a scan: refreshing a changed file from
// this grammar-free path would replace an AST record with a regex-tier record.
// The summary is NEVER written into the session cache: it carries no
// FileRecords, so caching it would starve every record-shaped tool that ran next.
export function getScanSummary(repo: string, opts: SessionScanOptions = {}, walked?: WalkResult): ScanSummary {
  // Never refresh a record-shaped session here: this path intentionally loads
  // no grammar, so extracting a changed file would poison later AST queries
  // with a regex-tier record. The path-only summary is already the cheap and
  // exact operation this tool needs.
  return scanSummary(repo, { ...opts, precomputedWalk: walked });
}

// Lazy pipeline memoized on scan OBJECT IDENTITY: graph-shaped tools reuse the
// artifacts exactly as long as getScan keeps returning the same scan object.
// Exported for tests.
export function getArtifacts(repo: string, opts: SessionScanOptions = {}, walked?: WalkResult, prepared?: RepoScan): IndexArtifacts {
  const scan = prepared ?? getScan(repo, opts, walked);
  const entry = sessionCaches.find((e) => e.scan === scan);
  if (entry) return (entry.arts ??= entry.loadArtifacts?.() ?? buildArtifactsFromScan(scan, opts));
  // Defensive fallback (getScan always leaves an entry holding `scan`).
  return buildArtifactsFromScan(scan, opts);
}

// Warm the grammars for the languages CURRENTLY present in `repo`, re-derived on
// EVERY scan-needing call — never frozen on first touch. The server no longer
// warms every committed grammar at startup; most sessions touch one repo and a
// handful of languages, so each scan-needing tool warms the walk-derived set
// itself. It MUST re-derive per call because the session cache (getScan) is built
// to pick up mid-session file adds/edits/removes: a language whose first file
// appears only AFTER the initial scan-needing call must still get its grammar
// warmed, or that file falls to the regex tier and its symbols diverge from a
// cold build on the identical on-disk state — a byte-identity break. (A per-
// repo-path memo froze the grammar set at first touch and silently missed
// exactly this case.) ensureGrammars is idempotent and near-free once a grammar
// is loaded — it warms only newly-seen keys — so the sole repeated cost is the
// walk; the wasm for a given language loads at most once. Determinism: the walk's
// extension set is a superset of what scanRepo keeps (scope/include/exclude only
// filter further), so every extracted file has its grammar loaded; Language.load
// calls are independent, so warming fewer grammars cannot alter the parse of a
// loaded one.
export async function warmGrammarsForRepo(repo: string): Promise<void> {
  await warmGrammarsForWalk(walk(repo, {}));
}

// The same warm, against a walk the caller already has.
//
// callTool used to walk TWICE per scan-needing call: once here to derive the
// present languages, then again inside scanRepo. On a large repo that fixed cost
// dominated every response (the project's own benchmark shows find-symbol,
// references and file-overview all landing within a few ms of each other on a
// 20k-file monorepo — the signature of a per-call constant, not of the query).
// One walk now feeds both.
export async function warmGrammarsForWalk(walked: WalkResult): Promise<void> {
  await ensureGrammars(grammarKeysForExts(walked.files.map((f) => f.ext)));
}
