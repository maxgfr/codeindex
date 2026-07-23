// HTTP embedding endpoint client — the "rich" tier SKELETON for v2.11.0. It is
// intentionally NOT wired into the CLI or MCP in v2.10.0: the deterministic
// static tier is the default, and an endpoint's vectors are float and provider-
// dependent (NOT byte-deterministic), so this stays an explicit, opt-in escape
// hatch a future release finalizes. Shipped now only so the module surface is
// stable and the contract is documented.
//
// The contract (v2.11): POST { texts: string[] } → { vectors: number[][] } to
// CODEINDEX_EMBED_ENDPOINT (or opts.url). Node >=18 has global fetch, so this
// stays zero-dependency. The library never orchestrates docker; running such a
// server (e.g. ghcr.io/maxgfr/codeindex-embed) is a user/CI concern.

export interface EmbedEndpointOptions {
  // Endpoint URL. Falls back to CODEINDEX_EMBED_ENDPOINT when omitted.
  url?: string;
  // Abort the request after this many ms (default 30_000).
  timeoutMs?: number;
  // Extra request headers (e.g. an auth token for a private endpoint).
  headers?: Record<string, string>;
}

// Resolve the configured endpoint URL, or undefined when neither opts.url nor
// CODEINDEX_EMBED_ENDPOINT is set — the silent "endpoint tier unavailable" signal.
export function resolveEmbedEndpoint(opts: EmbedEndpointOptions = {}): string | undefined {
  const url = opts.url ?? process.env.CODEINDEX_EMBED_ENDPOINT;
  return url && url.trim() ? url.trim() : undefined;
}

// Request float embeddings for a batch of texts from the endpoint. Throws a
// clear error when no endpoint is configured or the response is malformed; the
// caller decides whether to degrade. NOTE: endpoint vectors are float and are
// NOT part of any determinism guarantee — this path is for the rich tier only.
export async function embedViaEndpoint(texts: string[], opts: EmbedEndpointOptions = {}): Promise<number[][]> {
  const url = resolveEmbedEndpoint(opts);
  if (!url) throw new Error("no embedding endpoint configured (set CODEINDEX_EMBED_ENDPOINT or pass opts.url)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`embedding endpoint ${url} returned HTTP ${res.status}`);
    const data = (await res.json()) as { vectors?: unknown };
    const vectors = data.vectors;
    if (!Array.isArray(vectors) || !vectors.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number"))) {
      throw new Error(`embedding endpoint ${url} returned a malformed { vectors } payload`);
    }
    return vectors as number[][];
  } finally {
    clearTimeout(timer);
  }
}
