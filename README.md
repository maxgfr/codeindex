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
  unchanged repo are byte-identical).

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

The CLI ships in the same package (`npm i -g @maxgfr/codeindex`, see below).
Skills should still prefer vendoring: it keeps their own bundle single-file and
pinned to an exact commit without an npm dependency.

## Use as a CLI

```sh
brew install maxgfr/tap/codeindex        # or: npm i -g @maxgfr/codeindex

codeindex index   --repo . --out .codeindex   # graph + symbols + incremental cache
codeindex graph   --repo . > graph.json
codeindex callers --repo .                    # per-symbol caller index
codeindex grep    'pattern' --repo .
```

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
