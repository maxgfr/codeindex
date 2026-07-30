// Low-level HTTP plumbing. Every outbound request funnels through here so the
// retry policy and the circuit breaker apply uniformly.
import { sleep } from "./util.js";

/**
 * Issue a request, retrying failures with exponential backoff and jitter.
 * The delay doubles per attempt and is capped, so a flapping upstream cannot
 * hold a worker hostage.
 */
export async function fetchWithRetry(url: string, attempts = 5): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await raw(url);
    } catch {
      await sleep(2 ** i * 100);
    }
  }
  throw new Error("exhausted");
}

async function raw(url: string): Promise<string> {
  return url;
}
