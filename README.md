# codeindex

[![Site](https://img.shields.io/badge/site-maxgfr.github.io%2Fcodeindex-2a78d6)](https://maxgfr.github.io/codeindex/)
[![Playground](https://img.shields.io/badge/playground-index%20a%20repo%20in%20your%20browser-a8460f)](https://maxgfr.github.io/codeindex/playground/)

Self-contained, deterministic **repo-indexing engine**: file walking, language
detection, symbol/import extraction (tree-sitter AST with a regex fallback),
import resolution, a typed cross-file link-graph, and graph analytics — shipped
as a single zero-dependency `engine.mjs` that consumer tools **vendor** (copy
into their repo) instead of installing.

Designed for downstream tools — agent skills, CLIs, CI gates — that vendor the
engine as a single file instead of taking an npm dependency. How it stacks up
against universal-ctags, Serena and Graphify: [How it
compares](#how-it-compares).

## What it does

- **Walk** a repo deterministically: ignore lists, `.gitignore` and
  `.git/info/exclude`, binary/lockfile skips, a size cap, symlink-cycle guard.
  Nested repositories (a subdirectory with its own `.git` — linked worktrees,
  vendored clones, submodules) are skipped like git does, and `.git` itself is
  never walked even when `--ignore-dir` replaces the default ignore list. No
  file-count cap unless you ask for one (`--max-files`), and asking sets the
  `capped` flag — never a silent truncation.
- **Scan** every file into a `FileRecord`: classification, language, symbols,
  imports, headings, hashes — with an incremental cache fastpath. Extraction
  runs across worker threads by default (`--workers`, `CODEINDEX_WORKERS`);
  artifacts are byte-identical either way, and anything that would make a
  worker's result differ falls back to the single-threaded path.
- **Extract symbols** via tree-sitter (15 committed grammars, plus 6 more via
  `grammars pull`) or per-language regex rules (16 languages, always available).
  Each symbol carries its **complete signature** (parameters and return type,
  not the first physical line), its own **doc comment**, its qualified `parent`,
  and its line span — including the members a declaration-only walk misses:
  interface members, class fields, enum members, every `declare`/`.d.ts`
  declaration, Rust trait method signatures, Go interface method sets, record
  components and constructor `val` parameters.
- **Resolve imports** across languages: tsconfig paths, package `exports`,
  go.mod, Cargo, Java packages, PSR-4, C# namespaces.
- **Build a typed link-graph**: `import` / `call` / `extends` / `implements` /
  `use` / `doc-link` / `mention` edges at file and module level, plus Louvain
  communities, PageRank/betweenness centrality, a tests→code map, and
  surprise-edge detection. Inheritance also yields a **type hierarchy** (what a
  type extends and implements, and what extends and implements IT) and a
  **symbol-level graph** for bounded "what does this reach" neighborhoods.
- **Render** byte-stable `graph.json` / `symbols.json` (two builds of an
  unchanged repo are byte-identical), plus a **SCIP** code-intelligence index
  (`index.scip`) via a hand-rolled zero-dependency protobuf encoder — validated
  by the official `scip` CLI (`stats`/`lint`).

## Measured against other indexers

"Finds better" is a claim, so the checks that count are the ones this project did
not author. Four oracles score extraction against outside authorities — a real
compiler, a mature indexer, and the grammars' own published queries and
vocabulary:

| oracle | what makes it independent | result |
|---|---|---|
| **TypeScript compiler index** (`scip-typescript` 0.4.0) | an index built by the real TypeScript compiler — authoritative where every other check here is syntactic | **100%** of its 93 named declarations, against ctags' 94.6% on the same files |
| **universal-ctags differential** (Universal Ctags 6.2.1) | an independent, mature indexer covering ~40 languages | reports **2,014** declarations ctags does not over 6 real repositories, and reproduces **61.7%–98.8%** of ctags' names — what is left bucketed by kind, per repo below |
| **Official `tags.scm` queries** | the code-navigation patterns each grammar's own authors publish, and GitHub uses | **1** adjudicated difference, over the 14 of 17 languages that publish one |
| **Grammar vocabulary** | each tree-sitter grammar's own declared node types, read at runtime from the parser | 21 grammars audited, **208** declaration-ish node types still unhandled |

### The one head-to-head

Exactly one figure on this page is a *score*: the one where both tools are
measured against the same third-party authority, rather than against each other.
On the 53 files of `create-t3-turbo` that an index built by the **real TypeScript
compiler** covers:

| against the compiler's 93 named declarations | found |
|---|---|
| **codeindex** | **100%** |
| universal-ctags | 94.6% |

All 5 ctags missed are one construct (string-literal declaration names — module
augmentations, quoted interface keys). That head-to-head is also the calibration
for everything below: it is how far a syntactic oracle can be trusted on the ~40
languages no compiler here can check.

Every other percentage in this section is an *overlap ratio between two tools
that disagree about what counts as a declaration*, which is a different thing and
is not scored as one.

### Per repository, against universal-ctags

Declaration names compared per file over real code, not fixtures. **The
percentage here is not a score, which is why it is not in the last column.** It
is `|ours ∩ ctags| / |ctags|` — the share of ctags' names this index also reports
— so by construction it can only ever show where we lose: nothing in it measures
what ctags omits. The two count columns are the directions that actually compare
the tools; read those.

| repo | files | both report | of ctags reproduced | ctags only | **codeindex only** |
|---|---|---|---|---|---|
| BurntSushi/ripgrep | 107 | 3,189 | 98.8% | 40 | **47** |
| gin-gonic/gin | 100 | 2,010 | 98.6% | 29 | **15** |
| pallets/flask | 86 | 1,516 | 93.9% | 98 | **6** |
| t3-oss/create-t3-turbo | 54 | 97 | 76.4% | 30 | **15** |
| nrwl/nx-examples | 87 | 87 | 69.6% | 38 | **27** |
| socialgouv/code-du-travail-numerique | 1,429 | 3,659 | 61.7% | 2,271 | **1,904** |

So no, the low rows are not "ctags finds more" — and that is measured, not
asserted. The differential records what the *ctags only* column **is**, bucketed
by the kind ctags itself assigned (`ctagsOnlyByKind` in the same record). On
`code-du-travail`, its 2,271 names are:

| ctags kind | count | what they are |
|---|---|---|
| `constant` | 2,020 | all but a handful sit inside a function body, an object literal or a test block — read off the source, not assumed |
| `variable` | 116 | same story |
| `property` | 107 | object-literal keys (`Conditions: ConditionsIcon`) |
| `alias` | 13 | import aliases — `import type Engine from "publicodes"` |
| `method` / `class` / `function` / `enumerator` | 15 | object-literal methods and test-scope declarations |

That is a definition gap, not a hole: a declaration index omits locals and config
keys on purpose, which is the whole reason its output fits in a model's context.
The same holds on the other repos — ripgrep's 40 are mostly `variable` and Rust
`implementation` blocks, flask's include 21 that **ctags itself labels
`unknown`** (its kind for an import alias), gin's are its synthetic
`anonMember`/`packageName`.

And where a third tool can settle it, it does — `create-t3-turbo` is the 76.4%
row above, and it is also the head-to-head at the top of this section, the one
the real TypeScript compiler adjudicates **100% to 94.6%** in our favour. A row
that looks like a loss against ctags is a row the authority scores as a win over
ctags. That is the whole reason the percentage is not in the score column.

And the residue is what the differential is genuinely for. Where it named real
misses they were fixed, not explained away: Go package clauses, Python PEP 484
re-exports, Rust in-function `const`/`static`, and — in `EXTRACTOR_VERSION` 12 —
declarations inside an IIFE, which is why `code-du-travail` moved to 3,659 here.
The honest limit stands: on the languages no compiler-backed oracle covers,
nothing proves the rest of that column is *entirely* surplus.

Refreshed by `CODEINDEX_ORACLE=1 pnpm vitest run
tests/oracles-external-diff.test.ts` and by the weekly CI job; tool version,
corpus and date sit next to the figures in
`tests/quality/external-oracles.json`.

### Against hand-labelled ground truth

The external indexers report declarations and nothing else, so doc comments,
complete signatures and call edges cannot be checked against them at all.
Those are covered by labels written here: `tests/fixtures/quality/` holds every
declaration a correct indexer should report for **17 languages**, with its kind,
visibility, doc and signature, plus a relevance-judged search corpus whose query
terms live only in prose.

| what is scored | score | measured on |
|---|---|---|
| symbol precision / recall | **100% / 100%** | 265 labelled declarations in 18 files |
| kind accuracy | **100%** | the same 265 declarations |
| visibility accuracy | **100%** on 16 of 17 languages, 94.4% on Go | the same 265 declarations |
| doc comment attached | **100%** | the 147 declarations labelled with a doc |
| complete signature | **100%** | the 29 declarations labelled with a signature |
| call edges / inheritance (F1) | **100% / 100%** | 47 labelled call sites, 21 relations |
| search MRR / nDCG@10 / recall@5 | **93.8% / 86.0% / 84.4%** | 16 relevance-judged queries |

`pnpm quality:report` reproduces every number; `tests/quality.test.ts` enforces
them as a **ratchet in both directions** — losing quality fails CI, and gaining
it fails too until the baseline is refreshed in the same commit. Two builds of
an unchanged repo stay byte-identical.

One judged query still returns nothing relevant, and the reason is honest: it
asks for "authentication" against a file that never writes "auth" in any form.
No lexical index can answer that; the [semantic tier](#semantic-search-deterministic-static-embedding-tier)
is what it is for.

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
also vendor `scripts/grammars/` (~17 MiB of wasm).

### Two grammar tiers

| tier | languages | how you get it |
|---|---|---|
| **core** (committed) | TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Scala, Bash, Lua | ships in the bundle — no network, no install |
| **extended** (pull-only) | Kotlin, Elixir, Zig, Solidity, HCL, Terraform | `codeindex grammars pull` |

The extended set is **not** in git: it adds ~6 MiB of wasm for languages most
repos do not contain, so committing it would grow every vendoring consumer's
checkout for a benefit only some can use. It ships inside the per-release
`grammars-<version>.tar.gz` asset instead. Without a pull those grammars are
simply absent and the engine falls back to the regex tier, exactly as it does for
a language it has no grammar for at all — `codeindex grammars status` reports
resolved-vs-missing per tier so a Kotlin repo quietly indexed by regex is visible
rather than guesswork.

*Not included, and why:* **Swift** publishes no prebuilt wasm at all, and
**Dart**'s does not load under web-tree-sitter 0.26 — shipping it would be dead
bytes advertising precision that silently degrades. Both have regex extractors.

### Slim grammars (pull instead of vendor)

Consumers that want AST precision but not the ~17 MiB of vendored wasm can
`codeindex grammars pull` the grammars once into a shared, per-machine cache
(`<XDG_CACHE_HOME|~/.cache>/codeindex/grammars/<ENGINE_VERSION>`) instead:

```sh
codeindex grammars status   # active tier (adjacent/env/cache/none) + whether a pull is needed
codeindex grammars pull     # fetch the per-release grammars asset, sha256-verified, into the cache
```

Resolution is **adjacent > env > cache > regex**: a bundle-adjacent `grammars/`
still wins if present (offline setups are untouched), then
`CODEINDEX_GRAMMARS_DIR`, then the pulled cache. `pull` fetches the official
`grammars-<version>.tar.gz` release asset (its `.sha256` sidecar is verified
before anything is written) and extracts it atomically; the same wasm bytes
produce **byte-identical** AST extraction from the cache as from a vendored dir.
It is fully **offline-safe**: with no grammars resolvable anywhere — and after a
failed or absent pull — the engine silently falls back to the regex tier exactly
as it does today; a pull never throws into indexing.

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
install command. Consumer tools should still prefer vendoring: it keeps their
own bundle single-file and pinned to an exact commit without an npm dependency.

### In a browser

`@maxgfr/codeindex/browser` is the same engine resolved against browser shims:
an in-memory filesystem you populate, tree-sitter grammars fetched through your
own transport, and everything spawn-based degrading along the fallbacks the
engine already ships. Indexing a tree through it produces `graph.json` and
`symbols.json` **byte-identical** to the Node build — asserted in CI over three
fixtures, with the grammars asserted loaded so the comparison cannot pass
vacuously.

The VFS is mounted in **two phases**, and the split is the point rather than an
implementation detail. Sizes alone satisfy `lstatSync`, which is all `walk()`
needs — so the real walk runs *before* you have fetched anything, and its
keep-list is your download list. Gitignore chains, `IGNORE_DIRS`, `LOCKFILES`,
`BINARY_EXT` and the 1 MiB cap all apply, and you never pay for a file the
engine was going to discard.

<details>
<summary><b>The full mount → walk → fetch → index sequence, the API this build adds, and sizing</b></summary>

```ts
import {
  resetVfs, mountFiles, setFileBytes, pruneUnfetched,
  loadGrammars, walk, buildIndexArtifacts, searchIndex,
} from "@maxgfr/codeindex/browser";

const ROOT = "/repo";
resetVfs();

// Phase A — the whole tree, sizes only. `manifest` is whatever you can
// enumerate cheaply: a git tree listing, a directory handle, a zip index.
mountFiles(manifest.map((e) => ({ path: `${ROOT}/${e.path}`, size: e.size })));

// walk() honours .gitignore, so give it the real bytes of those (they are tiny).
for (const path of gitignorePaths) setFileBytes(`${ROOT}/${path}`, await readBytes(path));

// The engine decides what is worth reading.
const planned = walk(ROOT, { maxFiles: 5000 });
if (planned.capped) console.warn("hit the cap you asked for — the index is partial");

// Phase B — only those, then drop anything still without contents so no
// phantom empty file enters the index.
for (const file of planned.files) setFileBytes(file.abs, await readBytes(file.rel));
pruneUnfetched();

// Load only the grammars these extensions need: a Go repo pays 217 KB and
// never touches the 5.4 MB C# grammar.
const grammars = await loadGrammars(new Set(planned.files.map((f) => f.ext)), (name) =>
  fetch(`/grammars/${name}`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
);
if (grammars.tier !== "ast") console.warn(`regex tier: ${grammars.note}`);

const { scan, graph, symbols } = buildIndexArtifacts(ROOT);
```

Holding every file already — a directory the user picked, an unpacked archive —
mount them in one pass with `bytes` set and skip phase A. The two phases matter
when *fetching* is the expensive part.

**API this build adds**, on top of the whole main barrel:

| | |
|---|---|
| `resetVfs()` | Empty the VFS. Call between trees so one cannot leak into the next. |
| `mountFiles(files)` | Mount `{ path, size, bytes? }`. Omit `bytes` for phase A. |
| `setFileBytes(path, bytes)` | Attach contents to a mounted path (or add a file). |
| `hasFileBytes(path)` / `residentBytes()` | Is it resident; total bytes held. |
| `pruneUnfetched()` | Drop every file still without contents; returns how many. |
| `loadGrammars(exts, fetchWasm)` | Fetch + mount the minimal grammar set; returns the tier achieved. |
| `mountRuntime(bytes)` / `mountGrammar(key, bytes)` | Lower-level mounts, if you drive loading yourself. Mount *before* `ensureGrammars`, which reads them synchronously. |
| `grammarWasmName(key)`, `RUNTIME_WASM` | Filenames, for assembling your own URLs. |

`loadGrammars` calls your `fetchWasm(name)` with bare filenames —
`web-tree-sitter.wasm` first, then `typescript.wasm` and so on. Copy
`node_modules/@maxgfr/codeindex/scripts/grammars/` into your static assets and
serve them as `application/wasm`; the set is immutable per release, so a `Cache`
entry keyed by URL never needs invalidating. Skip it entirely and every language
falls back to the regex tier — a real option for a small bundle, and
`loadGrammars` returns the tier it achieved so you can say which one you got
rather than implying the better one.

**Sizing.** ~325 KB minified (~90 KB gzipped); grammars are separate and lazy
(`go` 217 KB, `javascript` 412 KB, `python` 458 KB, `typescript` 1.4 MB, plus a
201 KB runtime). **Run it in a Web Worker**: extraction is synchronous and
CPU-bound by design — that is what keeps rebuilds byte-identical — so on the
main thread it blocks the page.

</details>

There is no `browser` export condition on the main entry, so no bundler will
swap the builds behind your back — ask for `/browser` explicitly. `runCli` and
`runMcpServer` are exported for signature compatibility and throw if called:
both are Node-only end to end.

Working example: the
[playground](https://maxgfr.github.io/codeindex/playground/), which indexes any
public repository client-side ([source](site/playground/)).

## Use as a CLI

```sh
brew install maxgfr/tap/codeindex        # or: npm i -g @maxgfr/codeindex

codeindex index   --repo . --out .codeindex   # graph + symbols + incremental cache
codeindex graph   --repo . > graph.json
codeindex scip    --repo . --out index.scip   # SCIP index (--out - for stdout)
codeindex callers --repo .                    # per-symbol caller index
codeindex hierarchy       --repo .            # type hierarchy (both directions)
codeindex implementations Runnable --repo .   # who implements it, transitively
codeindex callgraph buildGraph --repo . --depth 2
codeindex grep    'pattern' --repo .
codeindex literals --repo .                   # values with no single source of truth
```

## Values with no single source of truth

`codeindex literals` reports the defect a compiler cannot: **one value written
out across many files**, where a constant holding it already exists and some
call sites use it while others rewrite the literal. Change the value and the
helper's users follow; the literal's users silently do not.

Three labeled tiers, the same doctrine `deadcode` uses for
`unreferenced`/`uncalled` — the analysis says which case it found rather than
flattening them into one confidence-free list:

| tier | what it means | what to do |
|---|---|---|
| `competing` | two or more exported constants hold the same value | pick one owner, delete the rest |
| `bypassed` | a constant holds it, other files rewrite it anyway | import the constant at those sites |
| `uncentralized` | nothing holds it | decide whether it deserves an owner |

Two things make the output readable rather than a wall of strings:

- **Namespace families.** Path-like values are grouped by their root, so an app
  with forty route literals reports one `/checkout` finding, not forty.
- **Config files are read too.** JSON, YAML and TOML values are extracted
  alongside code, because the duplications that actually hurt are the ones that
  cross a language boundary — a threshold declared in TypeScript and again in a
  rules JSON, a route called from a Kubernetes manifest. Nothing else compares
  those pairs.

```sh
codeindex literals --repo . --min-files 3 --min-count 5   # tighten the floors
codeindex literals --repo . --include-tests               # count test files too
```

As a CI gate, via the `literals` builtin rule (defaults to the two actionable
tiers; `tiers` narrows it):

```json
[{ "name": "no-uncentralized-routes", "builtin": "literals", "tiers": ["competing"] }]
```

```sh
codeindex rules --repo . --config codeindex.rules.json    # exit 1 on violations
```

An arrow function returning a value (`export const getPath = () => "/a/b"`) is
a *consumer*, not a source of truth, and is reported as a call site. A lookup
table (`export const ROUTES = { … }`) genuinely is one, and is reported as a
holder.

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

`codeindex search "<query>" --repo .` ranks files with keyless **BM25F** over six
weighted fields: symbol names, path segments, markdown headings, the file
summary, per-symbol **doc comments**, and the **prose body** (words from comments
and short string literals, captured at extraction time so they ride the
incremental cache).

The last two are the point. An index built only from names — what a tags file or
a symbol-only search ships — is a perfectly scored index of the wrong text: the
words people search with are overwhelmingly in prose. Measured on the same
judged corpus, a names-and-paths-only index returns *nothing* relevant for 6 of
16 queries; with doc comments and prose in the index it is 1, at 93.8% MRR.
Field weights are calibrated against nDCG@10 on that corpus, not chosen by
taste.

Results carry `matchedFields` (was it the path or a doc comment?), a `line`
anchor and `symbolHits` (name, kind, line), so a hit is a place to open rather
than a file to re-read. A whole-identifier match outranks a subtoken match, and a
test file ranks below the code it tests unless the query asks for tests. A query term that
matches nothing in the corpus (zero document frequency) gets two deterministic
fallbacks, morphology first: a **stem match** ("caching" finds "cache",
"retries" finds "retry") because an unmatched term is far more often an
inflection than a typo, and only then a **trigram fuzzy fallback** — typo
tolerance without embeddings: the term is
compared to the corpus vocabulary by character-trigram Dice similarity
(threshold 0.6, top-3 candidates, contribution scaled by the Dice score so a
near-miss always ranks below an exact hit). Terms that already match anything
are never touched, so an existing query stays byte-identical. Enabled by
default; disable with `--no-fuzzy` (CLI) or `fuzzy: false` (library/MCP
`SearchOptions.fuzzy`); results carry an additive `fuzzyTerms` field when the
fallback contributed.

### When the query matched nothing

A search that finds nothing useful and a search that finds nothing *at all* look
identical in a ranked list, and the second one is the dangerous one.
`subtokens("nullGipStep7")` emits `["nullgipstep7", "null", "gip", "step7"]`, so
an identifier that is **not in the tree** still scores every file containing
`null` or `gip` — twenty confident-looking rows for a symbol that does not
exist. That is a real report, and it cost an afternoon.

So `search` now says so:

```sh
$ codeindex search nullGipStep7 --repo .
codeindex: No file in this index defines or mentions "nullgipstep7". The 5 results
below match only its parts (null, gip). Closest indexed names: nullgipstep2,
nullgipstep3. If you expected it here, check you are indexing the right branch
or commit.
```

The note goes to **stderr**, so stdout stays a bare JSON array. Machine-readable
diagnostics come from `explainQuery` (library), `--explain` (CLI) or the
`explain_search` tool (MCP):

| field | what it answers |
|---|---|
| `verdict` | `match` · `weak` (results rest on a near match, or the identifier has df 0) · `none` |
| `wholeIdentifier` | the identifier you typed, with its document frequency — df 0 is the finding |
| `unresolvedTerms` | terms that exist nowhere and bridged to nothing |
| `droppedStopwords` | why an all-stopword query returned an empty array |
| `terms[].bridge` | what a zero-df term fell back to, and whether by stem or trigram |

Individual results carry `bridgedOnly: true` when nothing matched verbatim —
present only when true, so an ordinary hit serialises to exactly the bytes it
always did. `--exact` drops those rows entirely. Nothing here changes a score or
an ordering, which is why the judged corpus cannot move.

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
resolved from `CODEINDEX_EMBED_DIR` or `<repo>/.codeindex/models/`. Getting one
is zero-config: `codeindex embed pull` fetches the official `embed-model-v1`
release asset, sha256-verified before anything is written.

```sh
codeindex embed pull   --repo .              # fetch the official model asset into
                                             # CODEINDEX_EMBED_DIR (or <repo>/.codeindex/models/); sha256-verified
codeindex embed status --repo .              # effective mode + reachability (JSON)
codeindex embed build  --repo . --out .codeindex   # write embeddings.bin
codeindex search "http client retry" --repo . --semantic
```

`codeindex index` also writes `embeddings.bin` next to `graph.json` when a model
is present. Fusion reuses the engine's `rrf` helper (k=60); `SCHEMA_VERSION` is
untouched (a dedicated `EMBED_VERSION` keys the sidecar).

#### Three embedding modes (precedence: endpoint > static > none)

| mode | trigger | determinism |
|---|---|---|
| **none** | no model, no endpoint | — (pure lexical) |
| **static** | a `model.json` on disk | byte-deterministic (goldens) |
| **endpoint** | `CODEINDEX_EMBED_ENDPOINT` set | per **image digest** |

The **rich (endpoint) tier** points the engine at a local containerized
embedding server (all-MiniLM-L6-v2). The endpoint's float vectors flow through
the *same* L2 + int8-quantize + integer-ranking pipeline as the static tier.
Setting the env var is explicit intent, so it **wins over** a local model; an
unreachable endpoint degrades to lexical (exit 0), not to the static model.

```sh
codeindex embed serve            # print the docker run one-liner (or --run it)
docker run -d -p 8756:8756 ghcr.io/maxgfr/codeindex-embed:latest
# reproducible: pin the digest → ghcr.io/maxgfr/codeindex-embed@sha256:<digest>
CODEINDEX_EMBED_ENDPOINT=http://localhost:8756 \
  codeindex search "auth token" --repo . --semantic
```

<details>
<summary><b>The <code>embeddings.bin</code> layout, the fusion rule, the full degradation matrix, and the HTTP protocol for your own endpoint</b></summary>

`embeddings.bin` is what `deserializeEmbeddings` reads back:

```
offset 0            "CIE1"      4-byte ASCII magic (a foreign file fails loudly)
offset 4            uint32 LE   header length
offset 8            UTF-8 JSON  { embedVersion, modelId, dim, count, records:[{file,symbol,line}] }
offset 8+headerLen  int8 body   count × dim signed bytes, row-major
```

No absolute path and no timestamp; records follow scan order, so two builds of
an unchanged repo are byte-identical. `EMBED_VERSION` + `modelId` + `dim`
invalidate a stale or foreign artifact. Granularity is per-symbol (name +
signature + file summary + path segments), with a per-file fallback for
symbol-less files so every file with content is represented.

**Fusion is by RANK, never a score blend**: BM25 scores and integer dot products
live on incomparable scales, so `searchSemantic` uses the shared `rrf` helper
(k=60) and adds `semanticSymbol` — the corpus symbol whose embedding was closest
for that file — additively to the lexical result.

To implement your own server, `CODEINDEX_EMBED_ENDPOINT` is the **base URL** and
the client derives two routes:

| method + path | request | response |
|---|---|---|
| `POST {base}/embed` | `{ "texts": ["…", …] }` | `{ "vectors": [[…float…], …] }` — same order, one row per text |
| `GET {base}/healthz` | — | `200` (any body) when ready |

Any dimension is accepted and vectors need not be pre-normalized — the engine
L2-normalizes and int8-quantizes whatever it receives, through the *same* tail
as the static tier, so ranking stays a pure integer dot product. Requests time
out after `CODEINDEX_EMBED_TIMEOUT_MS` (default 30 000). Endpoint corpus vectors
are built at search time and **never serialized**: that tier is deterministic
per image digest, not byte-golden, so pin the digest. The reference server is
`docker/embed/` (transformers.js + all-MiniLM-L6-v2, baked in at build, offline
at run, non-root, `:8756`).

**Degradation, in full** — every row exits 0:

| present | behaviour |
|---|---|
| nothing | BM25 lexical |
| + fuzzy | BM25 + stem/trigram fallback for `df==0` terms |
| + model asset | RRF-fused deterministic static semantic search |
| + `CODEINDEX_EMBED_ENDPOINT` | rich tier — **wins over a static model** |
| `--semantic`, nothing available | lexical + stderr note |
| endpoint set but unreachable | lexical + stderr note — **never** falls back to the static model |

</details>

## Type-aware references (opt-in LSP tier)

`find_references` ships three labelled tiers, and it says out loud that the
third is name-based and may include homonyms. A language server does not have
that problem, so — same doctrine as the embedding tier — you can point one at
the repository and get its answer *alongside* the static one:

```jsonc
// <repo>/.codeindex/lsp.json — presence of this file IS the opt-in
{
  "version": 1,
  "servers": [{
    "id": "ts",
    "languages": ["typescript", "tsx", "javascript"],
    "command": "typescript-language-server",
    "args": ["--stdio"]
  }]
}
```

```sh
codeindex lsp status --repo .           # config, PATH resolution, files claimed
codeindex lsp status --repo . --probe   # also start each server, read its real capabilities
```

`find_references` then takes `lsp: true` and appends an `lsp` block:

```jsonc
{
  "defs": [...], "callSites": [...], "referencingFiles": [...],   // unchanged
  "lsp": {
    "server": "ts", "ok": true, "refs": [...],
    "agreement": { "both": [...], "lspOnly": [...], "staticOnly": [...] }
  }
}
```

**It annotates, it never replaces.** The three static tiers come back
byte-identical, and the product is the agreement matrix: `lspOnly` is where the
static tier under-recalled, and **`staticOnly` is where the homonyms are** — the
only evidence the static tier over-reported, which a replace-merge would delete.
A language server that has not finished indexing returns a partial answer with
no error, which a union makes visible and a replace would silently hide.

Three deliberate constraints:

- **It cannot touch `graph.json` / `symbols.json`.** The config lives under
  `.codeindex/` — already in the walker's ignore list — so it is not even a
  walked file, and nothing under `src/lsp/` appears in the import closure of the
  artifact pipeline. That is checked by building this repo's own graph
  (`tests/lsp-boundary.test.ts`), not asserted in a comment.
- **No built-in server table.** A default that activated itself wherever
  `typescript-language-server` happened to be installed would make the same repo
  answer differently per machine.
- **Every failure degrades to the static answer on exit 0**, with a stated
  reason: absent config, absent binary, missing capability, crash, timeout.

## Use as an MCP server

`codeindex mcp` (or `node scripts/cli.mjs mcp`) serves the engine over stdio.
Register it in Claude Code with:

```sh
claude mcp add codeindex -- codeindex mcp
```

**33 tools**, grouped by what they answer:

| group | tools |
|---|---|
| orient | `scan_summary`, `onboard` *(write)*, `repo_map`, `graph`, `mermaid`, `workspaces` |
| find | `search`, `explain_search`, `grep`, `find_symbol`, `symbols`, `symbols_overview` |
| impact | `find_references`, `callers`, `call_graph`, `dead_code` |
| types | `type_hierarchy`, `implementations` |
| risk | `hotspots`, `churn`, `coupling`, `complexity`, `check_rules`, `duplicated_literals` |
| edit *(write)* | `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol` |
| memory | `write_memory`, `read_memory`, `list_memories`, `delete_memory` *(write except reads)* |
| tiers | `embed_status`, `lsp_status` |

`onboard` is the one that saves the most round trips: it composes
`scan_summary` + `workspaces` + `repo_map` + `hotspots` into one project brief
and persists it as the `onboarding` memory, so the second session reads instead
of rebuilding.

### Advertising fewer tools

Every advertised tool's full JSON Schema sits in an agent's context on **every
turn**, so a session that only ever searches is paying for the graph analytics
all day. `--tools` advertises a named subset:

```sh
codeindex mcp --tools find          # search, explain_search, grep, find_symbol, symbols, symbols_overview
codeindex mcp --tools orient,impact # compose profiles with a comma
```

Profiles are `all` (the default), `orient`, `find`, `impact`, `edit`, `risk`.
It trims what is **advertised**, not what is answerable: a tool left out of the
profile still works when called by name, so a narrowed server loses no
capability. An unknown profile fails at startup rather than quietly advertising
everything.

### Pinning the server to one repository

Every tool takes a `repo` argument. A host that runs one server per workspace
can pin it instead, so `repo` becomes optional on every tool — the pin is
reflected in the advertised schema, not merely tolerated at call time:

```sh
codeindex mcp --repo /path/to/workspace
```

An explicit per-call `repo` still wins, so a pinned server can still answer
about another checkout. `--server-name <name>` overrides the announced
`serverInfo.name` for hosts that embed the server under their own identity.
Add `--watch` to a pinned server for proactive recursive filesystem
invalidation. Every request still verifies freshness with the normal stat walk
because a request can arrive before its filesystem event; the watcher is a hint,
not a correctness oracle. Directories excluded by the scanner (`.git`, build
outputs, dependency caches, `.codeindex`, edit temporaries, etc.) are ignored by
the watcher too. Git commit metadata is still refreshed by the per-request
check. When the platform cannot provide recursive watching, the server warns
and continues with those normal freshness scans.

**Prime the index first** and activation becomes a load, not a rebuild:
`codeindex index --repo <dir> --out <dir>/.codeindex`. The first tool call
deserializes those artifacts when the engine version, commit and artifact
hashes all match. The same index also makes every CLI read command
(`search`, `symbols`, `graph`, `repomap`, …) a lookup instead of a rebuild.

### Protocol, and what it costs an agent

The server negotiates its protocol version: it answers with whatever revision
the client asked for among `2024-11-05`, `2025-03-26`, `2025-06-18` and
`2025-11-25`, and otherwise with the newest. Fields a later revision
introduced are only sent to clients that asked for it, so an older client sees
exactly what it saw before.

From `2025-03-26` every tool carries behaviour annotations — `readOnlyHint` on
the 27 read tools, `destructiveHint`/`idempotentHint` on the six that write —
which is what lets a host auto-approve reads and confirm only writes. From
`2025-06-18`, the 20 tools whose result is always a JSON object also declare an
`outputSchema` and return `structuredContent`, so a client can validate and type
the result instead of re-parsing a string. The remaining tools return arrays,
argument-dependent shapes or plain text, which cannot yield a conforming
structured result without diverging from the text block — they are left
unschema'd rather than described inaccurately.

Responses are capped (`--max-response-bytes`, default 1 MB). Under the cap
nothing changes. Over it — where a whole-repo `graph` on a large monorepo runs
to millions of tokens and no client can accept it — the response is replaced by
a short notice naming the size, the artifact already on disk, and the narrower
tool that answers the question. Most tools also take a `limit`/`maxResults`/
`top`/`maxEdges` argument to stay well under it.

`engine.mjs` is a pure side-effect-free library (safe for consumers to inline
into their own CLIs); `cli.mjs` is the thin standalone CLI/MCP wrapper.

## Command rewriting

`codeindex rewrite '<command line>'` maps an expensive tree-wide search onto
its indexed equivalent, for agent harnesses that intercept shell commands
(iterion's `rewriters` plugin kind, generalizing rtk):

```sh
$ codeindex rewrite 'grep -rn TODO src'
codeindex grep TODO --scope src
```

It prints the replacement and exits `0`, or exits `1` with empty stdout when it
has no opinion — run the original. The parser is deliberately conservative: any
shell metacharacter (pipe, redirect, substitution, chaining), any unrecognized
flag, a non-recursive `grep`, or more than one search path all refuse the
rewrite. A refusal costs nothing; a wrong rewrite silently changes what the
agent asked for.

## Versioning

- `ENGINE_VERSION` — the release tag, embedded greppably in the bundle.
- `SCHEMA_VERSION` — the `graph.json`/`symbols.json` shape (currently 5).
  Consumers reject mismatched artifacts.
- `EXTRACTOR_VERSION` — the extraction output shape; incremental caches keyed
  on it are discarded wholesale when it bumps.

`buildGraph`/`buildIndexArtifacts` accept `meta: { version, schemaVersion }` so
a consumer can stamp its own identity into artifacts it persists.

## How it compares

Measured against universal-ctags, Serena (LSP over MCP) and Graphify with a
reproducible harness (`scripts/bench/`) — median of 5 runs, one warmup
discarded; full methodology, fairness notes and every scenario in
[BENCHMARKS.md](./BENCHMARKS.md). These are architecturally different tools, so
every row is a specific operation, never a vague "codeindex vs tool X" — and
the last column names who actually wins it, including the rows we lose.

_Provenance: the answer-quality and token rows were measured 2026-08-12
(serena 1.6.1, graphify 0.9.26); the timing, determinism and footprint rows come
from the 2026-07-25 session on the same machine (Apple M5, Node v24.15.0). Two
dates in one table, said out loud rather than implied._

| | codeindex | universal-ctags | Serena | Graphify | winner |
| --- | --- | --- | --- | --- | --- |
| what it produces | byte-stable `graph.json` / `symbols.json` + SCIP | a flat `tags` file | live LSP answers, no artifact | `graph.json` from tree-sitter | — |
| cross-file edges | imports, calls, `extends`/`implements`, doc links | none | live and type-aware | label-matched, basename-keyed files | — |
| **answers correct** (75 compiler-graded questions) | **75 / 75** | n/a — no MCP server | 49 / 50, 25 unanswerable | 19 / 50, 25 unanswerable | **codeindex** |
| tokens per answer | 76–89 default / **35 concise** | n/a | 48–54 | 31–42 | **codeindex** (concise) |
| answers on a 27,952-file repo | **25 / 25** | n/a | cannot index at bench time | cannot index at bench time | **codeindex** |
| cold index — 2,823 files | 631 ms | **330 ms** | 7,695 ms | 10,478 ms | **ctags** |
| cold index — 27,952 files | 4,917 ms | **3,357 ms** | n/a — intractable | n/a — intractable | **ctags** |
| warm rerun / one file touched | **1,234 ms / 2,489 ms** | no incremental mode | re-indexes lazily in-session | rebuilds via the cold command | **codeindex** |
| warm query (find-symbol, `next.js`) | **1 ms** in-proc | 104 ms tags scan | n/a at that size | n/a at that size | **codeindex** |
| byte-identical rebuilds | **7 / 7 repos** | not measured | no artifact to diff | 0 / 6 measurable repos | **codeindex** |
| declarations vs the TS compiler | **100%** | 94.6% | n/a | n/a | **codeindex** |
| language coverage | 16 regex extractors, 21 tree-sitter grammars | **~40**, generic parser rules | any language with an LSP server | 36 via tree-sitter | **ctags / Serena** |
| type-aware references | opt-in LSP tier, annotating the static answer | none | **native** | none | **Serena** |
| install footprint | **23.5 MB, zero runtime deps** | single binary | 114.3 MB venv + language servers | 140.1 MB Python venv | **ctags** |
| MCP server | **33 tools**, subsettable by profile | none | yes, LSP-backed | yes | **codeindex** |
| onboarding brief | `onboard`, one call, persisted as a memory | none | `onboarding` | none | tie |
| says when a query matched nothing | **verdict on every search** (`match`/`weak`/`none`) | no | not measured | not measured | — |

**The rows we do not win, stated plainly.** ctags indexes cold faster at
every size and installs smaller — it is writing a flat tags file, which is a
smaller job, and it will keep winning that row. ctags and Serena cover more
languages: ~40 generic parser rules and "anything with a language server"
against our 21 grammars plus 16 regex extractors. And Serena's references are
type-aware where ours are static, which is the gap the
[opt-in LSP tier](#type-aware-references-opt-in-lsp-tier) exists to close
without making everyone pay for it.

### Is the answer right? — the row nobody had

Every figure above measures a **cost**. None of them says whether the answer is
*correct*, which is the whole of the claim when someone says a tool is "more
powerful for an AI". So it is measured now, on 75 questions whose answers come
from `scip-typescript` — the real TypeScript compiler — and asked of all three
MCP servers through one shape-blind grader:

| repo | server | asked | **correct** | incomplete | missed | tokens/answer |
| --- | --- | --- | --- | --- | --- | --- |
| t3-oss/create-t3-turbo | **codeindex** | 25 | **25** | 0 | 0 | 89 |
| t3-oss/create-t3-turbo | codeindex `concise:true` | 25 | **25** | 0 | 0 | **35** |
| t3-oss/create-t3-turbo | serena | 25 | **25** | 0 | 0 | 48 |
| t3-oss/create-t3-turbo | graphify | 25 | 17 | 5 | 3 | 42 |
| socialgouv/code-du-travail-numerique | **codeindex** | 25 | **25** | 0 | 0 | 82 |
| socialgouv/code-du-travail-numerique | serena | 25 | 24 | 1 | 0 | 54 |
| socialgouv/code-du-travail-numerique | graphify | 25 | **2** | 4 | **19** | 31 |
| vercel/next.js (27,952 files) | **codeindex** | 25 | **25** | 0 | 0 | 76 |
| vercel/next.js (27,952 files) | serena | — | — | — | — | n/a — too large to index at bench time |
| vercel/next.js (27,952 files) | graphify | — | — | — | — | n/a — too large to index at bench time |

Read it honestly, because it does not say what a marketing table would.

**On correctness, Serena is a tie, not a loss.** On the two repos where both run
it is 50/50 against 49/50 — one question, which is noise. Nobody should read
that row as a win either way.

**On tokens the default row is a loss, and it is the signature.** Our
`find_symbol` returns each declaration's complete signature (parameters and
return type) because "what shape is it" is the question that follows "where is
it" almost every time, and one round trip beats two. Serena's returns the
location. Measured on `Route` in `create-t3-turbo`:

| answer | bytes | what you get |
| --- | --- | --- |
| **codeindex `concise: true`** | **498** | name, kind, path, line |
| serena `find_symbol` | 640 | name_path, kind, path, line span — **no signature** |
| serena `find_symbol` + `include_body: true` | 1,503 | the whole function body |
| codeindex `find_symbol` (default) | 1,561 | the **complete signature** per match |

_Both tools return the same 4 matches, both measured over their own MCP server —
so these are payload sizes for identical answers, not different answers._

So both ends of the trade exist here, and the caller picks: ask a locating
question and pay **498 bytes / 35 tokens** for it — under Serena's 640/48, at
the same 25/25 — or ask a shape question and get a distilled signature for
roughly what Serena charges to hand you the raw body. What makes that true is
one flag, not a smaller answer: the default did not move.

**Against Graphify it is not close**, and the second row is the reason: on the
1,429-file monorepo it answers **2 of 25**, missing 19 outright. Its nodes are
label-matched and its file nodes are keyed by basename, which is fine on a small
tree and collapses on a real one.

**The last three rows are the ones that are not a tie.** Both competitors are
gated above ~8k files, so on `vercel/next.js` their score is not a loss — it is
*no answer at all*, because the index cannot be built at bench time. codeindex
indexes that tree in 4.9 s and answers 25 of 25 from it, at the lowest token
cost of the three repos. Across all 75 questions it is 75/75.

The other axis where the honest answer is not ours: Serena's references come
from a live language server and are genuinely type-aware. Nothing static matches
that, which is why codeindex now offers the same thing as an
[opt-in tier](#type-aware-references-opt-in-lsp-tier) that *annotates* the static
answer instead of replacing it — and reports where the two disagree.

Full methodology, the three rules that keep the grader from being a variable in
its own experiment, and how to reproduce it:
[BENCHMARKS.md](./BENCHMARKS.md#answer-quality).

### So why this one

Nothing above says "use codeindex for everything", and the table is built so it
cannot. What it does say is that four properties come together here and nowhere
else in the comparison:

- **Correct at repository scale.** 75/75 on compiler-graded questions, including
  on a monorepo where the closest static competitor scores 2/25 and on a
  27,952-file tree where neither competitor runs at all.
- **Reproducible.** `graph.json`/`symbols.json` are byte-identical across
  rebuilds on **7/7** repos; Graphify manages 0/6 and Serena has no artifact to
  compare. That is what makes an index reviewable in a PR and cacheable in CI.
- **Cheap to adopt and to keep.** 23.5 MB, zero runtime dependencies, one
  vendorable file — against a 114 MB venv plus language servers, or a 140 MB
  Python venv. It is the only one of the three with an incremental reindex
  (1.2 s warm, 2.5 s with a file touched).
- **Honest when it cannot answer.** A search that matches nothing
  [says so](#when-the-query-matched-nothing); a walk that was capped sets a flag;
  an absent tier degrades on exit 0 with a stated reason. Everything else in this
  README is a number someone can re-run.

Cold-index speed is the axis this engine wins least, and the table says so: a
flat `tags` file is a smaller job, and ctags finishes it first at every size —
by an order of magnitude on small repos. Where the extra time goes is the rows
under it: a typed cross-file graph, an incremental reindex nobody else exposes,
and rebuilds that are byte-identical. Serena buys type-aware references no
static tool claims, and pays for them in activation and per-call latency.

On context cost, a single-symbol lookup through the index returns **390.3×**
fewer tokens than the raw grep it replaces on `vercel/next.js` (measured
bytes/4, both sides).

## Development

```sh
pnpm install
pnpm test          # unit + fixtures + compat + no-wasm gates
pnpm typecheck
pnpm build         # tsup → scripts/engine.mjs + scripts/engine.d.mts
pnpm check:build   # proves the committed bundle is byte-reproducible
pnpm test:e2e      # opt-in: pinned real-repo builds with ratchets
```

The compat suite pins golden bytes for the `mini-repo` fixture — the proof
that extraction stays lossless across releases.

## License

MIT
