# Migrating a skill onto the codeindex engine

The engine ships as two files, released together at every tag:

- `scripts/engine.mjs` — self-contained zero-dependency ESM bundle (library + CLI + MCP server)
- `scripts/engine.d.mts` — TypeScript declarations for the bundle

Consumers **vendor** them (commit a copy) — never an npm dependency — so every
skill stays standalone-installable.

## Vendoring steps

1. Copy `scripts/sync-engine.mjs` (reference implementation lives in the
   ultraeval repo) into your repo and run:

   ```sh
   node scripts/sync-engine.mjs --ref v1.0.0
   ```

   It fetches `engine.mjs` + `engine.d.mts` from
   `https://raw.githubusercontent.com/maxgfr/codeindex/<ref>/scripts/…` into
   `src/vendor/`, greps the bundle's `ENGINE_VERSION` to assert it matches the
   tag, and writes `src/vendor/engine.meta.json` (`{ tag, sha256, syncedAt }`).

2. Import what you need from the vendored file:

   ```ts
   import { scanRepo, buildGraph, gitChurn } from "../vendor/engine.mjs";
   ```

   With `moduleResolution: "Bundler"` the sibling `.d.mts` types the import
   with zero config. Your tsup/esbuild build inlines the engine into your own
   single-file bundle — the user installs nothing extra.

3. Exclude `src/vendor/` from your linter, and add
   `node scripts/sync-engine.mjs --check` (offline sha256 check against
   `engine.meta.json`) to your CI so local edits to the vendored file fail
   loudly. Upgrades are a deliberate re-pin: run the sync with a newer tag and
   commit the diff.

The AST tier is optional: without a `grammars/` directory next to the vendored
bundle the engine uses its regex tier (15 languages). Only vendor
`scripts/grammars/` (~17 MiB wasm) if you need AST-exact symbols (ultraindex
does; nobody else should).

## Version constants

| Constant | Meaning | On mismatch |
|---|---|---|
| `ENGINE_VERSION` | the release tag, greppable in the bundle | sync script refuses the fetch |
| `SCHEMA_VERSION` | `graph.json` / `symbols.json` shape | reject the artifact, rebuild |
| `EXTRACTOR_VERSION` | extraction output shape | discard incremental caches wholesale |

`buildGraph(...)` / `buildIndexArtifacts(...)` accept
`meta: { version, schemaVersion }` so a consumer stamps its own identity into
artifacts it persists (ultraindex does this to keep its graph.json lineage).

## v2.9.0 — `search` trigram fuzzy fallback

New, purely additive: `SearchOptions.fuzzy?: boolean` (default `true`) and
`SearchResult.fuzzyTerms?: string[]` (present only when the fallback
contributed). A query term is only ever expanded when it has zero document
frequency in the corpus, so any query where every term already matched keeps
producing byte-identical output — **no re-pin required**, no action needed
from existing consumers. Pass `fuzzy: false` (or CLI `--no-fuzzy`) to opt out.

## v2.10.0 — deterministic static-embedding tier (opt-in)

New, purely additive, and **opt-in by asset presence** — nothing changes for a
consumer that does not place a model. `SCHEMA_VERSION` is **untouched**;
embeddings live in a separate `embeddings.bin` sidecar keyed by a dedicated
`EMBED_VERSION`, so `graph.json` / `symbols.json` consumers are unaffected and
**no re-pin is required**.

- Activation mirrors the grammar tier: a model asset resolved via
  `CODEINDEX_EMBED_DIR` or `<repo>/.codeindex/models/` (`resolveEmbedModelDir`).
  No model → the engine stays lexical, silently. Models are **never** shipped in
  the npm tarball (`files` unchanged; pack-smoke asserts no model asset).
- `codeindex index` writes `embeddings.bin` next to `graph.json` **only** when a
  model is present. `codeindex embed {status,build,pull}` and
  `codeindex search --semantic` are the CLI surface; MCP gains `embed_status`
  and a `semantic` property on `search`.
- Determinism is the point: the pure-JS encoder (fold+lowercase → wordpiece →
  mean-pool → L2-norm → int8 round-half-to-even at a fixed 1/127 scale) and the
  **integer** dot-product ranking make encode and `embeddings.bin` byte-identical
  across builds and platforms — goldens are possible. Fusion with lexical uses
  the existing `rrf` helper (k=60), never a linear score blend.
- New exports: `EMBED_VERSION`, `resolveEmbedModelDir`, `hasEmbedModel`,
  `loadEmbedModel`, `encode`, `buildEmbeddingIndex`, `serializeEmbeddings`,
  `deserializeEmbeddings`, `searchSemantic`, plus the v2.11-preview
  `embedViaEndpoint`. See `docs/SEMANTIC.md`.

`--semantic` without a model degrades to lexical results on **exit 0** (a stderr
note only) — so wiring it on is safe before an asset exists.

## v2.12.0 — two return-shape changes (check your call sites)

Not additive: two public return shapes changed in this release without a
compat flag, so a consumer re-pinning across v2.12.0 must check both call
sites. Artifact schemas are untouched (`SCHEMA_VERSION` / `EMBED_VERSION`
unchanged) — this is API shape only.

- `resolveEmbedPullUrl()` now returns an `EmbedPullTarget`
  (`{ url: string; sha256?: string }`) — it previously returned
  `string | undefined`. It always resolves: `CODEINDEX_EMBED_URL` wins
  outright and carries **no** `sha256` (a custom mirror keeps the
  un-verified behavior); with no env it falls back to the built-in official
  asset **with** its pinned `sha256` so `embed pull` verifies the default
  download. Replace `const url = resolveEmbedPullUrl()` with
  `const { url, sha256 } = resolveEmbedPullUrl()`. The `EmbedPullTarget`
  type is exported from the barrel.
