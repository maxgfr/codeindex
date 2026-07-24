# Migrating a consumer tool onto the codeindex engine

The engine ships as two files, released together at every tag:

- `scripts/engine.mjs` — self-contained zero-dependency ESM bundle (library + CLI + MCP server)
- `scripts/engine.d.mts` — TypeScript declarations for the bundle

Consumers **vendor** them (commit a copy) — never an npm dependency — so every
consumer stays standalone-installable.

## Vendoring steps

1. Add a small `scripts/sync-engine.mjs` to your repo (a ~50-line fetch script
   with the behavior described below) and run:

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
`scripts/grammars/` (~17 MiB wasm) if you need AST-exact symbols.

## Version constants

| Constant | Meaning | On mismatch |
|---|---|---|
| `ENGINE_VERSION` | the release tag, greppable in the bundle | sync script refuses the fetch |
| `SCHEMA_VERSION` | `graph.json` / `symbols.json` shape | reject the artifact, rebuild |
| `EXTRACTOR_VERSION` | extraction output shape | discard incremental caches wholesale |

`buildGraph(...)` / `buildIndexArtifacts(...)` accept
`meta: { version, schemaVersion }` so a consumer stamps its own identity into
artifacts it persists and keeps its own `graph.json` lineage.

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

## v2.14.0 — incremental fastpaths (all additive, no re-pin required)

Pure fastpaths: every entry point still produces byte-identical artifacts for
unchanged inputs, so **no re-pin is required** and no consumer needs to act.
`SCHEMA_VERSION` / `EMBED_VERSION` / `EXTRACTOR_VERSION` are untouched; the new
surface is additive (semver-minor).

- **`RepoScan.contentUnchanged` / `RepoScan.cacheDirty` + `ScanOptions.precomputedWalk`.**
  Two derived read-only flags: `contentUnchanged` is true when a `cache` was
  supplied and every kept file reused its cached record (stat fastpath or exact
  content-hash) with an unchanged file set; `cacheDirty` is true when persisting
  the cache would change any byte (a hash/size/mtime drift, a file-set
  difference, or no cache at all). `precomputedWalk` lets a caller that already
  walked hand its `WalkResult` to `scanRepo` instead of re-walking — it must
  come from `walk(root, <the same options>)`.
- **`buildArtifactsFromScan(scan, opts)` export.** The downstream half of
  `buildIndexArtifacts` (resolve → graph → communities → centrality → symbol
  index) split out as its own export; `buildIndexArtifacts` is now `scanRepo` +
  this call. A consumer already holding a `RepoScan` builds artifacts without
  re-walking; the extracted body is verbatim, so output is byte-identical.
- **`cache.json` additive meta keys.** Writes gain a fixed-order `meta` block —
  `engineVersion`, `commit`, `graphSha1`, `symbolsSha1`, and `embed`
  (`{ embedVersion, modelId, sha1 }`) only when `embeddings.bin` was written.
  Old engines ignore these keys (they only check schema/extractor); an old cache
  lacking them never fastpaths but still reuses records. `cache.json` embeds
  mtimes so it never was cross-machine byte-reproducible — no determinism
  surface changes.
- **CLI `index` fastpath.** `index` skips `buildArtifactsFromScan`, both renders
  and every artifact write when a guard proves the run would reproduce the
  on-disk bytes: `scan.contentUnchanged`, `meta.engineVersion` matches,
  `meta.commit` matches the scan's commit (graph.json embeds the commit — an
  identical tree under a new HEAD rebuilds), the sha1 of the on-disk
  graph/symbols equals the recorded shas, and the embed leg holds (no model, or
  the model's embedVersion+modelId and `embeddings.bin` sha match — a model swap
  rebuilds the sidecar). Any failure — deleted, truncated or tampered artifacts
  included — falls through to the full rebuild that rewrites everything, so the
  fastpath self-heals on corruption; `cache.json` is rewritten on the fastpath
  only when `scan.cacheDirty`.
- **MCP session scan + artifacts cache.** The long-lived server memoizes a
  single scan and its artifacts across tool calls: `getScan` re-runs `scanRepo`
  with the prior scan re-expressed as its `cache`, so scan.ts's stat/hash oracle
  decides freshness and an unchanged repo returns the SAME `RepoScan` object,
  while `getArtifacts` lazily runs `buildArtifactsFromScan` memoized on scan
  object identity (rendered strings are never cached). Any successful edit tool
  (`replace_symbol_body`, `insert_after_/insert_before_symbol`) drops the entry
  — a controlled write landing in the same mtime tick at the same byte count
  would fool the (size, mtime) fastpath; `write_memory` needs no invalidation
  (`.codeindex/` is off the walk since v2.13.0).
- **`runMcpServer` serverInfo override.** `runMcpServer(opts?)` accepts
  `{ serverInfo?: { name?, version? } }` so a consumer embedding the server
  announces its own identity in the `initialize` response; omitted fields keep
  the `{ name: "codeindex", version: ENGINE_VERSION }` defaults, the zero-arg
  call is unchanged, and `McpServerOptions` is exported from the barrel.
