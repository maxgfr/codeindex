# Deterministic static-embedding tier (semantic search)

codeindex's default search is keyless BM25 lexical ranking (see `search`). The
**semantic tier** (v2.10.0) adds embedding-based retrieval that is still
**keyless, zero-dependency, and byte-deterministic** — the same doctrine as the
rest of the engine, and the reason it does *not* use onnxruntime / transformers.js
(those are threaded and dequantize int8 to fp32 for matmul, so they are never
byte-stable across architectures).

It is **strictly opt-in by asset presence**, exactly like the tree-sitter
grammar tier: with no model on disk the engine silently stays lexical.

## Why a *static* embedding model

A static embedding (model2vec / potion style) is a plain lookup table:
`token → row vector`. There is **no neural forward pass** — "inference" is:

```
tokenize → gather rows → mean-pool → L2-normalize → int8-quantize
```

Every step is pure JS and chosen to be byte-identical everywhere:

| step | how determinism is guaranteed |
|---|---|
| tokenize | `foldText` (NFKD + strip combining marks) → camelCase/ACRONYM split → lowercase → split on non-alphanumeric |
| wordpiece | greedy longest-match against the vocab, BERT-style `##` continuations; an unsplittable word → the `[UNK]` row |
| gather | model rows widen float→double exactly |
| mean-pool | IEEE-754 double add/div in a fixed token order |
| L2-norm | division by `sqrt(Σv²)` — `sqrt` is correctly-rounded per IEEE-754 |
| quantize | `unit × 127`, **round-half-to-even** (not `Math.round`), clamp to `[-127,127]` → int8 |

Ranking is a **pure integer dot product** of int8 vectors. Because the fixed
`1/127` scale is shared by every vector, for a given query the integer dot
`Σ q·c` is monotonic with the cosine estimate — no per-vector float scale is
stored or multiplied, so nothing about ranking can drift between platforms.

**Key insight:** the corpus *and* the query are encoded by the *same* JS encoder,
so self-consistency is all that is required — fidelity to the original HF
tokenizer is not. The JS tokenizer deliberately differs from the Python
reference; that gap is assumed and harmless.

## Activation (opt-in by asset)

Resolution order (`resolveEmbedModelDir`):

1. `CODEINDEX_EMBED_DIR` (explicit override — wins outright)
2. `<repo>/.codeindex/models/`
3. `<cwd>/.codeindex/models/`

A directory "has a model" when it contains `model.json`. Nothing found →
`undefined` → silent lexical degradation. **Models are never in the npm
tarball** (`package.json` `files` is unchanged; the pack-smoke test asserts no
`model.json` / `*.safetensors` / `embeddings.bin` ships).

### `model.json` shape

```json
{
  "modelId": "…",
  "dim": 256,
  "unk": "[UNK]",
  "vocab": ["[UNK]", "auth", "##token", "..."],
  "weights": [[0.0, ...], [1.0, ...], ...]
}
```

`vocab[i]` is the token whose row is `weights[i]` (length `dim`). Human-authorable
JSON so a tiny fixture is committable; a real `pull`ed model uses the same shape
at scale.

## CLI

```sh
# Effective mode (none/static/endpoint), model, EMBED_VERSION, endpoint + its
# reachability (JSON). Precedence: endpoint > static model.
codeindex embed status --repo <dir>

# Fetch the model asset (needs CODEINDEX_EMBED_URL — the official asset is
# unpublished, so this fails cleanly with instructions when unset).
codeindex embed pull --repo <dir>

# Build embeddings.bin from the repo into --out <dir> (static tier only).
codeindex embed build --repo <dir> --out <dir>

# Print (or --run) the docker command that starts the rich-tier embedding server.
codeindex embed serve            # prints the one-liner
codeindex embed serve --run      # runs it (needs docker)

# Search: RRF-fuse an embedding tier + lexical. Degrades to lexical (exit 0)
# when no tier is available/reachable.
codeindex search "http client retry" --repo <dir> --semantic
```

`codeindex index --out <dir>` additionally writes `embeddings.bin` next to
`graph.json` **iff** a model is present.

## Artifact: `embeddings.bin`

```
"CIE1"                     4-byte ASCII magic
uint32 LE header length
UTF-8 JSON header          { embedVersion, modelId, dim, count, records:[{file,symbol,line}] }
int8 body                  count × dim signed bytes (row-major)
```

The header carries **no absolute path and no timestamp**; records follow scan
order (files sorted by `rel`, symbols in declaration order). Two builds of an
unchanged repo produce byte-identical `embeddings.bin`. A dedicated
`EMBED_VERSION` (independent of `SCHEMA_VERSION`) plus `modelId` + `dim` in the
header invalidate a stale or foreign artifact.

Granularity is **per-symbol** (name + signature + file summary + path segments),
with a **per-file** fallback record for symbol-less files (docs, config) so
every file with content is represented.

