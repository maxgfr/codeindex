// freshness.json: what proving the persisted artifacts fresh needs from
// cache.json — each file's (hash, size, mtime), the artifact shas, the
// versions and the extraction profile — without the records.
//
// The records are what a scan reuses, and nearly all of cache.json's bytes: on
// typescript-go it is 142MB, 2.3s to JSON.parse plus a second of GC. `graph`,
// `symbols`, the graph-only commands and `status` never touch a record, yet
// each paid that parse before printing a byte (5s of a 5s `graph`). The same
// proof over this 10MB file costs 0.2s, leaving the walk as the main cost.
//
// `codeindex index` writes it next to cache.json, recording cache.json's own
// (size, mtime) so a reader can tell the pair was written together. Anything
// missing, stale or malformed here just means the caller falls back to
// cache.json — the answer never depends on this file, only the cost does.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_VERSION, EXTRACTOR_VERSION, SCHEMA_VERSION } from "./types.js";
import { extractedAlike, parseExtractionProfile, type ExtractionProfile } from "./cache.js";
import { grammarReady, resolvableGrammarKeys } from "./ast/loader.js";
import { classify } from "./classify.js";
import { indexDirPath, persistedArtifacts, INDEX_DIR, type PersistedArtifacts, type PersistedMeta } from "./preload.js";
import { keptWalkedFiles, type RepoScan, type ScanOptions } from "./scan.js";
import { readText, type WalkedFile } from "./walk.js";
import { headCommit } from "./git.js";
import { sha1 } from "./hash.js";

export const FRESHNESS_FILE = "freshness.json";

// What the proof keeps of a cache.json entry. PersistedCacheEntry is one too.
export interface FileStamp {
  hash: string;
  size?: number;
  mtimeMs?: number;
}

export interface Freshness {
  meta: PersistedMeta;
  cache: { size: number; mtimeMs: number }; // the cache.json written alongside
  files: Map<string, FileStamp>;
}

// The tier extraction would use for each grammar key, when nothing has been
// loaded yet: what the warm would load (the CLI's --no-ast: nothing). The
// prediction preloadSessionLazy makes before deciding whether to warm.
export function predictedAst(ast?: boolean): (key: string) => boolean {
  if (ast === false) return () => false;
  const resolvable = resolvableGrammarKeys();
  return (key) => grammarReady(key) || resolvable.has(key);
}

export interface TreeDrift {
  indexed: number; // entries recorded
  unchanged: number; // same (size, mtime)
  touched: number; // stat changed, same content: reused, only re-hashed
  modified: number;
  added: number;
  deleted: number;
  reextract: number; // recorded, but extracted at another tier or --max-calls
}

// How the kept files differ from the recorded ones, decided as scan.ts decides
// reuse: a (size, mtime) match is unchanged (unless fullHash), anything else is
// read and hashed — never extracted. `alike` says whether a recorded file was
// extracted the way this run would extract it (see extractedAlike).
export function treeDrift(
  walked: readonly WalkedFile[],
  stamps: ReadonlyMap<string, FileStamp>,
  alike: (f: WalkedFile) => boolean,
  fullHash = false,
): TreeDrift {
  const drift: TreeDrift = { indexed: stamps.size, unchanged: 0, touched: 0, modified: 0, added: 0, deleted: 0, reextract: 0 };
  for (const f of walked) {
    const stamp = stamps.get(f.rel);
    if (!stamp) drift.added++;
    else if (!alike(f)) drift.reextract++;
    else if (!fullHash && stamp.size === f.size && stamp.mtimeMs === f.mtimeMs) drift.unchanged++;
    // The scan's own staleness oracle: sha1 of the decoded text.
    else if (sha1(readText(f.abs)) === stamp.hash) drift.touched++;
    else drift.modified++;
  }
  // Every walked file with a stamp matched one key; the rest of the keys are gone.
  drift.deleted = stamps.size - (walked.length - drift.added);
  return drift;
}

// Whether a drift leaves the records exactly those the artifacts were built
// from — scan.contentUnchanged, reached without a scan.
export const contentUnchanged = (d: TreeDrift): boolean => !(d.added || d.deleted || d.modified || d.reextract);

