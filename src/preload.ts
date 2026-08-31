// Reusing a persisted `.codeindex/` index instead of rebuilding it.
//
// `codeindex index` writes graph.json + symbols.json + cache.json. This module
// reads them back, and it does so in two independent steps:
//
//   * cache.json seeds a scan, so every unchanged file takes scan.ts's stat
//     fastpath instead of a read + hash + extraction pass;
//   * when the freshness guard holds, graph.json/symbols.json are deserialized
//     straight in, so the whole downstream pipeline is skipped too.
//
// Both are pure optimizations. Seeded records come from scan.ts's own reuse
// paths, so they are value-identical to a cold scan's, and the guard is the
// SAME oracle the CLI's index fastpath uses to prove the on-disk artifacts equal
// a fresh build. Anything absent, stale, corrupt, or mismatched falls back to
// the cold path exactly — never a throw.
//
// This started life inside the MCP server, which was the only caller. The CLI's
// read commands (search, symbols, callers, graph, repomap, hotspots, deadcode,
// complexity, mermaid, rules) rebuilt from scratch on every invocation, so
// `codeindex search` cost a full tree-sitter pass over the repo every time it
// ran — 6.3s on a 7k-file repo with a fresh index sitting right next to it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_VERSION, EXTRACTOR_VERSION, SCHEMA_VERSION } from "./types.js";
import type { FileRecord, Graph, SymbolIndex } from "./types.js";
import { scanRepo, type RepoScan, type ScanOptions } from "./scan.js";
import type { IndexArtifacts } from "./pipeline.js";
import { sha1 } from "./hash.js";
import { walk, type WalkResult } from "./walk.js";
import { classify } from "./classify.js";

// The default index location, relative to the repo root.
export const INDEX_DIR = ".codeindex";

export type PersistedCacheEntry = { hash: string; record: FileRecord; size?: number; mtimeMs?: number };
export type PersistedCacheMap = Map<string, PersistedCacheEntry>;

// ADDITIVE cache.json meta describing the artifacts a prior `index` run wrote
// (see engine-cli.ts's CacheMeta). Old caches lacking these keys simply never
// pass the guard below — their per-file records are still reused to seed the
// scan. Only the graph/symbols shas matter here; the embed sidecar has its own
// memoization path.
export interface PersistedMeta {
  engineVersion?: string;
  commit?: string;
  graphSha1?: string;
  symbolsSha1?: string;
}

export interface PreloadedSession {
  scan: RepoScan;
  cacheMap: PersistedCacheMap;
  arts?: IndexArtifacts;
  /** Async preload callers defer the large graph/symbol JSON read until needed. */
  loadArtifacts?: () => IndexArtifacts | undefined;
}

// A scan re-expressed as the `ScanOptions.cache` shape (the exact map the CLI
// persists as cache.json): rel → (hash, record, size, mtimeMs), so the next
// scanRepo can take the stat fastpath / hash-match reuse paths against it.
export function toCacheMap(scan: RepoScan): PersistedCacheMap {
  const m: PersistedCacheMap = new Map();
  for (const f of scan.files) m.set(f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: scan.mtimes.get(f.rel) });
  return m;
}

// Whether a persisted scan needs grammars BEFORE its next extraction pass.
// Only code files reach tree-sitter. New/stat-changed code may need parsing;
// docs/config changes and deletions do not. fullHash removes the stat proof, so
// any present code file conservatively warms.
export function needsGrammarWarm(
  walked: WalkResult,
  cache: PersistedCacheMap,
  fullHash = false,
): boolean {
  const codeFiles = walked.files.filter((file) => classify(file.rel, file.ext) === "code");
  return (fullHash && codeFiles.length > 0) || codeFiles.some((file) => {
    const cached = cache.get(file.rel);
    return !cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs;
  });
}

// Read <indexDir>/cache.json into the (cacheMap, meta) the preload needs.
// Per-file records are reusable ONLY when (schemaVersion, extractorVersion)
// match this engine — the exact gate the CLI applies before trusting a cache —
// otherwise the whole cache is discarded (cold scan). Any read/parse failure (no
// index yet, unreadable, malformed) returns undefined: the cold path.
export function readPersistedIndex(
  repo: string,
  indexDir: string = INDEX_DIR,
): { cacheMap: PersistedCacheMap; meta: PersistedMeta } | undefined {
  let parsed:
    | ({ schemaVersion?: number; extractorVersion?: number; files?: Record<string, PersistedCacheEntry> } & PersistedMeta)
    | undefined;
  try {
    parsed = JSON.parse(readFileSync(join(repo, indexDir, "cache.json"), "utf8")) as typeof parsed;
  } catch {
    return undefined;
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || parsed.extractorVersion !== EXTRACTOR_VERSION || !parsed.files) {
    return undefined;
  }
  return {
    cacheMap: new Map(Object.entries(parsed.files)),
    meta: {
      engineVersion: parsed.engineVersion,
      commit: parsed.commit,
      graphSha1: parsed.graphSha1,
      symbolsSha1: parsed.symbolsSha1,
    },
  };
}

