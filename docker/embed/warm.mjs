// Build-time model warm-up. Running the pipeline once forces transformers.js to
// download every model file (config, tokenizer, quantized ONNX weights) into
// MODEL_CACHE_DIR so the RUNTIME image ships the model BAKED IN and never touches
// the network. This is the whole reason the endpoint tier is deterministic per
// image digest: the weights are frozen into the layer at build time.
import { env, pipeline } from "@xenova/transformers";

const MODEL_ID = process.env.EMBED_MODEL_ID || "Xenova/all-MiniLM-L6-v2";

env.cacheDir = process.env.MODEL_CACHE_DIR || "/app/models";
env.allowRemoteModels = true; // build stage only: allowed to fetch from the hub

const extractor = await pipeline("feature-extraction", MODEL_ID);
const out = await extractor(["codeindex embedding server warm-up"], { pooling: "mean", normalize: true });
console.log(`warmed ${MODEL_ID}: cached under ${env.cacheDir}, output dims ${out.dims.join("x")}`);
