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

## v2.15.0 — MCP serves from a persisted index (additive, no re-pin required)

Pure fastpath, MCP-only: on the **first** tool call for a repo the long-lived
server seeds its session from a committed `.codeindex/` index (written by
`codeindex index`) instead of doing every step cold. Served tool responses stay
**byte-identical** to a cold-process build on the same repo state, so **no
re-pin is required** and no consumer needs to act. `SCHEMA_VERSION` /
`EMBED_VERSION` / `EXTRACTOR_VERSION` are untouched, the public API is unchanged
(**no new exports** — the preload is entirely internal to `mcp.ts`), and a repo
with no `.codeindex/` behaves exactly as before.

- **Scan seed from `cache.json`.** `getScan`'s first touch reads
  `.codeindex/cache.json` and re-expresses its per-file records as the session
  `cache`, so scan.ts's stat fastpath / exact content-hash reuse rebuilds the
  `RepoScan` value-identically to a cold scan (the T3/T4 determinism the CLI's
  `index` fastpath already relies on) without a read + hash + extraction per
  unchanged file. Records are only trusted when the cache's
  `(schemaVersion, extractorVersion)` match this engine — the same gate the CLI
  applies — otherwise the whole cache is discarded and the scan runs cold. A
  file whose content drifted since `cache.json` is re-read/extracted here exactly
  as a cold scan would, so the scan stays correct and only the derived freshness
  flags differ (they never feed artifacts).
- **Artifact preload from `graph.json` / `symbols.json` — gated by the T4
  oracle.** Only when the **exact** T4 freshness guard holds does the session
  deserialize the on-disk artifacts straight in, skipping the whole downstream
  pipeline (`buildArtifactsFromScan`) for the first
  `graph`/`symbols`/`mermaid`/`repo_map`/`check_rules` call. The guard is the one
  the CLI `index` fastpath uses to prove the on-disk bytes equal a fresh build:
  `scan.contentUnchanged` **and** `cache.json`'s `engineVersion === ENGINE_VERSION`
  **and** its `commit === scan.commit` **and**
  `sha1(graph.json) === meta.graphSha1` **and**
  `sha1(symbols.json) === meta.symbolsSha1`. When it holds, the on-disk
  `graph.json`/`symbols.json` are byte-equal to `buildArtifactsFromScan(scan)` run
  here, so deserializing them equals rebuilding.
- **Deserialize is `JSON.parse`, not a new codec — no new exports.** `Graph` and
  `SymbolIndex` are pure JSON POJOs (no `Map`/`Set`/typed fields), so
  `JSON.parse` is a lossless round-trip and a `schemaVersion` assert is the only
  reconstruction needed. `renderGraphJson` re-sorts `graph.languages` anyway, so
  render→parse→render reproduces the same bytes (numbers reproduce their
  shortest-round-trip form, absent optionals stay absent, V8's integer-key
  hoisting is identical). No (de)serializer was added to the barrel; the preload
  helpers are private to `mcp.ts`.
- **Fallback is today's build-on-demand path, EXACTLY — never a throw.** No
  `.codeindex/`, a `(schemaVersion, extractorVersion)` mismatch, a stale scan, a
  version/commit/sha mismatch, or a missing/corrupt/partial/tampered
  `graph.json`/`symbols.json` each returns `undefined` and falls through to a
  fresh `scanRepo` / `buildArtifactsFromScan`. So the preload self-heals on
  corruption and a deleted or truncated artifact never crashes the session — the
  worst case is the cold cost the server paid before this release. The embed
  sidecar keeps its own memoization path (the graph/symbols shas are all the
  guard checks).

## v2.18.0 — parallel extraction, persisted-index reads, MCP protocol negotiation

Large release, all **additive**: `SCHEMA_VERSION` / `EMBED_VERSION` /
`EXTRACTOR_VERSION` are untouched, `graph.json` / `symbols.json` / `index.scip`
stay **byte-identical**, and every existing export keeps its signature. **No
re-pin is required.** New capabilities are opt-in by calling the new functions
or passing the new options.

### Extraction is faster and its records are unchanged

`extractAst` folded its four full-tree traversals into one and reads children
via `namedChildren` instead of per-index `namedChild(i)`. Results are identical;
this is purely fewer wasm boundary crossings.