// The freshness guard, applied to a scan seeded from cache.json:
// contentUnchanged proves this scan's records are the ones that built the
// on-disk artifacts; engineVersion pins the version stamp graph.json embeds and
// commit the HEAD it embeds; the sha checks prove the on-disk bytes ARE that
// build's output. All true ⇒ graph.json/symbols.json are byte-equal to
// buildArtifactsFromScan(scan) run here, so deserialize them instead of
// rebuilding. Graph/SymbolIndex are pure JSON POJOs (no Map/Set/typed fields),
// so JSON.parse is a lossless round-trip — a schemaVersion assert is the only
// reconstruction needed. ANY failure — a stale scan, a version/commit/sha
// mismatch, a missing/corrupt/partial artifact, an unexpected schemaVersion —
// returns undefined so the caller rebuilds. NEVER throws (a corrupt artifact
// must degrade, not crash the caller).
export function preloadArtifacts(
  repo: string,
  scan: RepoScan,
  meta: PersistedMeta,
  indexDir: string = INDEX_DIR,
): IndexArtifacts | undefined {
  if (
    !scan.contentUnchanged ||
    meta.engineVersion !== ENGINE_VERSION ||
    meta.commit !== scan.commit ||
    meta.graphSha1 === undefined ||
    meta.symbolsSha1 === undefined
  ) {
    return undefined;
  }
  const dir = join(repo, indexDir);
  let graphBytes: Buffer;
  let symbolsBytes: Buffer;
  try {
    graphBytes = readFileSync(join(dir, "graph.json"));
    symbolsBytes = readFileSync(join(dir, "symbols.json"));
  } catch {
    return undefined; // a sha'd artifact went missing since cache.json — rebuild
  }
  // sha over the raw bytes; sha1(string) hashes the same UTF-8 bytes writeFileSync
  // put on disk, so this equals the meta sha the CLI computed over the render.
  if (sha1(graphBytes) !== meta.graphSha1 || sha1(symbolsBytes) !== meta.symbolsSha1) {
    return undefined; // tampered / partial / corrupt on-disk bytes — rebuild
  }
  try {
    const graph = JSON.parse(graphBytes.toString("utf8")) as Graph;
    const symbols = JSON.parse(symbolsBytes.toString("utf8")) as SymbolIndex;
    if (graph.schemaVersion !== SCHEMA_VERSION || symbols.schemaVersion !== SCHEMA_VERSION) return undefined;
    return { scan, graph, symbols };
  } catch {
    // Unreachable once the shas matched (the bytes are valid JSON this engine
    // wrote), but the contract is "never throw" — degrade to a rebuild.
    return undefined;
  }
}

// Seed a scan from cache.json and, when the guard holds, the artifacts from
// graph.json/symbols.json. undefined ⇒ no usable persisted index ⇒ the caller
// takes the cold path unchanged.
export function preloadSession(
  repo: string,
  opts: Omit<ScanOptions, "cache">,
  indexDir: string = INDEX_DIR,
): { scan: RepoScan; cacheMap: PersistedCacheMap; arts?: IndexArtifacts } | undefined {
  const persisted = readPersistedIndex(repo, indexDir);
  if (!persisted) return undefined;
  // Seed the scan from the persisted records — scan.ts's stat fastpath + exact
  // content-hash reuse make this value-identical to a cold scan, only cheaper,
  // and it computes the contentUnchanged the artifact guard reads. When the
  // on-disk content drifted from cache.json, changed files are re-read/extracted
  // here exactly as a cold scan would, so the scan stays correct and the guard
  // simply fails (arts undefined → rebuild on demand).
  const scan = scanRepo(repo, { ...opts, cache: persisted.cacheMap });
  return { scan, cacheMap: toCacheMap(scan), arts: preloadArtifacts(repo, scan, persisted.meta, indexDir) };
}

// Async variant for process boundaries that can defer grammar initialization.
// First inspect the persisted records and walk metadata. The common unchanged
// case loads no tree-sitter wasm; a new/stat-changed path warms BEFORE the one
// extraction pass, so changed files land at the AST tier without a provisional
// regex extraction followed by a second scan.
export async function preloadSessionLazy(
  repo: string,
  opts: Omit<ScanOptions, "cache">,
  warm: () => Promise<void>,
  indexDir: string = INDEX_DIR,
): Promise<PreloadedSession | undefined> {
  const persisted = readPersistedIndex(repo, indexDir);
  if (!persisted) return undefined;
  const walked = opts.precomputedWalk ?? walk(repo, {
    maxFileBytes: opts.maxBytes,
    maxFiles: opts.maxFiles,
    gitignore: opts.gitignore,
    ignoreDirs: opts.ignoreDirs,
  });
  // Decide whether grammars are needed from metadata BEFORE extraction. The old
  // flow first extracted every changed code file without grammars, discovered
  // the scan was stale, then warmed and extracted those files again. A new or
  // stat-changed path may need AST work; deletions, scope-only differences and
  // an unchanged index do not. fullHash deliberately warms because equal stats
  // are no longer a freshness proof in that mode.
  const needsWarm = needsGrammarWarm(walked, persisted.cacheMap, opts.fullHash);
  if (needsWarm) {
    await warm();
  }
  const scan = scanRepo(repo, { ...opts, cache: persisted.cacheMap, precomputedWalk: walked });
  let artifactsTried = false;
  let artifacts: IndexArtifacts | undefined;
  return {
    scan,
    cacheMap: toCacheMap(scan),
    loadArtifacts: () => {
      if (!artifactsTried) {
        artifactsTried = true;
        artifacts = preloadArtifacts(repo, scan, persisted.meta, indexDir);
      }
      return artifacts;
    },
  };
}
