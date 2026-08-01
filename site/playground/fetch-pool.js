// Downloading a repository's files: bounded concurrency, and what to do when
// the network refuses.
//
// Split out of worker.js for the same reason commands.js is — worker.js owns
// `self` and postMessage and cannot be imported in Node, and this is the part
// whose failure modes are worth pinning down. tests/playground-fetch-pool.test.ts
// drives both functions with an injected fetch and an injected sleep.
//
// The shape of the problem: one request per file (no provider offers a bundle a
// browser can read — see sources.js), so a 3,000-file repository is 3,000
// requests at raw.githubusercontent.com, which rate-limits. At that volume,
// "the network never once says no" is not an assumption worth making, so:
//
//   · a transient refusal is RETRIED rather than fatal — one 429 out of 2,913
//     files used to lose the whole load;
//   · a refusal that survives the retries STOPS THE POOL — no new item starts
//     and everything in flight is aborted, so nothing can keep reporting
//     progress for a load that has already failed.
//
// That second point is what a plain Promise.all cannot express: it rejects on
// the first failure while its other workers carry blithely on.

/** Attempts per file, first try included. */
export const RETRY_ATTEMPTS = 4;

/** First backoff, doubled per attempt. */
const RETRY_BASE_MS = 400;

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task` over `items` with at most `limit` in flight, stopping everything
 * at the first failure.
 *
 * `task` receives an AbortSignal that fires when any worker throws; pass it to
 * fetch so open requests are cancelled instead of resolving into a load that no
 * longer exists. Rejects with the FIRST error — later ones are consequences of
 * it (typically the abort itself) and would only mislead.
 */
export async function pooled(items, limit, task) {
  const controller = new AbortController();
  let cursor = 0;
  let failure;

  const fail = (error) => {
    // First error wins. AbortError is never the interesting one: it is what
    // this very controller did to the other workers.
    failure ??= error;
    controller.abort();
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length && !controller.signal.aborted) {
        try {
          await task(items[cursor++], controller.signal);
        } catch (error) {
          fail(error);
        }
      }
    }),
  );

  if (failure) throw failure;
}

/**
 * Fetch one URL, retrying the faults that pass.
 *
 * Retried: 429 (rate limit), 5xx, and a rejected fetch (dropped connection,
 * DNS blip). Not retried: any other status. A 404 in particular is a real
 * answer — jsDelivr's branch snapshot lists files it no longer serves, and
 * retrying each of those four times would make a stale manifest agonising
 * rather than merely lossy. The caller counts those as unreadable.
 *
 * Returns the last response when the attempts run out, so the caller can tell a
 * rate limit apart from a missing file and say so.
 */
export async function fetchWithRetry(url, { fetchImpl = fetch, signal, attempts = RETRY_ATTEMPTS, sleep = sleepFor } = {}) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    let response;

    try {
      response = await fetchImpl(url, signal ? { signal } : undefined);
    } catch (error) {
      // An abort is the pool shutting this load down — never something to
      // retry, and never something to swallow.
      if (signal?.aborted || last) throw error;
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok || last || !retryable(response.status)) return response;
    if (signal?.aborted) return response;
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }
}

const retryable = (status) => status === 429 || status >= 500;
