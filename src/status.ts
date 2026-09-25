// `codeindex status` (and the MCP `index_status` tool): does the persisted index
// still describe the worktree, and if not, why not?
//
// Every way an index goes stale degrades silently: a version bump, an edited
// file, an index built with --no-ast, a --index path that holds nothing — each
// just makes the next read command a cold build. Telling them apart took timing
// runs and strace, and a CI job had no way to ask whether a committed index was
// current.
//
// Cheap by construction: read the index's stamps (freshness.json, else
// cache.json), walk, stat. A file whose (size, mtime) matches its entry is
// unchanged — the scan's own fastpath heuristic; only a mismatch is read and
// hashed, and nothing is ever extracted. The verdict is the one the read
// commands and `index` reach: artifactsFresh means both would reuse graph.json
// and symbols.json as they are.
import { ENGINE_VERSION } from "./types.js";
import { extractedAlike } from "./cache.js";
import { classify } from "./classify.js";
import { inspectPersistedIndex, indexDirPath, verifiedBytes, INDEX_DIR, type PersistedMeta, type UnusableIndex } from "./preload.js";
import { keptWalkedFiles, type ScanOptions } from "./scan.js";
import { headCommit } from "./git.js";
import { predictedAst, readFreshness, treeDrift, type FileStamp, type TreeDrift } from "./freshness.js";

export type IndexStaleness =
  | UnusableIndex
  | "engine-version" // the artifacts were written by another engine version
  | "extraction" // some records were extracted at another tier or --max-calls
  | "files" // files were added, deleted or modified since the index
  | "graph.json" // missing, or not the bytes cache.json recorded
  | "symbols.json";

export interface IndexStatus {
  indexDir: string;
  present: boolean; // a cache.json exists there
  usable: boolean; // its records can seed a scan
  reason?: UnusableIndex; // why not, when !usable
  engineVersion: { index: string | null; current: string };
  // A HEAD move alone does not make the artifacts stale: their content is a
  // function of the files, and graph.json's stamp is restamped on read (and by
  // the next `index`). An index committed to the repo never matches the commit
  // that contains it, so counting it would fail every CI check.
  commit: { index: string | null; head: string | null };
  files: TreeDrift | null;
  artifactsFresh: boolean;
  stale: IndexStaleness[]; // why !artifactsFresh, in a fixed order; [] when fresh
}

export interface IndexStatusOptions extends Omit<ScanOptions, "cache" | "precomputedWalk" | "extracted"> {
  // false: the caller extracts at the regex tier (the CLI's --no-ast), so any
  // record extracted at the AST tier is due for re-extraction.
  ast?: boolean;
}

export function indexStatus(repo: string, opts: IndexStatusOptions = {}, indexDir: string = INDEX_DIR): IndexStatus {
  const { ast, ...scanOpts } = opts;
  const dir = indexDirPath(repo, indexDir);
  const head = headCommit(repo) ?? null;
  // freshness.json holds the same stamps without the records; written with the
  // cache.json that is there now, it answers without parsing it.
  const fresh = readFreshness(repo, indexDir);
  const read = fresh ?? inspectPersistedIndex(repo, indexDir);
  if ("unusable" in read) {
    return {
      indexDir: dir,
      present: read.unusable !== "absent",
      usable: false,
      reason: read.unusable,
      engineVersion: { index: null, current: ENGINE_VERSION },
      commit: { index: null, head },
      files: null,
      artifactsFresh: false,
      stale: [read.unusable],
    };
  }
  const meta: PersistedMeta = read.meta;
  const stamps: ReadonlyMap<string, FileStamp> = "files" in read ? read.files : read.cacheMap;
  // The tier a read command would extract at, predicted as preloadSessionLazy
  // predicts it: nothing is loaded here, and nothing needs to be.
  const alike = extractedAlike(meta.extraction, { maxCallsPerFile: scanOpts.maxCallsPerFile, ast: predictedAst(ast) });
  const walked = keptWalkedFiles(repo, scanOpts).files;
  const files = treeDrift(walked, stamps, (f) => alike(classify(f.rel, f.ext), f.ext), scanOpts.fullHash);
  const stale: IndexStaleness[] = [];
  if (meta.engineVersion !== ENGINE_VERSION) stale.push("engine-version");
  if (files.reextract) stale.push("extraction");
  if (files.added || files.deleted || files.modified) stale.push("files");
  if (!verifiedBytes(dir, "graph", meta.graphSha1)) stale.push("graph.json");
  if (!verifiedBytes(dir, "symbols", meta.symbolsSha1)) stale.push("symbols.json");
  return {
    indexDir: dir,
    present: true,
    usable: true,
    engineVersion: { index: meta.engineVersion ?? null, current: ENGINE_VERSION },
    commit: { index: meta.commit ?? null, head },
    files,
    artifactsFresh: stale.length === 0,
    stale,
  };
}
