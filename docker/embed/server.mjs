// codeindex rich-tier embedding server. A minimal, zero-framework Node HTTP
// server implementing the v2.11 protocol the engine's endpoint client speaks:
//
//   POST /embed   { "texts": ["…", …] }  ->  { "vectors": [[…float…], …] }
//   GET  /healthz                        ->  200 { "ok": true, "model": "…" }
//
// The model (all-MiniLM-L6-v2, quantized) is BAKED into the image at build time
// (see warm.mjs + Dockerfile), so the server never downloads anything at run:
// env.allowRemoteModels is false and HF offline env vars are set. The engine
// re-normalizes and int8-quantizes the float vectors it receives, so returning
// mean-pooled + L2-normalized floats here keeps the whole pipeline consistent.
import { createServer } from "node:http";
import { env, pipeline } from "@xenova/transformers";

const MODEL_ID = process.env.EMBED_MODEL_ID || "Xenova/all-MiniLM-L6-v2";
const PORT = Number(process.env.PORT) || 8756;

// This server binds 0.0.0.0 (a published port), so a hostile or merely buggy
// local caller must never be able to OOM it with an oversized/unbounded
// request. Three independent caps enforce that:
//   - MAX_BODY_BYTES: readBody() aborts the read as bytes arrive (never
//     buffers past the cap) and the connection is destroyed → HTTP 413.
//   - MAX_TEXTS / MAX_TEXT_CHARS: bound the batch size and per-string length
//     the model pipeline is asked to run in one call → HTTP 400.
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_TEXTS = 256;
const MAX_TEXT_CHARS = 8192;

// Offline: only ever read the baked model from the local cache — never the hub.
env.cacheDir = process.env.MODEL_CACHE_DIR || "/app/models";
env.allowRemoteModels = false;
env.allowLocalModels = true;

// Lazily construct the extractor once, shared across requests. Awaiting the same
// promise everywhere means concurrent requests don't each load the model.
let extractorPromise;
function getExtractor() {
  if (!extractorPromise) extractorPromise = pipeline("feature-extraction", MODEL_ID);
  return extractorPromise;
}

// `close: true` marks the response Connection: close, so Node tears the socket
// down cleanly once the reply is flushed — used for the 413 path below, where
// we deliberately stop consuming a request body that may still be mid-flight
// (destroying the socket immediately would race the write and drop the reply
// before the client ever sees it; discard-and-close lets the response land
// first, then hangs up instead of keeping a rejected connection alive).
function json(res, status, body, { close } = {}) {
  const payload = JSON.stringify(body);
  if (close) res.shouldKeepAlive = false;
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

// Thrown when the request body exceeds MAX_BODY_BYTES — a distinct type so the
// handler can map it to HTTP 413 instead of the generic 400/500 paths.
class BodyTooLargeError extends Error {}

// Reads the body with a hard cap enforced AS DATA ARRIVES: once the running
// total crosses MAX_BODY_BYTES the promise rejects immediately and every
// subsequent chunk is discarded rather than buffered — the process never holds
// more than ~MAX_BODY_BYTES of a request in memory no matter how much an
// attacker streams. The stream is intentionally left flowing (not destroyed
// here): the handler still owes the client a 413 response, and destroying the
// shared request/response socket before that reply is written would drop it
// (see json()'s `close` option, which ends the connection AFTER the reply).
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return; // over-cap: drain and discard, never buffer further
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        fail(new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      await getExtractor(); // ready only once the model actually loads
      json(res, 200, { ok: true, model: MODEL_ID });
      return;
    }
    if (req.method === "POST" && req.url === "/embed") {
      let raw;
      try {
        raw = await readBody(req);
      } catch (e) {
        if (e instanceof BodyTooLargeError) {
          json(res, 413, { error: e.message }, { close: true });
        } else {
          json(res, 400, { error: "failed to read request body" });
        }
        return;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      const texts = body && body.texts;
      if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) {
        json(res, 400, { error: "body must be { texts: string[] }" });
        return;
      }
      if (texts.length > MAX_TEXTS) {
        json(res, 400, { error: `texts.length exceeds the ${MAX_TEXTS} item limit` });
        return;
      }
      if (texts.some((t) => t.length > MAX_TEXT_CHARS)) {
        json(res, 400, { error: `each text must be at most ${MAX_TEXT_CHARS} characters` });
        return;
      }
      if (texts.length === 0) {
        json(res, 200, { vectors: [] });
        return;
      }
      const extractor = await getExtractor();
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      json(res, 200, { model: MODEL_ID, vectors: out.tolist() });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: e && e.message ? e.message : String(e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`codeindex-embed listening on :${PORT} (model ${MODEL_ID})`);
});
