// Parallel extraction across worker_threads.
//
// Cold indexing is ~90% per-file extraction, and extractCode is a pure function
// of (rel, ext, content) — so it parallelises exactly. Measured on
// facebook/react (4343 JS/TS files, 10-core M5): 4.04s sequential -> 0.94s on
// eight workers, with peak RSS BELOW the single-threaded full index because
// each worker's tree-sitter wasm arena is torn down when it exits (nothing
// inside one process ever returns that memory).
//
// Determinism is not weakened. Records come back out of order and are keyed by
// path, and scanRepo assembles + sorts exactly as it always did; every record is
// built by the SAME buildCodeRecord the sequential path uses. The one way a
// worker could produce a different record is by having a different grammar tier
// than the main thread — so workers report the grammars they actually loaded and
// any disagreement aborts the whole parallel run back to sequential.
//
// Sequential fallback is always available and always correct: any failure to
// resolve, spawn, or agree returns undefined and the caller scans as before.
import { existsSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { FileRecord } from "./types.js";
import { sha1 } from "./hash.js";
import { readText, walk } from "./walk.js";
import { extToLang } from "./lang/registry.js";
import { ensureGrammars, grammarKeysForExts, grammarReady } from "./ast/loader.js";
import { buildCodeRecord, keptCodeFiles, scanRepo, type ExtractedRecord, type RepoScan, type ScanOptions } from "./scan.js";

// One unit of work: a code file to read, hash and extract.
interface Job {
  abs: string;
  rel: string;
  ext: string;
}

interface WorkerInput {
  jobs: Job[];
  grammarKeys: string[];
  maxCallsPerFile?: number;
}

interface WorkerOutput {
  // The grammar keys this worker actually got ready. Compared against the main
  // thread's — a mismatch means this worker would have silently used the regex
  // tier for some language, so the run is discarded.
  ready: string[];
  records: { rel: string; size: number; mtimeMs: number; record: FileRecord }[];
}

// The URL a worker should import to reach THIS engine.
//
// Resolved the way grammars are (src/ast/loader.ts): look next to the running
// module. When the bundle is the file itself (`scripts/engine.mjs`, whether from
// npm or vendored) that is the module; when a consumer has re-bundled the engine
// into their own entry, `engine.mjs` is not adjacent and we return undefined so
// the caller stays sequential — importing THEIR bundle in a worker would run
// their top-level code, which is exactly the hazard src/engine.ts:215 warns
// about.
function resolveEngineUrl(): string | undefined {
  try {
    const here = fileURLToPath(import.meta.url);
    if (here.endsWith("engine.mjs")) return pathToFileURL(here).href;
    const adjacent = join(dirname(here), "engine.mjs");
    if (existsSync(adjacent)) return pathToFileURL(adjacent).href;
    return undefined;
  } catch {
    return undefined;
  }
}

// Deadlock guard for a worker that never answers. Generous on purpose: a shard
// of a very large repo can legitimately take minutes, and tripping this only
// costs a fallback to the sequential scan.
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;

// How many workers to run. `CODEINDEX_WORKERS` wins when set; 0 or 1 means
// sequential. Default leaves a core for the main thread and caps at 8 — past
// that the wasm arena per worker costs more than the wall-clock it saves.
export function workerCount(requested?: number): number {
  const env = process.env["CODEINDEX_WORKERS"];
  const raw = requested ?? (env !== undefined && env !== "" ? Number(env) : undefined);
  if (raw !== undefined) return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  let cores = 1;
  try {
    cores = availableParallelism();
  } catch {
    cores = 1;
  }
  return Math.max(0, Math.min(cores - 1, 8));
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

// Runs inside a worker: load the grammars, then read/hash/extract each job.
// Exported (and named) so the bootstrap below can find it by name — that lookup
// failing is itself the signal that we imported something that is not this
// engine, and the worker exits without touching the caller's data.
export async function runExtractWorker(input: WorkerInput, post: (out: WorkerOutput) => void): Promise<void> {
  await ensureGrammars(input.grammarKeys);
  const ready = input.grammarKeys.filter((k) => grammarReady(k));
  const records: WorkerOutput["records"] = [];
  for (const job of input.jobs) {
    let size: number;
    let mtimeMs: number;
    try {
      const st = statSync(job.abs);
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // vanished mid-run — the main thread re-reads it (and drops it)
    }
    const content = readText(job.abs);
    const record = buildCodeRecord(job.rel, job.ext, size, content, sha1(content), extToLang(job.ext), {
      maxCallsPerFile: input.maxCallsPerFile,
    });
    records.push({ rel: job.rel, size, mtimeMs, record });
  }
  post({ ready, records });
}

// ---------------------------------------------------------------------------
// Main side
// ---------------------------------------------------------------------------

// Extract `jobs` across `count` workers. Returns undefined — meaning "scan
// sequentially" — when workers cannot be used or cannot be trusted:
//   * the engine URL does not resolve to an on-disk engine.mjs,
//   * a worker fails to spawn, errors, or reports an error payload,
//   * a worker's ready grammar set differs from the main thread's.
// Never throws.
export async function extractInParallel(
  jobs: Job[],
  grammarKeys: string[],
  count: number,
  opts: { maxCallsPerFile?: number } = {},
): Promise<Map<string, ExtractedRecord> | undefined> {
  if (count < 2 || jobs.length === 0) return undefined;
  const engineUrl = resolveEngineUrl();
  if (!engineUrl) return undefined;

  // Ask workers for exactly the grammars the MAIN THREAD has ready — not for
  // every grammar the repo's extensions imply.
  //
  // This is what makes the tiers agree by construction. Under `--no-ast` (or any
  // caller that never warmed grammars) the main thread would extract with regex,
  // so the workers must too; asking for the walk-derived set instead would have
  // them load wasm, produce AST-tier records, mismatch, and silently drop the
  // whole run back to sequential — losing parallelism on exactly the tier where
  // it is cheapest.
  const wanted = grammarKeys.filter((k) => grammarReady(k)).sort();

  // Round-robin over the path-sorted job list, so every shard sees the same
  // language mix and no shard loads a grammar the others don't.
  const shards: Job[][] = Array.from({ length: Math.min(count, jobs.length) }, () => []);
  jobs.forEach((j, i) => shards[i % shards.length]!.push(j));

  const bootstrap =
    `import { runExtractWorker } from ${JSON.stringify(engineUrl)};\n` +
    `import { parentPort, workerData } from "node:worker_threads";\n` +
    `runExtractWorker(workerData.input, (o) => parentPort.postMessage(o))` +
    `.catch((e) => parentPort.postMessage({ error: String(e) }));\n`;

  try {
    const outputs = await Promise.all(
      shards.map(
        (jobsForShard) =>
          new Promise<WorkerOutput | { error: string }>((resolve, reject) => {
            const w = new Worker(bootstrap, {
              eval: true,
              workerData: { input: { jobs: jobsForShard, grammarKeys: wanted, maxCallsPerFile: opts.maxCallsPerFile } },
            });
            // A worker that neither answers nor errors would hang the whole
            // index, since Promise.all waits forever. The bound is a deadlock
            // guard, not a performance knob — tripping it costs a fallback to
            // the sequential scan, which is always correct.
            const timer = setTimeout(() => {
              reject(new Error("extraction worker timed out"));
              void w.terminate();
            }, WORKER_TIMEOUT_MS);
            const settle = (fn: () => void): void => {
              clearTimeout(timer);
              fn();
            };
            w.once("message", (m: WorkerOutput | { error: string }) => {
              settle(() => resolve(m));
              void w.terminate();
            });
            w.once("error", (e) => settle(() => reject(e)));
            w.once("exit", (code) => {
              // Already-settled rejects are no-ops; terminate() itself exits non-zero.
              if (code !== 0) settle(() => reject(new Error(`extraction worker exited with ${code}`)));
            });
          }),
      ),
    );

    const out = new Map<string, ExtractedRecord>();
    for (const o of outputs) {
      if ("error" in o) return undefined;
      // A worker that readied a different grammar set would have produced
      // regex-tier records for some language — discard the whole run rather
      // than emit a mix of tiers.
      if (o.ready.slice().sort().join(",") !== wanted.join(",")) return undefined;
      for (const r of o.records) out.set(r.rel, { size: r.size, mtimeMs: r.mtimeMs, record: r.record });
    }
    return out;
  } catch {
    return undefined;
  }
}

// scanRepo, with the code files extracted across workers.
//
// The parallel part is strictly a pre-pass: it produces the SAME records
// scanRepo would have built, hands them over via ScanOptions.extracted, and
// scanRepo then runs its normal loop — cache fastpaths, docs, ordering and
// change-tracking all unchanged. Anything that prevents or invalidates the
// parallel pass simply leaves `extracted` empty, and the result is exactly a
// sequential scan.
//
// `opts.workers` overrides the worker count (0/1 = sequential); absent, see
// workerCount() and CODEINDEX_WORKERS.
export async function scanRepoParallel(
  root: string,
  opts: ScanOptions & { workers?: number } = {},
): Promise<RepoScan> {
  const count = workerCount(opts.workers);
  if (count < 2) return scanRepo(root, opts);

  // Walk ONCE and reuse it for both the job list and the scan itself.
  const walked =
    opts.precomputedWalk ??
    walk(root, {
      maxFileBytes: opts.maxBytes,
      maxFiles: opts.maxFiles,
      gitignore: opts.gitignore,
      ignoreDirs: opts.ignoreDirs,
    });
  const scanOpts: ScanOptions = { ...opts, precomputedWalk: walked };

  // Only code files are worth shipping out: docs must be read on the main
  // thread anyway (the graph's mention pass needs their text), and everything
  // else is a read plus a hash with no extraction behind it.
  //
  // Files the cache will serve by its stat fastpath are skipped — extracting
  // them would be work whose result scanRepo discards.
  const jobs: Job[] = [];
  for (const { f } of keptCodeFiles(root, scanOpts)) {
    const cached = opts.cache?.get(f.rel);
    if (
      !opts.fullHash &&
      cached &&
      cached.size !== undefined &&
      cached.mtimeMs !== undefined &&
      cached.size === f.size &&
      cached.mtimeMs === f.mtimeMs
    ) {
      continue;
    }
    jobs.push({ abs: f.abs, rel: f.rel, ext: f.ext });
  }
  if (jobs.length === 0) return scanRepo(root, scanOpts);

  const grammarKeys = grammarKeysForExts(walked.files.map((f) => f.ext));
  const extracted = await extractInParallel(jobs, grammarKeys, count, { maxCallsPerFile: opts.maxCallsPerFile });
  return scanRepo(root, extracted ? { ...scanOpts, extracted } : scanOpts);
}
