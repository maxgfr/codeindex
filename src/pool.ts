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
import * as os from "node:os";
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
const DEFAULT_MIN_PARALLEL_JOBS = 200;

// How many workers to run. `CODEINDEX_WORKERS` wins when set; 0 or 1 means
// sequential. Default leaves a core for the main thread and caps at 8 — past
// that the wasm arena per worker costs more than the wall-clock it saves.
export function workerCount(requested?: number): number {
  const env = process.env["CODEINDEX_WORKERS"];
  const raw = requested ?? (env !== undefined && env !== "" ? Number(env) : undefined);
  if (raw !== undefined) return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  let cores = 1;
  try {
    cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
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
  const workers = Math.min(count, jobs.length);

  // Jobs are handed out in BATCHES, on demand, from the path-sorted queue —
  // not pre-split into one static shard per worker. Static shards assume equal
  // workers; on a heterogeneous CPU (Apple's 4 performance + 6 efficiency
  // cores, most laptops today) the shards that land on slow cores finish
  // last and the whole index waits for them: measured on a 2 358-file repo,
  // eight equal shards ran at 1 ms/file each where one worker alone managed
  // 0.45 ms/file, and eight workers barely beat four. A worker that finishes
  // its batch simply asks for the next, so fast cores take more of the queue.
  // Batches shrink as the queue drains (guided scheduling) so the tail is at
  // most one small batch on the slowest core. Records are keyed by path and
  // scanRepo orders them, so WHICH worker built a record never shows.
  //
  // The bootstrap warms the grammars once (an empty batch), announces the set
  // it got ready, then extracts each batch it is sent through the SAME
  // runExtractWorker a one-shot worker used — the per-record contract has not
  // moved.
  const bootstrap =
    `import { runExtractWorker } from ${JSON.stringify(engineUrl)};\n` +
    `import { parentPort, workerData } from "node:worker_threads";\n` +
    `const base = workerData.input;\n` +
    `const post = (o) => parentPort.postMessage(o);\n` +
    `const fail = (e) => post({ error: String(e) });\n` +
    `runExtractWorker({ ...base, jobs: [] }, post).then(() => {\n` +
    `  parentPort.on("message", (m) => {\n` +
    `    if (m.done) { parentPort.close(); return; }\n` +
    `    runExtractWorker({ ...base, jobs: m.jobs }, post).catch(fail);\n` +
    `  });\n` +
    `}).catch(fail);\n`;

  const out = new Map<string, ExtractedRecord>();
  let next = 0; // index of the first job not yet dispatched
  const takeBatch = (): Job[] => {
    const remaining = jobs.length - next;
    if (remaining <= 0) return [];
    const size = Math.max(MIN_BATCH_JOBS, Math.ceil(remaining / (workers * BATCHES_PER_WORKER)));
    const batch = jobs.slice(next, next + size);
    next += batch.length;
    return batch;
  };

  const spawned: Worker[] = [];
  try {
    await Promise.all(
      Array.from(
        { length: workers },
        () =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(bootstrap, {
              eval: true,
              workerData: { input: { jobs: [], grammarKeys: wanted, maxCallsPerFile: opts.maxCallsPerFile } },
            });
            spawned.push(w);
            let finished = false;
            // A worker that neither answers nor errors would hang the whole
            // index, since Promise.all waits forever. The bound is a deadlock
            // guard, not a performance knob — tripping it costs a fallback to
            // the sequential scan, which is always correct. Re-armed on every
            // message, so it bounds one batch, not the whole run.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const arm = (): void => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => {
                settle(() => reject(new Error("extraction worker timed out")));
                void w.terminate();
              }, WORKER_TIMEOUT_MS);
            };
            const settle = (fn: () => void): void => {
              if (timer) clearTimeout(timer);
              finished = true;
              fn();
            };
            arm();
            // Two batches in flight per worker: the next one is already queued
            // in the worker's mailbox when it posts a result, so it never idles
            // on the main thread's turn to deserialize records and answer.
            let inflight = 0;
            const dispatch = (): boolean => {
              const batch = takeBatch();
              if (batch.length === 0) return false;
              inflight++;
              w.postMessage({ jobs: batch });
              return true;
            };
            w.on("message", (m: WorkerOutput | { error: string }) => {
              if (finished) return;
              if ("error" in m) {
                settle(() => reject(new Error(m.error)));
                void w.terminate();
                return;
              }
              // A worker that readied a different grammar set would produce
              // regex-tier records for some language — discard the whole run
              // rather than emit a mix of tiers.
              if (m.ready.slice().sort().join(",") !== wanted.join(",")) {
                settle(() => reject(new Error("extraction worker grammar tier mismatch")));
                void w.terminate();
                return;
              }
              for (const r of m.records) out.set(r.rel, { size: r.size, mtimeMs: r.mtimeMs, record: r.record });
              if (inflight === 0) dispatch(); // the readiness message: prime a second batch
              else inflight--;
              dispatch();
              if (inflight === 0) {
                settle(() => resolve());
                w.postMessage({ done: true });
                void w.terminate();
                return;
              }
              arm();
            });
            w.once("error", (e) => settle(() => reject(e)));
            w.once("exit", (code) => {
              // Already-settled rejects are no-ops; terminate() itself exits non-zero.
              if (!finished && code !== 0) settle(() => reject(new Error(`extraction worker exited with ${code}`)));
            });
          }),
      ),
    );
    // Every job was dispatched and every dispatched batch came back (a worker
    // only resolves once the queue is empty, and only after its own batch
    // returned) — but a vanished file is dropped by the worker and re-read on
    // the main thread, so the map may legitimately be smaller than `jobs`.
    return out;
  } catch {
    // One failure discards the whole run: stop the others now rather than let
    // them drain a queue nobody will read.
    for (const w of spawned) void w.terminate();
    return undefined;
  }
}

// Guided-scheduling knobs: a batch is `remaining / (workers × BATCHES_PER_WORKER)`
// jobs, never fewer than MIN_BATCH_JOBS. The first batches are large (little
// message traffic), the last ones small (little tail).
const BATCHES_PER_WORKER = 4;
const MIN_BATCH_JOBS = 4;

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
  const workersForced = opts.workers !== undefined || (process.env["CODEINDEX_WORKERS"] ?? "") !== "";
  if (!workersForced && jobs.length < DEFAULT_MIN_PARALLEL_JOBS) return scanRepo(root, scanOpts);

  const grammarKeys = grammarKeysForExts(walked.files.map((f) => f.ext));
  const extracted = await extractInParallel(jobs, grammarKeys, count, { maxCallsPerFile: opts.maxCallsPerFile });
  return scanRepo(root, extracted ? { ...scanOpts, extracted } : scanOpts);
}
