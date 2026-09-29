// HTTP embedding endpoint client — the "rich" tier (v2.11.0). The engine becomes
// a CONSUMER of a local containerized embedding server (e.g.
// ghcr.io/maxgfr/codeindex-embed): it POSTs corpus/query texts, receives float
// vectors, and runs them through the EXACT SAME L2-normalize + int8-quantize
// pipeline as the static tier (encode.ts `quantize`), so ranking stays a pure
// integer dot product. Node >=18 has global fetch, so this stays zero-dependency.
//
// The contract: POST { texts: string[] } → { vectors: number[][] } to
// `${base}/embed`, plus GET `${base}/healthz`. `base` is CODEINDEX_EMBED_ENDPOINT
// (or opts.url). The library NEVER orchestrates docker; running the server is a
// user/CI concern (`codeindex embed serve` only prints/runs the docker command).
//
// DETERMINISM: this tier is deterministic PER IMAGE DIGEST (the model is baked
// into a pinned image), NOT byte-golden — endpoint float vectors are provider-
// dependent. That is why endpoint indexes are built at search time and never
// serialized to embeddings.bin (which carries a determinism guarantee).

import type { RepoScan } from "../scan.js";
import { sha1 } from "../hash.js";
import { quantize } from "./encode.js";
import { EMBED_VERSION } from "./model.js";
import { embeddingUnits, reusableVectors, unitHash, unitRecord, type EmbeddingIndex, type EmbeddingRecord } from "./index.js";

export interface EmbedEndpointOptions {
  // Endpoint BASE url (e.g. http://localhost:8756). Falls back to
  // CODEINDEX_EMBED_ENDPOINT when omitted.
  url?: string;
  // Abort a request after this many ms (default from CODEINDEX_EMBED_TIMEOUT_MS,
  // else 30_000).
  timeoutMs?: number;
  // Extra request headers (e.g. an auth token for a private endpoint).
  headers?: Record<string, string>;
  // Max texts per POST /embed request when embedding a corpus (default 64).
  batchSize?: number;
  // How many of those requests are in flight at once (default 4). A corpus of
  // 245k units is 3,835 batches; sent one after another, their round trips
  // add up to most of the build.
  concurrency?: number;
}