- **Lazy grammar warm — covering-set guarantee.** The CLI and MCP server warm
  only the grammars for languages actually present (`grammarKeysForExts` over
  the walked extensions) rather than every grammar at startup. The walk's
  extension set is a superset of what `scanRepo` keeps (scope/include/exclude
  only filter further), so every extracted file has its grammar loaded before
  extraction and AST output stays byte-identical — including a language whose
  first file appears mid-session (the MCP warm re-derives per call). The
  **pre-existing cache-tier caveat is unchanged**: a record reused by hash may
  have been extracted under a different grammar tier.
- **Slim grammars-pull tier (`grammars pull` / `grammars status`).** The AST
  wasm sidecar (`scripts/grammars/`, ~17 MiB) stays optional and opt-in by
  presence, but a consumer that vendors only `engine.mjs` no longer has to
  vendor the wasm to get AST-exact symbols. `resolveGrammarsTier` /
  `resolveGrammarsDir` now resolve in order **adjacent > env > cache > regex**:
  the bundle-adjacent `grammars/` dir wins if present (the offline, no-network
  story is untouched), then `CODEINDEX_GRAMMARS_DIR`, then the shared
  version-scoped cache `sharedGrammarsCacheDir()`
  (`<XDG_CACHE_HOME|~/.cache>/codeindex/grammars/<ENGINE_VERSION>`), else nothing
  resolvable → the regex tier exactly as today. `codeindex grammars pull`
  fetches the per-release `grammars-<ENGINE_VERSION>.tar.gz` asset (built and
  uploaded to the `v<ENGINE_VERSION>` tag by the release workflow) plus its
  `.sha256` sidecar, verifies the digest, and extracts atomically into that
  cache with a zero-dep inline ustar reader (path-traversal-guarded, no spawned
  `tar`); it is idempotent (a matching marker skips the ~22 MB download) and
  `CODEINDEX_GRAMMARS_URL` overrides the source (private mirror, unverified,
  like the embed-pull precedent). `codeindex grammars status` reports the active
  tier, resolved dir, pinned `ENGINE_VERSION`, and whether a pull is needed
  (JSON). The **guarantee**: the same committed wasm bytes loaded from the cache
  produce byte-identical AST extraction as from a bundle-adjacent dir (same wasm
  → same AST → same symbols), so `SCHEMA_VERSION` / `EXTRACTOR_VERSION` are
  untouched and **no re-pin is required**. **Offline-safe**: `grammars pull`
  never runs during indexing, and a failed/absent pull only ever leaves the
  cache empty — it never throws into the scan, which silently uses the regex
  tier. New exports: `resolveGrammarsTier`, `resolveGrammarsDir`,
  `sharedGrammarsCacheDir`, `GrammarsTier` / `GrammarsTierName`,
  `resolveGrammarsPullTarget`, `fetchGrammarsTarball`, `fetchExpectedSha256`,
  `extractGrammarsTarball`, `GrammarsPullTarget`.

## Typical mapping (what to replace with what)

What a consumer usually deletes from its own codebase, and the engine export
that replaces it:

| Hand-rolled piece | Engine replacement |
|---|---|
| file walker + skip lists + gitignore parser | `walk` / `scanRepo` (gitignore on by default; `include`/`exclude`/`scope`) |
| extension→language map | `extToLang` / `languageOf` |
| per-language symbol/import/call regexes | `extractCode` / `extractSymbols` (`symbols`/`refs`/`calls`), `buildSymbolIndex` |
| import resolution (tsconfig paths, package `exports`, go.mod, Cargo…) | `buildResolveContext` + `resolveImport` |
| workspace/monorepo probing | `detectWorkspaces` (packages/dependsOn/cycle/topoOrder) |
| dependency/link graph construction | `buildGraph` + `resolveCallEdges` |
| grep with ripgrep + JS fallback | `grepRepo` |
| git churn / changed-files helpers | `gitChurn`, `changedSince` |
| language histogram, test detection | `scanRepo` (`.languages`) + `isTestPath` |
| caller lookup, precision-gated | `buildCallerIndex` (def-resolved and gated: language-family filter, JS/TS import gate, same-file self-declaration skip) |
| caller lookup, raw recall (e.g. taint-BFS input) | `buildRawCallerIndex` (issue #8) — every name-matched call site keyed by the raw callee name, no def resolution or gating, `enclosingSymbol` computed per site. `buildCallerIndex` is **NOT** a substitute here: its gates silently drop sites a recall consumer needs. Both are bounded by `FileRecord.calls`'s per-file 512-call cap (dedup by name+line) — a file with more raw call sites than that loses sites upstream of either function. |

What a consumer keeps is everything above the index: its own scoring,
rendering, retrieval and domain logic.

## Golden-diff adjudication (every migration)

Capture the consumer's load-bearing artifact **before** touching code (a committed
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
