// `node:worker_threads` for the browser build.
//
// pool.ts is optional by construction: its header states that "any failure to
// resolve, spawn, or agree returns undefined and the caller scans as before".
// The browser build additionally replaces pool.ts wholesale with a stub, so
// this module exists only to keep the import graph resolvable — and to make
// isMainThread true, which is the state the sequential path expects.
//
// The playground DOES use a real Worker, but at a level above the engine: the
// whole engine runs inside one DedicatedWorkerGlobalScope so the UI thread
// never blocks. That is the browser's own Worker API, not this shim.

export const isMainThread = true;
export const parentPort = null;
export const workerData = undefined;
export const threadId = 0;

export class Worker {
  constructor() {
    throw new Error("worker_threads is not available in the browser build (the engine runs single-threaded here)");
  }
}

export default { isMainThread, parentPort, workerData, threadId, Worker };
