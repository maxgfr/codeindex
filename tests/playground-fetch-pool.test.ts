// The playground's download pool, and what it does when the network says no.
//
// This suite exists because of a bug it now pins down. Loading a ~3000-file
// repository fires one request per file at raw.githubusercontent.com, and that
// endpoint rate-limits. When a single file came back 429, the pool rejected —
// but its other 39 workers kept fetching and kept reporting progress, so the
// error the worker posted was immediately overwritten by a later progress
// message. The page sat forever on a frozen counter ("2,875 / 2,913 files"),
// bar still moving, with no indication that the load had already died.
//
// Two properties keep that from coming back, and both are asserted here:
//
//   · a failure STOPS the pool — no further item is started, and whatever is in
//     flight is aborted, so nothing can report progress after the failure;
//   · a single hiccup does not kill a 3000-file load in the first place — 429s,
//     5xx and dropped connections are retried with backoff, because at that
//     volume the chance of never hitting one is nil.
//
// Driven with injected fetch/sleep so the retry schedule is asserted exactly
// rather than waited out.

import { describe, it, expect } from "vitest";

const POOL = new URL("../site/playground/fetch-pool.js", import.meta.url).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const { pooled, fetchWithRetry, RETRY_ATTEMPTS } = (await import(/* @vite-ignore */ POOL)) as Any;

/** A response stand-in — only the fields the pool actually reads. */
const reply = (status: number) => ({ ok: status >= 200 && status < 300, status });

/** Records how long each simulated backoff waited, without waiting. */
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("the playground's download pool", () => {
  it("runs every item when nothing fails", async () => {
    const seen: number[] = [];
    await pooled([1, 2, 3, 4, 5], 2, async (item: number) => void seen.push(item));
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await pooled(Array.from({ length: 50 }, (_, i) => i), 6, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    expect(peak).toBe(6);
  });

  // The regression. Previously the surviving workers drained the whole list,
  // which is what let progress messages outlive the error.
  it("stops starting work once a task fails", async () => {
    const started: number[] = [];
    const items = Array.from({ length: 200 }, (_, i) => i);

    await expect(
      pooled(items, 4, async (item: number) => {
        started.push(item);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (item === 10) throw new Error("rate limited");
      }),
    ).rejects.toThrow("rate limited");

    // Whatever was already in flight may finish, but nothing new may start —
    // so the pool cannot have walked anywhere near the end of the list.
    expect(started.length).toBeLessThan(items.length);
    expect(started.length).toBeLessThanOrEqual(10 + 4);
  });

  it("reports the first failure, not a later one", async () => {
    await expect(
      pooled([1, 2, 3], 1, async (item: number) => {
        throw new Error(`failed on ${item}`);
      }),
    ).rejects.toThrow("failed on 1");
  });

  // The other half of "nothing reports progress after the failure": requests
  // already open are cancelled rather than left to resolve into a dead load.
  it("aborts in-flight work when a task fails", async () => {
    let aborted = false;
    await expect(
      pooled([1, 2], 2, async (item: number, signal: AbortSignal) => {
        if (item === 1) throw new Error("boom");
        await new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve(null);
          });
        });
      }),
    ).rejects.toThrow("boom");
    expect(aborted).toBe(true);
  });
});

describe("fetching one file, with the network misbehaving", () => {
  it("returns a good response without retrying", async () => {
    let calls = 0;
    const { waits, sleep } = fakeSleep();
    const response = await fetchWithRetry("/a.ts", {
      fetchImpl: async () => (calls++, reply(200)),
      sleep,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  // The case that broke the page: one 429 out of 2,913 files.
  it("retries a 429 and succeeds", async () => {
    let calls = 0;
    const { waits, sleep } = fakeSleep();
    const response = await fetchWithRetry("/a.ts", {
      fetchImpl: async () => (++calls < 3 ? reply(429) : reply(200)),
      sleep,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(3);
    expect(waits.length).toBe(2);
    // Backoff must actually back off, or a rate limit is just hammered harder.
    expect(waits[1]).toBeGreaterThan(waits[0]!);
  });

  it("retries a dropped connection and succeeds", async () => {
    let calls = 0;
    const { sleep } = fakeSleep();
    const response = await fetchWithRetry("/a.ts", {
      fetchImpl: async () => {
        if (++calls === 1) throw new TypeError("Failed to fetch");
        return reply(200);
      },
      sleep,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries a 5xx and succeeds", async () => {
    let calls = 0;
    const { sleep } = fakeSleep();
    const response = await fetchWithRetry("/a.ts", {
      fetchImpl: async () => (++calls === 1 ? reply(503) : reply(200)),
      sleep,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  // A file the provider listed but does not serve is NOT a transient fault —
  // jsDelivr's stale branch snapshot produces these in bulk, and retrying every
  // one of them would turn a slow load into an unbearable one.
  it("does not retry a 404", async () => {
    let calls = 0;
    const { waits, sleep } = fakeSleep();
    const response = await fetchWithRetry("/gone.ts", {
      fetchImpl: async () => (calls++, reply(404)),
      sleep,
    });
    expect(response.status).toBe(404);
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it("gives up after a bounded number of attempts and returns the last response", async () => {
    let calls = 0;
    const { sleep } = fakeSleep();
    const response = await fetchWithRetry("/a.ts", {
      fetchImpl: async () => (calls++, reply(429)),
      sleep,
    });
    expect(response.status).toBe(429);
    expect(calls).toBe(RETRY_ATTEMPTS);
  });

  it("stops retrying the moment the load is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { sleep } = fakeSleep();
    await expect(
      fetchWithRetry("/a.ts", {
        fetchImpl: async () => {
          calls++;
          controller.abort();
          throw new DOMException("Aborted", "AbortError");
        },
        signal: controller.signal,
        sleep,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
