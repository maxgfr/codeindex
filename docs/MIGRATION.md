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
| | `buildGraph` (import+call edges, symbolDefs, callersBySymbol, enclosingSymbol) | `buildGraph` + `resolveCallEdges` + `buildCallerIndex` + `enclosingSymbol` |
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