## Fusion

Semantic and lexical rankings live on incomparable scales (BM25 score vs integer
dot product), so `searchSemantic` fuses them by **rank** via the shared `rrf`
helper (k=60) — never a linear score blend. A `SemanticSearchResult` extends the
lexical `SearchResult` additively with `semanticSymbol` (the corpus symbol whose
embedding was closest for that file).

## Degradation matrix

| present | behavior |
|---|---|
| nothing | BM25 lexical |
| + fuzzy | BM25 + trigram fallback for `df==0` terms (v2.9.0) |
| + model asset | RRF-fused deterministic static semantic search |
| + HTTP endpoint (`CODEINDEX_EMBED_ENDPOINT`) | rich tier — **wins over a static model** (v2.11.0) |
| `--semantic`, nothing available | lexical + stderr note, **exit 0** |
| endpoint set but unreachable/timeout | lexical + stderr note, **exit 0** (never falls back to the static model) |

## Library

```ts
import {
  resolveEmbedModelDir, loadEmbedModel,
  buildEmbeddingIndex, serializeEmbeddings, deserializeEmbeddings,
  searchSemantic, encode, EMBED_VERSION,
} from "@maxgfr/codeindex";

const model = loadEmbedModel(resolveEmbedModelDir("/repo"));
if (model) {
  const scan = scanRepo("/repo");
  const index = buildEmbeddingIndex(scan, model);        // deterministic
  const results = searchSemantic(scan, "http retry", index, { model });
}
```

`searchSemantic(scan, query, index, opts)` with no `opts.model` (or no index)
returns the pure lexical ranking — the same silent degradation the CLI uses.

## The rich tier: containerized HTTP embedding endpoint (v2.11.0)

The **rich tier** lets the engine consume a real neural embedding model (e.g.
all-MiniLM-L6-v2) served by a local container, instead of the static lookup
table. It is opt-in via one env var:

```sh
CODEINDEX_EMBED_ENDPOINT=http://localhost:8756 \
  codeindex search "auth token" --repo . --semantic
```

### Precedence

`endpoint > static model > none`. Setting `CODEINDEX_EMBED_ENDPOINT` is an
**explicit** user intent, so it wins over any local `model.json`. `embed status`
reports the effective `mode`. If the endpoint is defined but
unreachable/times-out/malformed, the search degrades straight to **lexical**
(stderr note, exit 0) — it does **not** silently fall back to the static model.

### How the float vectors join the deterministic pipeline

The engine POSTs corpus and query texts to the endpoint, receives **float**
vectors, then runs them through the **exact same** tail as the static tier —
`quantize()` in `encode.ts`: L2-normalize → int8 at the fixed `1/127` scale
(round-half-to-even, clamp). Ranking stays a pure integer dot product. So the
only tier-specific step is the encoder; fusion and ranking are shared code.

Corpus embeddings for the endpoint tier are built **at search time**
(`buildEndpointIndex`) and are **never serialized** to `embeddings.bin`: unlike
the static tier, endpoint vectors are float and provider-dependent, so this tier
is **deterministic per image digest**, not byte-golden. Pin the digest for
reproducibility:

```sh
docker run -d -p 8756:8756 ghcr.io/maxgfr/codeindex-embed@sha256:<digest>
```

### HTTP protocol (implement your own server)

`CODEINDEX_EMBED_ENDPOINT` is the server **base URL**. The client derives:

| method + path | request | response |
|---|---|---|
| `POST {base}/embed` | `{ "texts": ["…", …] }` | `{ "vectors": [[…float…], …] }` (same order, one row per text) |
| `GET {base}/healthz` | — | `200` (any body) when ready |

Notes: any embedding dimension is accepted (the engine quantizes whatever it
receives); vectors need not be pre-normalized (the engine L2-normalizes anyway);
the request times out after `CODEINDEX_EMBED_TIMEOUT_MS` (default 30 000).
`codeindex embed serve` prints/`--run`s the docker command for the official
image; the **library never orchestrates docker** (that is CLI-only).

The reference server is `docker/embed/` (transformers.js + all-MiniLM-L6-v2,
model baked in at build, offline at run, non-root, `:8756`), published to
`ghcr.io/maxgfr/codeindex-embed` by `.github/workflows/embed-image.yml`.

### Library

```ts
import {
  buildEndpointIndex, encodeQueryViaEndpoint, probeEndpoint,
  searchSemantic, quantize,
} from "@maxgfr/codeindex";

if (await probeEndpoint("http://localhost:8756")) {
  const scan = scanRepo("/repo");
  const index = await buildEndpointIndex(scan);              // float → int8 corpus
  const queryVec = await encodeQueryViaEndpoint("auth token");
  const results = searchSemantic(scan, "auth token", index, { queryVec });
}
```

`embedViaEndpoint(texts, opts)` is the low-level client (`{ texts }` →
`{ vectors }`).