export function renderFreshness(
  scan: RepoScan,
  meta: Pick<PersistedMeta, "graphSha1" | "symbolsSha1" | "embed">,
  extraction: ExtractionProfile,
  cache: { size: number; mtimeMs: number },
): string {
  const files: Record<string, [string, number, number]> = {};
  for (const f of scan.files) files[f.rel] = [f.hash, f.size, scan.mtimes.get(f.rel)!];
  return (
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      engineVersion: ENGINE_VERSION,
      commit: scan.commit,
      graphSha1: meta.graphSha1,
      symbolsSha1: meta.symbolsSha1,
      embed: meta.embed,
      extraction,
      cache,
      files,
    }) + "\n"
  );
}

const isSha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// freshness.json in the index dir, when it was written for this schema and
// extractor, and next to the cache.json that is there now. undefined otherwise.
export function readFreshness(repo: string, indexDir: string = INDEX_DIR): Freshness | undefined {
  const dir = indexDirPath(repo, indexDir);
  let value: Record<string, unknown>;
  let cacheStat: { size: number; mtimeMs: number };
  try {
    value = JSON.parse(readFileSync(join(dir, FRESHNESS_FILE), "utf8")) as Record<string, unknown>;
    const { size, mtimeMs } = statSync(join(dir, "cache.json"));
    cacheStat = { size, mtimeMs };
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION || value.extractorVersion !== EXTRACTOR_VERSION) {
    return undefined;
  }
  const cache = value.cache as { size?: unknown; mtimeMs?: unknown } | undefined;
  if (!cache || cache.size !== cacheStat.size || cache.mtimeMs !== cacheStat.mtimeMs) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const embed = value.embed as Record<string, unknown> | undefined;
  if (embed !== undefined && (embed === null || typeof embed !== "object")) return undefined;
  if (typeof value.files !== "object" || value.files === null) return undefined;
  const files = new Map<string, FileStamp>();
  for (const [rel, stamp] of Object.entries(value.files as Record<string, unknown>)) {
    if (!Array.isArray(stamp) || !isSha(stamp[0]) || !isCount(stamp[1]) || !isTime(stamp[2])) return undefined;
    files.set(rel, { hash: stamp[0], size: stamp[1], mtimeMs: stamp[2] });
  }
  return {
    meta: {
      engineVersion: str(value.engineVersion),
      commit: str(value.commit),
      graphSha1: str(value.graphSha1),
      symbolsSha1: str(value.symbolsSha1),
      embed: embed && {
        embedVersion: typeof embed.embedVersion === "number" ? embed.embedVersion : undefined,
        modelId: str(embed.modelId),
        sha1: str(embed.sha1),
      },
      extraction: parseExtractionProfile(value.extraction),
    },
    cache: cacheStat,
    files,
  };
}

export type FreshnessScanOptions = Omit<ScanOptions, "cache" | "extracted">;

// freshness.json checked against the tree a scan with these options would
// keep, each code file at the tier `ast` says this run extracts it at — the
// scan's contentUnchanged verdict, reached from the stamps instead of the
// records. undefined when there is no usable freshness.json.
export function proveFresh(
  repo: string,
  opts: FreshnessScanOptions,
  ast: (key: string) => boolean,
  indexDir: string = INDEX_DIR,
): { fresh: Freshness; walked: WalkedFile[]; capped: boolean; drift: TreeDrift; commit?: string } | undefined {
  const fresh = readFreshness(repo, indexDir);
  if (!fresh) return undefined;
  const alike = extractedAlike(fresh.meta.extraction, { maxCallsPerFile: opts.maxCallsPerFile, ast });
  const { files: walked, capped } = keptWalkedFiles(repo, opts);
  const drift = treeDrift(walked, fresh.files, (f) => alike(classify(f.rel, f.ext), f.ext), opts.fullHash);
  return { fresh, walked, capped, drift, commit: headCommit(repo) };
}

// The persisted artifacts, when freshness.json alone proves them fresh for this
// tree under these scan options: the guard persistedArtifacts applies to a
// scan, with the scan's verdict from proveFresh. undefined — and the caller
// takes the cache.json path — otherwise. `fileCount` is how many files the
// proven tree holds.
export function freshArtifacts(
  repo: string,
  opts: FreshnessScanOptions & { ast?: boolean },
  indexDir: string = INDEX_DIR,
): { artifacts: PersistedArtifacts; fileCount: number } | undefined {
  const { ast, ...scanOpts } = opts;
  const proof = proveFresh(repo, scanOpts, predictedAst(ast), indexDir);
  if (!proof || !contentUnchanged(proof.drift)) return undefined;
  const artifacts = persistedArtifacts(repo, { contentUnchanged: true, commit: proof.commit }, proof.fresh.meta, indexDir);
  return artifacts && { artifacts, fileCount: proof.walked.length };
}
