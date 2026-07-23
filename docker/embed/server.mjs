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

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/healthz" || req.url === "/health")) {
      await getExtractor(); // ready only once the model actually loads
      json(res, 200, { ok: true, model: MODEL_ID });
      return;
    }
    if (req.method === "POST" && req.url === "/embed") {
      const raw = await readBody(req);
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
