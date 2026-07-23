# codeindex

Self-contained, deterministic **repo-indexing engine**: file walking, language
detection, symbol/import extraction (tree-sitter AST with a regex fallback),
import resolution, a typed cross-file link-graph, and graph analytics — shipped
as a single zero-dependency `engine.mjs` that consumer tools **vendor** (copy
into their repo) instead of installing.

Extracted from [ultraindex](https://github.com/maxgfr/ultraindex) 5.1.0's core,
and consumed by the ultra* skill family (ultraindex, ultradoc, ultrasec,
ultraeval, reconstruct, construct, ultra11y).

## What it does

- **Walk** a repo deterministically: ignore lists, binary/lockfile skips, size
  and count caps (`capped` flag, never silent truncation), symlink-cycle guard.
- **Scan** every file into a `FileRecord`: classification, language, symbols,
  imports, headings, hashes — with an incremental cache fastpath.
- **Extract symbols** via tree-sitter (10 languages, when the wasm sidecar is
  present) or per-language regex rules (15 languages, always available).
- **Resolve imports** across languages: tsconfig paths, package `exports`,
  go.mod, Cargo, Java packages, PSR-4, C# namespaces.
- **Build a typed link-graph**: `import` / `call` / `use` / `doc-link` /
  `mention` edges at file and module level, plus Louvain communities, PageRank/
  betweenness centrality, a tests→code map, and surprise-edge detection.
- **Render** byte-stable `graph.json` / `symbols.json` (two builds of an
  unchanged repo are byte-identical), plus a **SCIP** code-intelligence index
  (`index.scip`) via a hand-rolled zero-dependency protobuf encoder — validated
  by the official `scip` CLI (`stats`/`lint`).

## Use as a library (the vendoring model)

Consumers commit `scripts/engine.mjs` + `scripts/engine.d.mts` (fetched at a
pinned release tag) into `src/vendor/` and import from it; their bundler inlines
the engine so they still ship a single file:

```ts
import { buildIndexArtifacts, renderGraphJson } from "./vendor/engine.mjs";

const { scan, graph, symbols } = buildIndexArtifacts("/path/to/repo");
```

The AST tier is optional: without a `grammars/` directory next to the bundle
the engine silently uses its regex tier. Only tools that want AST precision
(e.g. ultraindex) also vendor `scripts/grammars/` (~17 MiB of wasm).

## Use from npm

For consumers who don't want to vendor the bundle, `@maxgfr/codeindex` also
resolves as a regular package:

```sh
npm i @maxgfr/codeindex
```

```ts
import { scanRepo, ENGINE_VERSION } from "@maxgfr/codeindex";

const scan = scanRepo("/path/to/repo");
```

The CLI ships in the same package — see **Use as a CLI** below for the global
install command. Skills should still prefer vendoring: it keeps their own
bundle single-file and pinned to an exact commit without an npm dependency.

## Use as a CLI

```sh
brew install maxgfr/tap/codeindex        # or: npm i -g @maxgfr/codeindex

codeindex index   --repo . --out .codeindex   # graph + symbols + incremental cache
codeindex graph   --repo . > graph.json
codeindex scip    --repo . --out index.scip   # SCIP index (--out - for stdout)
codeindex callers --repo .                    # per-symbol caller index
codeindex grep    'pattern' --repo .
```

## Docker

`ghcr.io/maxgfr/codeindex` ships the same zero-dependency bundle (`engine.mjs`
+ `cli.mjs` + the AST grammars) with nothing else inside — just `node` and the
files above, no `npm install`. Multi-arch (`linux/amd64`, `linux/arm64`),
built and pushed on release. Mount the repo to index at `/work`:

```sh
docker run --rm -v "$PWD":/work ghcr.io/maxgfr/codeindex scan --repo /work
docker run --rm -v "$PWD":/work ghcr.io/maxgfr/codeindex index --repo /work --out /work/.codeindex
```

Pin by digest in CI or anywhere reproducibility matters, rather than a
mutable tag:

```sh
docker run --rm -v "$PWD":/work ghcr.io/maxgfr/codeindex@sha256:... scan --repo /work
```

Runs as an MCP server over stdio the same way as the npm CLI (see
**Use as an MCP server** below) — add `-i` so `docker run` keeps stdin open:

```sh
docker run -i --rm -v "$PWD":/work ghcr.io/maxgfr/codeindex mcp
```

## Search

`codeindex search "<query>" --repo .` ranks files with keyless BM25 over symbol
names, path segments, markdown headings and summaries. A query term that
matches nothing in the corpus (zero document frequency) gets a deterministic
**trigram fuzzy fallback** — typo tolerance without embeddings: the term is
compared to the corpus vocabulary by character-trigram Dice similarity
(threshold 0.6, top-3 candidates, contribution scaled by the Dice score so a
near-miss always ranks below an exact hit). Terms that already match anything
are never touched, so an existing query stays byte-identical. Enabled by
default; disable with `--no-fuzzy` (CLI) or `fuzzy: false` (library/MCP
`SearchOptions.fuzzy`); results carry an additive `fuzzyTerms` field when the
fallback contributed.

### Semantic search (deterministic static-embedding tier)

`codeindex search "<query>" --repo . --semantic` RRF-fuses lexical BM25 with a
**keyless, byte-deterministic** embedding tier. It uses a *static* embedding
model (a `token → vector` lookup table, no neural forward pass, no wasm): the
pure-JS encoder tokenizes → mean-pools → L2-normalizes → int8-quantizes
(round-half-to-even), and ranking is a **pure integer dot product** — so encode
and the `embeddings.bin` artifact are byte-identical across builds and platforms.

It is **opt-in by asset**: with no model on disk the engine silently stays
lexical, and `--semantic` without a model returns lexical results on **exit 0**
(a stderr note only). Models are **never** shipped in the package; a model is
resolved from `CODEINDEX_EMBED_DIR` or `<repo>/.codeindex/models/`.

```sh
codeindex embed status --repo .              # is a model active? (JSON)
codeindex embed build  --repo . --out .codeindex   # write embeddings.bin
codeindex search "http client retry" --repo . --semantic
```

`codeindex index` also writes `embeddings.bin` next to `graph.json` when a model
is present. Fusion reuses the engine's `rrf` helper (k=60); `SCHEMA_VERSION` is
untouched (a dedicated `EMBED_VERSION` keys the sidecar). Full details:
[docs/SEMANTIC.md](./docs/SEMANTIC.md).

## Use as an MCP server

`codeindex mcp` (or `node scripts/cli.mjs mcp`) serves the engine over stdio —
tools: `scan_summary`, `graph`, `symbols`, `callers`, `workspaces`, `churn`,
`grep`. Register it in Claude Code with:

```sh
claude mcp add codeindex -- codeindex mcp
```

`engine.mjs` is a pure side-effect-free library (safe for consumers to inline
into their own CLIs); `cli.mjs` is the thin standalone CLI/MCP wrapper.

## Versioning

- `ENGINE_VERSION` — the release tag, embedded greppably in the bundle.
- `SCHEMA_VERSION` — the `graph.json`/`symbols.json` shape (continues
  ultraindex's lineage; currently 4). Consumers reject mismatched artifacts.
- `EXTRACTOR_VERSION` — the extraction output shape; incremental caches keyed
  on it are discarded wholesale when it bumps.

`buildGraph`/`buildIndexArtifacts` accept `meta: { version, schemaVersion }` so
a consumer can stamp its own identity into artifacts it persists.

## Benchmarks

Measured against 01x-in/codeindex, universal-ctags and scip-typescript with a
reproducible harness (`scripts/bench/`); full methodology, fairness notes and
all scenarios in [BENCHMARKS.md](./BENCHMARKS.md).

| Metric | codeindex | Context |
| --- | --- | --- |
| `socialgouv/code-du-travail-numerique` — cold index | 1,746 ms | vs ctags 371 ms, 01x init 13,409 ms |
| `socialgouv/code-du-travail-numerique` — warm rerun | 339 ms | |
| `vercel/next.js` — cold index | 9,398 ms | vs ctags 3,431 ms |
| `socialgouv/code-du-travail-numerique` — token ratio (measured) | 32.9× | structured index vs raw grep, single-symbol lookup |

## Development

```sh
pnpm install
pnpm test          # unit + fixtures + compat + no-wasm gates
pnpm typecheck
pnpm build         # tsup → scripts/engine.mjs + scripts/engine.d.mts
pnpm check:build   # proves the committed bundle is byte-reproducible
pnpm test:e2e      # opt-in: pinned real-repo builds with ratchets
```

The compat suite pins the exact bytes ultraindex 5.1.0 produced for the
`mini-repo` fixture — the proof that extraction was lossless.

## License

MIT
