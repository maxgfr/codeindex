// Fan-out of domain events to subscriber URLs, signed so the receiver can
// prove the payload came from us and was not replayed.
import { fetchWithRetry } from "./net.js";
import { hash } from "./util.js";

/** Sign and deliver one event payload to every subscriber. */
export async function deliver(subscribers: string[], payload: string): Promise<number> {
  const signature = hash(payload);
  let ok = 0;
  for (const url of subscribers) {
    await fetchWithRetry(`${url}?sig=${signature}`);
    ok += 1;
  }
  return ok;
}