One signature grew: `extractAst(rel, ext, content, opts)` accepts
`opts.imports` (**default `true`**), which computes `refs` and `pkg`. The
default preserves today's contract, so a consumer reading `ast.refs` needs no
change. `extractCode` passes `false` because it recomputes both with regex and
discarded the AST's versions — that dead work is now skipped.

### `scanSummary` — a file count without parsing the repo

`scanSummary(root, opts)` returns `{root, commit, fileCount, languages, capped,
excluded}` from the walk plus the path classifiers, with **no read, hash or
parse**. It shares the kept-file loop with `scanRepo`, so the two cannot report
different numbers. Use it wherever you only need the histogram — the CLI `scan`
command went from 6.7s to 0.17s on a 7k-file repo. `scanRepo` is unchanged.

### `scanRepoParallel` — worker_threads extraction (opt-in, degrades silently)

`scanRepoParallel(root, opts)` is **async** and returns the same `RepoScan`
`scanRepo` would, byte for byte. Code files are read/hashed/extracted across
`min(cores-1, 8)` workers; docs and everything else stay on the main thread.
`opts.workers` (or `CODEINDEX_WORKERS`) sets the count; `0` or `1` is the
sequential path.

`scanRepo` stays **synchronous and sequential** — the pipeline never becomes
async, and consumers calling it are unaffected.

Two things to know before switching:

- **It degrades to sequential rather than risk a different result.** Workers
  report the grammar keys they actually readied; any disagreement with the main
  thread discards the whole parallel run. So does a failure to resolve the
  engine URL, spawn, or complete. `extractInParallel` never throws.
- **The worker imports the engine BY URL, so it must be a real file.** The URL
  is resolved the way grammars are: the running module when it is
  `engine.mjs`, else an adjacent `engine.mjs`. **If you re-bundle the engine
  into your own entry, neither resolves and you get the sequential path** — by
  design, since importing your bundle in a worker would run your top-level code.
  Vendoring `scripts/engine.mjs` as a file (the documented layout) works.

Memory is the trade: each worker carries its own tree-sitter wasm arena. On a
7k-file repo, 1.63s / 1424 MB parallel versus 5.03s / 1019 MB sequential.

New exports: `scanRepoParallel`, `extractInParallel`, `runExtractWorker`,
`workerCount`, `keptCodeFiles`, `buildCodeRecord`, type `ExtractedRecord`, and
`ScanOptions.extracted` (populated by `scanRepoParallel` — never set it by hand).

`runExtractWorker` must stay exported from any re-export of the barrel: the
worker bootstrap imports it by name, and a missing export is indistinguishable
from "this is not the engine".

### The persisted-index preload is public and no longer MCP-only

v2.15.0 said these helpers were "entirely internal to `mcp.ts`". They now live
in `src/preload.ts` and are exported: `preloadSession`, `preloadArtifacts`,
`readPersistedIndex`, `toCacheMap`, `INDEX_DIR`, plus types `PersistedMeta`,
`PersistedCacheEntry`, `PersistedCacheMap`. `toCacheMap` is still re-exported
from `mcp.ts`, so existing imports keep working.

The freshness guard is unchanged — same T4 oracle, same "never throws, always
degrades to a cold build" contract. Every CLI read command now goes through it,
which is where the 5s → 0.3s figures come from.

### MCP: protocol negotiation, response cap, and closed CLI gaps

- **Protocol is negotiated.** The server reads `params.protocolVersion` and
  answers with it when it speaks it (`2024-11-05`, `2025-03-26`, `2025-06-18`,
  `2025-11-25`), else with the newest. **A client that asks for `2024-11-05`
  receives exactly the bytes it received before** — `title` and `annotations`
  are gated on the negotiated version. Clients that never send `initialize` are
  treated as `2024-11-05`.
- **Responses are capped, not paginated.** Under `maxResponseBytes` (default
  1e6, `--max-response-bytes`) a response is byte-identical to before. Over it —
  where no MCP client could consume the payload anyway — it is replaced by a
  parseable notice naming the size, the on-disk artifact, and the narrower tool.
  New exports: `capResponse`, `DEFAULT_MAX_RESPONSE_BYTES`, `resourceLinkFor`,
  `negotiateProtocol`, `validateArgs`.
