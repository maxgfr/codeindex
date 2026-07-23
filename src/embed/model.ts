import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The deterministic static-embedding tier (v2.10.0). A *static* embedding model
// is a plain lookup table: token → row vector. Inference is tokenize → gather
// rows → mean-pool → L2-normalize → int8-quantize (see encode.ts). There is NO
// neural forward pass, no wasm, no float matmul — so the encode is pure-JS and
// byte-identical across platforms, which is the whole reason this tier exists.
//
// Activation is OPT-IN by asset presence, exactly like the tree-sitter grammar
// tier (src/ast/loader.ts): no model on disk → the engine silently stays
// lexical. Models are NEVER shipped in the npm tarball; the asset is fetched by
// `codeindex embed pull` into CODEINDEX_EMBED_DIR (or <repo>/.codeindex/models/).

// Bumped independently of SCHEMA_VERSION / EXTRACTOR_VERSION whenever the
// embeddings.bin artifact shape or the encode algorithm changes, so a consumer
// rejects an embeddings.bin written by an incompatible engine (or a different
// model) instead of misranking with it. SCHEMA_VERSION is deliberately left
// UNTOUCHED — embeddings are a purely additive sidecar with zero impact on the
// graph.json / symbols.json consumers.
export const EMBED_VERSION = 1;

// The default model-name a `pull` writes and a `status` reports. The real asset
// URL is intentionally NOT hard-coded yet (see resolveEmbedPullUrl): the asset
// is unpublished, so `pull` fails cleanly asking for CODEINDEX_EMBED_URL rather
// than fetching a phantom.
export const DEFAULT_EMBED_DIRNAME = "models";

// A loaded static-embedding model. `vocab` maps a wordpiece token to its row
// index; `weights` is the flat row-major (vocabSize × dim) matrix as IEEE-754
// doubles (float rows widen to double exactly, so mean-pool stays deterministic).
export interface StaticEmbedModel {
  modelId: string;
  dim: number;
  unk: string; // the OOV token (e.g. "[UNK]"); may be absent from vocab
  unkId: number; // row index of `unk`, or -1 when the model has no UNK row
  vocabSize: number;
  vocab: Map<string, number>;
  weights: Float64Array; // length === vocabSize * dim, row-major
}

// The on-disk model.json header shape. `weights` is an array of `vocabSize`
// rows, each of length `dim`. Kept human-authorable (plain JSON numbers) so a
// tiny fixture model is committable and diffable; a real `pull`ed model uses the
// identical shape at scale.
interface ModelFile {
  modelId: string;
  dim: number;
  unk?: string;
  vocab: string[];
  weights: number[][];
}

// Where the model asset lives. CODEINDEX_EMBED_DIR wins outright (explicit
// override, mirrors CODEINDEX_GRAMMAR_DIR); otherwise <repo>/.codeindex/models/
// then <cwd>/.codeindex/models/. Returns undefined when no model.json is found
// anywhere — the silent-degradation signal. When CODEINDEX_EMBED_DIR is set but
// empty of a model, that is still "no model" (undefined), never an error.
export function resolveEmbedModelDir(repo?: string): string | undefined {
  const env = process.env.CODEINDEX_EMBED_DIR;
  const candidates: string[] = [];
  if (env) candidates.push(env);
  if (repo) candidates.push(join(repo, ".codeindex", DEFAULT_EMBED_DIRNAME));
  candidates.push(join(process.cwd(), ".codeindex", DEFAULT_EMBED_DIRNAME));
  for (const c of candidates) {
    if (existsSync(join(c, "model.json"))) return c;
  }
  return undefined;
}

// True when an activatable model is present (used by `embed status` and the MCP
// gate before attempting a semantic search).
export function hasEmbedModel(repo?: string): boolean {
  return resolveEmbedModelDir(repo) !== undefined;
}

// Load and validate a static model from a directory containing model.json.
// Throws on a malformed file (bad dim, ragged weights) so a corrupt asset fails
// loudly at load rather than silently misranking. Returns undefined only when
// the directory has no model.json (the not-present case).
export function loadEmbedModel(dir?: string): StaticEmbedModel | undefined {
  if (!dir) return undefined;
  const path = join(dir, "model.json");
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8")) as ModelFile;
  const { modelId, dim, vocab, weights } = raw;
  if (typeof modelId !== "string" || !modelId) throw new Error(`embed model: missing modelId in ${path}`);
  if (!Number.isInteger(dim) || dim <= 0) throw new Error(`embed model: bad dim ${dim} in ${path}`);
  if (!Array.isArray(vocab) || !Array.isArray(weights) || vocab.length !== weights.length) {
    throw new Error(`embed model: vocab/weights length mismatch in ${path}`);
  }
  const vocabSize = vocab.length;
  const flat = new Float64Array(vocabSize * dim);
  const vmap = new Map<string, number>();
  for (let i = 0; i < vocabSize; i++) {
    const tok = vocab[i]!;
    if (typeof tok !== "string") throw new Error(`embed model: non-string vocab entry at ${i}`);
    if (!vmap.has(tok)) vmap.set(tok, i); // first occurrence wins (deterministic)
    const row = weights[i]!;
    if (!Array.isArray(row) || row.length !== dim) {
      throw new Error(`embed model: row ${i} has length ${row?.length}, expected ${dim}`);
    }
    for (let d = 0; d < dim; d++) flat[i * dim + d] = Number(row[d]);
  }
  const unk = typeof raw.unk === "string" ? raw.unk : "[UNK]";
  const unkId = vmap.has(unk) ? vmap.get(unk)! : -1;
  return { modelId, dim, unk, unkId, vocabSize, vocab: vmap, weights: flat };
}

// Resolve the URL `embed pull` fetches from. The official asset is not published
// yet, so there is no built-in default: the user must point CODEINDEX_EMBED_URL
// at a model.json (or a directory serving one). Returns undefined when unset —
// the caller turns that into a clean, actionable failure, never a crash.
export function resolveEmbedPullUrl(): string | undefined {
  const url = process.env.CODEINDEX_EMBED_URL;
  return url && url.trim() ? url.trim() : undefined;
}