- MCP `search` with `semantic: true` now returns
  `{ results, tier, degradedReason? }` — it previously returned the bare
  ranked array. `tier` is `"endpoint" | "static" | "lexical"` and
  `degradedReason` is present only when the semantic tier degraded to
  lexical, so a caller can tell "fusion happened" apart from "degraded".
  Plain lexical `search` (no `semantic: true`) still returns the bare
  array, byte-compatible with existing consumers.

## v2.13.0 — `.codeindex` excluded from the walk

`.codeindex/` — the engine's own output directory (index artifacts, pulled
models, MCP memories) — joined `IGNORE_DIRS`, so `walk`/`scanRepo` no longer
descend into it and memories stop entering BM25/embedding results (previously
every `write_memory` also churned the scan fingerprint, busting the MCP
server's memoized embedding index). Access memories through the MCP memory
tools (`read_memory` / `list_memories` / `delete_memory`), never `search`.
This is a file-set change only — extraction shape and `SCHEMA_VERSION` are
untouched, so **no re-pin is required**; a consumer that deliberately wants
`.codeindex` walked can pass `ignoreDirs` (replace semantics, also new in
this release) with its own set.

## Per-skill mapping (what to replace with what)

| Skill | Replace | With (engine export) |
|---|---|---|
| **ultraeval** | `walkFiles`, `SKIP_DIRS` | `scanRepo` (gitignore on by default) |
| | `importsOf` + `resolveImport` (JS/TS+py regex) | `FileRecord.refs` (kind `import`) + `buildResolveContext`/`resolveImport` |
| | `gitChurn`, `changedFiles` | `gitChurn`, `changedSince` |
| | keeps | cycle DFS, hotspot scoring, todos/maxIndent, ANALYSIS.md rendering |
| **construct** | walker clone + language histogram + test count | `scanRepo` (`.languages`) + `isTestPath` |
| **ultraindex** | the whole core (walk/scan/extract/resolve/modules/graph/calls/analytics/renderers) | vendored engine + shim `src/engine.ts` re-exporting it; pass `meta: { version: VERSION, schemaVersion: SCHEMA_VERSION }` to keep graph.json byte-lineage |
| | keeps | store/manifest, encyclopedia, merge/entries, find/ask, check/verify, embeddings, orchestrate |
| **ultradoc** | walker, `EXT_LANG` map, symbol `RULES` + `applyExportLists` | `scanRepo`, `extToLang`/`languageOf`, `extractSymbols`/`buildSymbolIndex` |
| | `PKG_MANIFESTS` workspace probing | `detectWorkspaces` |
| | `rgSearch` + JS fallback | `grepRepo` |
| | keeps | issues/PRs/SO/web retrieval, citations, DOC.md |
| **ultra11y** | walker + glob scoping | `walk`/`scanRepo` with `include`/`exclude` |
| | tsconfig path-alias resolution | `buildResolveContext` + `resolveImport` |
| | keeps | its JSX component graph and every WCAG check |
| **reconstruct** | walker + gitignore parser + `categorize` | `scanRepo`, `categorize` |
| | `EXT_LANGUAGE` | `extToLang` |
| | workspace detection + dep graph + cycle + topo | `detectWorkspaces` (packages/dependsOn/cycle/topoOrder) |
| | `resolveModule` | `resolveImport` |
| | keeps | framework adapters (routes), data-model inference, PRD rendering |
| **ultrasec** | walker + gitignore + scope + symlink guard | `scanRepo` (`scope`, `gitignore` — its own semantics, ported here) |
| | per-language defs/imports/calls extraction | `extractCode` (`symbols`/`refs`/`calls`) |
| | `resolveImport` | `resolveImport` |
| | `buildGraph` (import+call edges, symbolDefs) | `buildGraph` + `resolveCallEdges` |
| | `callersBySymbol`, `enclosingSymbol` (raw-recall taint-BFS input) | `buildRawCallerIndex` (issue #8) — every name-matched call site keyed by the raw callee name, no def resolution or gating, `enclosingSymbol` computed per site. `buildCallerIndex` is **NOT** a substitute here: it is def-resolved and gated (language-family filter, JS/TS import gate, same-file self-declaration skip) and will silently drop sites a recall consumer needs. Both are bounded by `FileRecord.calls`'s per-file 512-call cap (dedup by name+line) — a file with more raw call sites than that loses sites upstream of either function. |
| | keeps | taint source→sink enumeration, external scanners, EPSS/KEV/CVSS, SARIF |

## Golden-diff adjudication (every migration)

Capture the skill's load-bearing artifact **before** touching code (a committed
snapshot test), migrate, then adjudicate every diff:

- **Accept + document**: file-set changes from better ignore rules (gitignore
  honored, lockfile/binary/1 MiB skips) and strictly-more-resolved imports
  (tsconfig paths, package `exports`, go/cargo) — list them in the commit body.
- **Must be identical**: output schemas, rendering, scoring formulas,
  attribution logic on identical inputs.
- **Investigate before accepting**: anything else (a cycle, hotspot, finding or
  score changing for an unlisted reason). If the engine is more correct, update
  the golden citing the cause; otherwise **fix codeindex and re-release** —
  never patch around it in the consumer.