- **Arguments are type-checked** against the declared `inputSchema`, returning
  a Tool Execution Error (`isError`). Previously a wrong-typed argument was
  silently ignored. If you drive this server programmatically with loosely
  typed arguments, a call that used to fall back to a default now errors —
  numeric strings (`"50"`) are still accepted.
- **outputSchema + structuredContent** on the 15 tools whose response is a JSON
  object for every argument combination (scan_summary, graph, symbols, callers,
  workspaces, churn, find_references, hotspots, coupling, embed_status, the
  three symbolic edits, write_memory, delete_memory). Additive: `content` is
  unchanged, `structuredContent` is added beside it, and both are gated on the
  negotiated version. The other 11 tools deliberately have no schema — array
  responses and argument-dependent shapes cannot produce a conforming object
  without either diverging from `content` or breaking existing clients, and
  repo_map/mermaid/read_memory are not JSON. structuredContent is also withheld
  when the response was capped, since the truncation notice would not conform.
- **New optional tool arguments**, all defaulting to today's behaviour:
  `find_symbol.maxResults`, `complexity.top`, `complexity.since` (risk mode
  previously dropped it), `mermaid.maxEdges`, `dead_code.limit`, `grep.scope`
  (was CLI-only), `callers.recall` (was CLI-only), `check_rules.configPath`.
  `check_rules` no longer requires `rules` when `configPath` is given.
- **Session cache is a 4-entry LRU**, not one entry, so alternating repos or
  scopes no longer forces a cold rebuild each call.

### src/mcp.ts is now a facade over src/mcp/

The server split into `src/mcp/protocol.ts` (version negotiation, argument
validation, the response guard), `src/mcp/tools.ts` (tool definitions, metadata,
output schemas) and `src/mcp/session.ts` (the scan/artifacts LRU and the embed
memoization). `src/mcp.ts` keeps `callTool` + `runMcpServer` and **re-exports
every symbol that used to live there**, so imports from `"./mcp.js"` are
unaffected. New exports available either way: `TOOLS`, `TOOL_META`,
`OUTPUT_SCHEMAS`, `annotationsFor`, `toolsFor`, `structuredContentFor`.

### New CLI flags

`--workers <n>` (index), `--index <dir>` and `--no-index-cache` (read commands),
`--max-response-bytes <n>` (mcp).

## v2.20.0 — the walk no longer caps at 20,000 files by default

**Behaviour change, and the one thing to check before re-pinning.**

`walk()` (and therefore `scanRepo`, every CLI command and the MCP server)
applied `DEFAULT_MAX_FILES = 20_000` unless the caller passed `maxFiles`. On a
repo above that size the index silently described a PREFIX of the tree:
`vercel/next.js` indexed 20,000 of its 27,952 files, so 28% of the repo was
absent from every symbol lookup, every edge and every search result, with the
`capped` flag as the only hint.

The default is now no cap. `capped` therefore reports only a limit the CALLER
chose, never one the engine imposed.

`DEFAULT_MAX_FILES` is still exported and still 20,000 — it is part of the
public surface and some consumers pass it deliberately. **To keep the old
behaviour exactly, pass it:** `scanRepo(repo, { maxFiles: DEFAULT_MAX_FILES })`,
or `--max-files 20000` on the CLI.

What to expect if you index a repo larger than 20,000 files:

- **Artifacts grow and builds get slower**, because they now cover the whole
  tree. Measured on `vercel/next.js` (10-core M5): 20,000 files in 2.94s
  becomes 27,952 files in 7.05s.
- **Peak memory grows more than time does** — 2.15 GB on that build, since
  each extraction worker carries its own tree-sitter wasm arena. `--workers`
  trades it back: the same build is 1.59 GB at `--workers 2` (7.84s) and
  1.85 GB at `--workers 4` (5.88s). `CODEINDEX_WORKERS` sets it globally, and
  `--workers 0` restores the single-threaded path.
- **Nothing changes below 20,000 files.** Artifacts for such repos are
  byte-identical to the previous release.

If you run in a memory-constrained CI container and index a large monorepo,
pin either `--max-files` or `--workers` deliberately rather than inheriting
whatever the runner allows.

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