// Resolve the configured endpoint BASE url, or undefined when neither opts.url
// nor CODEINDEX_EMBED_ENDPOINT is set — the "endpoint tier not requested" signal.
export function resolveEmbedEndpoint(opts: EmbedEndpointOptions = {}): string | undefined {
  const url = opts.url ?? process.env.CODEINDEX_EMBED_ENDPOINT;
  return url && url.trim() ? url.trim() : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// The POST /embed URL for a base. Idempotent when the base already ends in
// /embed (so pointing the env straight at the embed route also works).
export function embedEndpointUrl(base: string): string {
  const b = stripTrailingSlash(base);
  return b.endsWith("/embed") ? b : b + "/embed";
}

// The GET /healthz URL for a base (tolerates a base that already ends in /embed).
export function healthzUrl(base: string): string {
  return stripTrailingSlash(base).replace(/\/embed$/, "") + "/healthz";
}

function resolveTimeout(opts: EmbedEndpointOptions): number {
  if (typeof opts.timeoutMs === "number") return opts.timeoutMs;
  const env = Number(process.env.CODEINDEX_EMBED_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : 30_000;
}

// Request float embeddings for a batch of texts from the endpoint's /embed
// route. Throws a clear error when no endpoint is configured, the request times
// out / fails, or the response is malformed; the caller decides whether to
// degrade. NOTE: endpoint vectors are float and are NOT byte-deterministic.
export async function embedViaEndpoint(texts: string[], opts: EmbedEndpointOptions = {}): Promise<number[][]> {
  const base = resolveEmbedEndpoint(opts);
  if (!base) throw new Error("no embedding endpoint configured (set CODEINDEX_EMBED_ENDPOINT or pass opts.url)");
  const url = embedEndpointUrl(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(opts));
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

// Is the endpoint reachable? GETs /healthz and returns true only on a 2xx. Never
// throws — a down/timed-out endpoint returns false (used by `embed status`).
export async function probeEndpoint(base: string, opts: EmbedEndpointOptions = {}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(opts));
  try {
    const res = await fetch(healthzUrl(base), { signal: controller.signal, headers: opts.headers });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Encode ONE query string via the endpoint → int8 vector, run through the shared
// quantize pipeline (so it lives in the same int8 space as an endpoint-built
// corpus). Throws on an unreachable/malformed endpoint — the caller degrades.
export async function encodeQueryViaEndpoint(query: string, opts: EmbedEndpointOptions = {}): Promise<Int8Array> {
  const [vec] = await embedViaEndpoint([query], opts);
  if (!vec) throw new Error("embedding endpoint returned no vector for the query");
  return quantize(vec);
}

// A fixed text whose vector identifies the model behind an endpoint. The URL
// alone does not: the image behind localhost:8756 can change between two runs,
// and mixing its vectors with another model's would misrank silently. One tiny
// request; the int8 quantization absorbs float noise, and if the vector still
// wobbles the only cost is a cache miss.
const CANARY = "codeindex endpoint fingerprint: parse the request, retry on timeout";

// `endpoint@<hash of the canary's int8 vector>` — the modelId an endpoint index
// is built and cached under, so reuse across runs only ever mixes vectors from
// the same model. Throws like embedViaEndpoint when the endpoint is down.
export async function endpointModelId(opts: EmbedEndpointOptions = {}): Promise<string> {
  const [vec] = await embedViaEndpoint([CANARY], opts);
  if (!vec) throw new Error("embedding endpoint returned no vector for the fingerprint text");
  const q = quantize(vec);
  return `endpoint@${sha1(new Uint8Array(q.buffer, q.byteOffset, q.byteLength)).slice(0, 16)}`;
}

// Build the int8 corpus index by embedding every corpus unit (the SAME units the
// static tier uses) via the endpoint, batched, then quantizing each float vector
// through the shared L2+int8 pipeline. The result plugs straight into
// searchSemantic's integer-dot ranking.
//
// `previous` donates the vector of every unit whose text it already embedded
// under the same `modelId` (default "endpoint"), so only new or changed texts
// are sent. Batches go out `concurrency` at a time; each lands in its own slot,
// so the record order — and the index — does not depend on which answers
// first.
export async function buildEndpointIndex(
  scan: RepoScan,
  opts: EmbedEndpointOptions & { previous?: EmbeddingIndex; modelId?: string } = {},
): Promise<EmbeddingIndex> {
  const modelId = opts.modelId ?? "endpoint";
  const units = embeddingUnits(scan);
  const hashes = units.map((u) => unitHash(u.text));
  const reuse = reusableVectors(opts.previous, modelId);
  const vecs: (Int8Array | undefined)[] = hashes.map((h) => reuse.get(h));
  // Each distinct missing text is sent once, however many units share it.
  const pending = new Map<string, number[]>();
  hashes.forEach((h, i) => {
    if (vecs[i]) return;
    const slots = pending.get(h);
    if (slots) slots.push(i);
    else pending.set(h, [i]);
  });
  const todo = [...pending.values()];
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 64;
  const batches: number[][][] = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let next = 0;
  let failed = false; // one failed batch fails the build; the others stop taking work
  const worker = async (): Promise<void> => {
    while (!failed && next < batches.length) {
      const batch = batches[next++]!;
      try {
        const vectors = await embedViaEndpoint(batch.map((slots) => units[slots[0]!]!.text), opts);
        if (vectors.length !== batch.length) {
          throw new Error(`embedding endpoint returned ${vectors.length} vectors for ${batch.length} texts`);
        }
        batch.forEach((slots, j) => {
          const vec = quantize(vectors[j]!);
          for (const i of slots) vecs[i] = vec;
        });
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const concurrency = opts.concurrency && opts.concurrency > 0 ? opts.concurrency : 4;
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));

  let dim = 0;
  const records: EmbeddingRecord[] = units.map((u, i) => {
    const vec = vecs[i]!;
    if (vec.length > dim) dim = vec.length;
    return unitRecord(u, hashes[i]!, vec);
  });
  return { embedVersion: EMBED_VERSION, modelId, dim, records };
}
