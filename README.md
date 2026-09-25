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
  A symlink that stays inside the repo, file or directory, is an alias: its
  target is indexed once, under its own path. `build`, `out`, `target` and
  `tmp` are skipped as build output unless git tracks files in them — they
  are ordinary package names too (a Go `build` package, `com.acme.build`).
  Nested repositories (a subdirectory with its own `.git` — linked worktrees,
  vendored clones, submodules) are skipped like git does, and `.git` itself —
  like the engine's own `.codeindex` — is never walked even when
  `--ignore-dir` replaces the default ignore list. No
  file-count cap unless you ask for one (`--max-files`), and asking sets the
  `capped` flag — never a silent truncation.
- **Scan** every file into a `FileRecord`: classification, language, symbols,
  imports, headings, hashes — with an incremental cache fastpath. Extraction
  runs across worker threads by default (`--workers`, `CODEINDEX_WORKERS`);
  artifacts are byte-identical either way, and anything that would make a
  worker's result differ falls back to the single-threaded path. JS/TS and
  Python imports are read from code only: comments, docstrings and
  string/template-literal text are masked first, so example code quoted in a
  JSDoc block, a docstring or a code generator's template never becomes an
  edge (JSDoc `import("./x")` types and `@import` tags, which are real type
  dependencies, are kept). The same scan runs with or without a grammar, so
  `extractAst` and the index report the same imports. Python
  `from pkg import name` also links `pkg/name.py` when `name` is a submodule
  (and nothing when it is a function or class); PHP group (`use A\{B, C}`) and
  comma `use` lists and `__DIR__`-anchored includes are followed, and a trait
  `use` inside a class is not an import. Build output committed under an
  ordinary name is recognised by its content: minified JavaScript (not only a
  `.min.js` name) and bundles (esbuild's `// src/x.ts` module banners, webpack's
  and ncc's module loader). It stays in the index with its summary and
  imports, flagged `generated: "minified"` or `"bundle"` on its `FileRecord`
  and graph node, but its symbols and call sites are not extracted: one-letter
  noise for the first, copies of the sources' definitions for the second.
- **Extract symbols** via tree-sitter (15 committed grammars, plus 6 more via
  `grammars pull`) or per-language regex rules (16 languages, always available).
  Each symbol carries its **complete signature** (parameters and return type,
  not the first physical line; one line, with no comment and no body — not an
  arrow's expression body, a Go interface's method list or a macro's
  expansion), its own **doc comment**, its qualified `parent`,
  and its line span — including the members a declaration-only walk misses:
  interface members, class fields, enum members, every `declare`/`.d.ts`
  declaration, Rust trait method signatures, Go interface method sets and type
  aliases, record components, constructor `val` parameters and their
  TypeScript (`private readonly dep: Dep`) and PHP 8 (promoted) twins, every
  name of a multi-name declaration (`var a, b int`, `int x, y;`,
  `a, b = 1, 2`), C `#define` macros and the members of a `typedef struct`,
  Python declarations under `if TYPE_CHECKING:` / `try:` / `with` blocks, Ruby
  `class << self` methods, `private def x` definitions and the block of
  `Point = Struct.new(…) do`, Elixir clauses with a `when` guard and
  `defguard`, and the members of a class bound by `module.exports =` or an
  anonymous `export default class` (a default export with no name of its own
  is named after the file stem). A doc comment is found across Rust
  attributes and TypeScript decorators. Visibility is read from a
  declaration's modifiers, never from its parameter names or default values;
  an `export { … }` list marks only the bindings of its own scope; and a
  Python module's `__all__` (when written as literals) decides which of its
  top-level names are public, the names it imports and lists becoming
  `reexport` symbols. An out-of-line C++ definition (`void Widget::draw()`)
  belongs to its class, and a Lua `function M.go()` to its table; a `.h`
  header is parsed as C++ when its content is (a namespace, class or
  template), as C otherwise. Vue, Svelte and Astro
  single-file components are extracted from their `<script>` blocks (and
  Astro's frontmatter) as the JS/TS their `lang` names, at their real lines:
  symbols, imports, and calls from both the script and the template, bound in
  the JS/TS call family. A Svelte prop (`export let`) and an Astro frontmatter
  export are not module exports, so they are never reported as dead code.
  The regex tier (the only one for Swift and Dart, and for the extended
  languages until a pull) reads code only: comments and strings are masked,
  so an example in a doc comment or a code generator's template is not a
  declaration. It takes each declaration's doc comment from the lines above
  it and, in brace languages, its line span, but only where the body's
  braces close as a formatter puts them; otherwise the span is left out
  rather than guessed. Its signature is the declaration's first line, and it
  reports no `parent`.
  Each file's **summary** is the first leading comment that describes
  something: license and copyright text (MIT, BSD, Apache, GPL, MPL, the Go
  "governed by" line), linter and editor magic comments (`frozen_string_literal`,
  `-*- coding -*-`, `go:build`), Xcode's file stamp and bundler region markers
  are skipped, and `#` reads as a comment only in languages where it is one —
  never a C `#include` or a Rust `#[attribute]`.
  Docs get a title, section headings, a summary and `doc-link` refs: markdown
  (ATX and setext headings, inline and reference links) and reStructuredText
  (Sphinx section titles; `toctree` entries, `:doc:` roles and
  `include`/`literalinclude` targets as links). Other prose (`.txt`, `.adoc`)
  is indexed under its file name.
- **Resolve imports** across languages: tsconfig `paths` (tsc's precedence:
  exact alias, then longest prefix) and `baseUrl`, `extends` chains into
  workspace packages and `${configDir}`, package `exports` and `imports`
  (`#subpath`), bundler `?query` suffixes, Python import roots found the way
  mypy finds them (the dir holding each top-level package, so src layouts
  resolve and a package's own `typing.py` does not shadow the stdlib), go.mod
  (a package's representative file is never a `_test.go` when it has other
  files), Cargo (`[lib]` names, renamed dependencies, `#[path]` modules, and
  `use` paths read the way the crate's edition reads them), PSR-4, C#
  namespaces, and one JVM index for Java, Kotlin and Scala, so a Kotlin file
  importing a Java class (or the reverse, through the `<File>Kt` facade)
  links; Scala selector groups and package-relative imports resolve too. Dart
  (relative and `package:` URIs of an in-repo `pubspec.yaml`), Lua `require`
  (`a/b.lua`, `a/b/init.lua`), shell `source`/`.` of a literal path, and
  Elixir `alias`/`import`/`use` of a module the repo defines resolve as well.
  A markdown link starting with `/` is repo-root-relative, as GitHub renders
  it.
- **Build a typed link-graph**: `import` / `call` / `extends` / `implements` /
  `use` / `doc-link` / `mention` edges at file and module level, plus Louvain
  communities, PageRank/betweenness centrality, a tests→code map (a test
  covers what it imports, uses or calls, the file it is named after, and in Go
  its whole package), and surprise-edge detection. Inheritance also yields a **type hierarchy** (what a
  type extends and implements, and what extends and implements IT) and a
  **symbol-level graph** for bounded "what does this reach" neighborhoods.
  Go states no implementations, so the hierarchy adds them: a
  `var _ I = (*T)(nil)` assertion, or a type whose methods (its own, plus the
  ones embedding promotes) match the interface's by name and parameter count.
  The second kind is marked `structural: true`. These are answers to
  `hierarchy` and `implementations` only, never graph.json edges.
- **Render** byte-stable `graph.json` / `symbols.json` (two builds of an
  unchanged repo are byte-identical), plus a **SCIP** code-intelligence index
  (`index.scip`: nested symbols, package identity, implementation
  relationships) via a hand-rolled zero-dependency protobuf encoder — validated
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
| **Grammar vocabulary** | each tree-sitter grammar's own declared node types, read at runtime from the parser | 21 grammars audited, **209** declaration-ish node types still unhandled |

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
| symbol precision / recall | **100% / 100%** | 346 labelled declarations in 23 files |
| kind accuracy | **100%** | the same 346 declarations |
| visibility accuracy | **100%** on 16 of 17 languages, 95.8% on Go | the same 346 declarations |
| doc comment attached | **100%** | the 188 declarations labelled with a doc |
| complete signature | **100%** | the 32 declarations labelled with a signature |
| call edges / inheritance (F1) | **100% / 100%** | 54 labelled call sites, 24 relations |
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

### Inventory consumers

`walk(root, options)` also serves exhaustive inventories. The default source-indexing
policy is unchanged. Opt into `includeBinary`, `includeLockfiles`, `includeOversize`,
`includeMinified` and `includeFileSymlinks` (in-repo file links, skipped by default
as aliases), or replace `binaryExtensions` to keep textual SVG. These
controls are independent: a `.lock` extension still follows the binary policy.

`filter({ rel, abs, directory })` prunes consumer output and out-of-scope trees
before descending. `onSkip({ rel, reason, directory, size? })` records observed
exclusions, including nested repositories and broken links, without allocating a
second inventory for ordinary indexing. It does not enumerate pruned descendants;
`capped` still means that an explicitly requested file budget cut the walk short.

`readTextEx(path)` distinguishes empty, binary and unreadable files, reports the
encoding and original bytes, and marks whether decoded offsets address those bytes.
`OffsetMap` converts JavaScript string positions to UTF-8 byte positions. Consumers
keep their own classification and editing policy; `readText` remains the compatible
string-only reader.

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
resolved-vs-missing per tier (and `extendedPullNeeded` while any extended
grammar is missing) so a Kotlin repo quietly indexed by regex is visible rather
than guesswork.

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

Resolution is **adjacent > env > cache > regex**, per grammar: a
bundle-adjacent `grammars/` still wins if present (offline setups are
untouched), then `CODEINDEX_GRAMMARS_DIR`, then the pulled cache — and a
grammar the winner lacks is looked up in the tiers below it. That is what lets
the npm package (which ships only the core wasms) pick up the extended ones a
pull put in the cache. The legacy `CODEINDEX_GRAMMAR_DIR` still pins one dir
with nothing behind it. `pull` fetches the official
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
codeindex status  --repo . --check            # is .codeindex still fresh? (exit 1 if not)
codeindex scan    --repo . --why src/big.go   # why is this file (not) indexed?
codeindex graph   --repo . > graph.json
codeindex scip    --repo . --out index.scip   # SCIP index (--out - for stdout)
codeindex callers --repo .                    # per-symbol caller index
codeindex hierarchy       --repo .            # type hierarchy (both directions)
codeindex implementations Runnable --repo .   # who implements it, transitively
codeindex callgraph buildGraph --repo . --depth 2
codeindex find    Client/send --repo .        # declarations: signature, doc, parent, span
codeindex refs    backoff --repo .            # defs, bound call sites, referencing files
codeindex outline src/client.ts --repo .      # one file's symbols, in declaration order
codeindex symbol-at src/client.ts:42 --repo . # the symbol holding that line, and its id
codeindex callpath main backoff --repo .      # how main reaches backoff, shortest chains first
codeindex grep    'pattern' --repo .
codeindex literals --repo .                   # values with no single source of truth
codeindex workspaces --repo . --check         # monorepo packages; undeclared sibling imports exit 1
codeindex resolution --repo .                 # per-language import resolution health
codeindex mermaid src/app --repo .            # module diagram around a module, dir or file
codeindex hotspots --repo . --since "6 months ago"   # where work concentrates
```

`index` keeps a `cache.json` next to the artifacts, and every read command
reuses whatever sits in `--index` (default `.codeindex`; relative to the repo,
or absolute): unchanged files skip extraction, and when nothing changed the
artifacts load instead of being rebuilt — one file at a time: `graph` and
`symbols` print the sha-verified bytes on disk as they are, and a command that
needs only the graph never reads `symbols.json`. A new commit over an unchanged
tree only restamps `graph.json`'s `commit`; `symbols.json` is kept as it is.
The index dir itself is never scanned, and `--out .` at the repo root skips
only the artifacts it writes. A record is reused only if it was extracted the
way this run would extract it — the same `--no-ast`/`--max-calls` setting and
the same grammar per language — so switching either, or pulling a grammar,
re-extracts exactly the files it affects. Freshness is keyed on `(size,
mtime)`; for an edit that preserves both, `--full-hash` re-hashes every file
and `--no-index-cache` ignores the cache altogether (for `index` too).
Artifacts are replaced atomically (a temp file renamed over the old one), so a
concurrent reader never sees a torn file.

Next to `cache.json`, `index` writes `freshness.json`: each file's `(hash,
size, mtime)`, the artifact shas and versions, without the per-file records
that make up nearly all of `cache.json` (10MB against 142MB on a 66k-file
repo). It is enough to prove the artifacts fresh, so `graph`, `symbols`, the
commands that need only the graph, `status`, and an `index` with nothing to
write never parse `cache.json` (on that repo: `graph` 4.4s → 1.5s, `status`
4.0s → 1.6s, an unchanged `index` 5.6s → 1.8s). It records `cache.json`'s own
`(size, mtime)`, so one rewritten without it is ignored; a missing, stale or
malformed `freshness.json` only sends the command the slower way, to the same
answer.

`codeindex status` says whether that index still describes the tree, without
rebuilding anything: it reads `freshness.json` (else `cache.json`), walks and
stats, and hashes only the files whose `(size, mtime)` changed. It reports whether `cache.json` is
usable (or why not: `absent`, `unreadable`, `corrupt`, or written for another
`schema` or `extractor` version), the indexed and HEAD commits, per-file drift
(`unchanged`, `touched`, `modified`, `added`, `deleted`, and `reextract` for
records built under another `--no-ast`/`--max-calls` setting or grammar set),
and `artifactsFresh` with the reasons it is false (`engine-version`,
`extraction`, `files`, `graph.json`, `symbols.json`). It judges the index under
the flags it is given, as a read command would. `--check` exits 1 unless the
artifacts are fresh: a CI gate for a committed index. A moved HEAD alone is not
stale, since an index committed to the repo never matches the commit that
contains it and read commands restamp the commit anyway; `embeddings.bin` is
not checked. The MCP `index_status` tool gives the same answer.

`--scope <dir|file>` restricts a command to one part of the repo (`./src`,
`src/` and an absolute path inside the repo all name `src`), and combines with
`--include`/`--exclude` as an intersection: `--scope src --include '**/*.md'`
is the markdown under `src/`. Globs are rooted at the repo, so `*.md` is the
top-level files only and `**/*.md` any depth. The filter runs inside the walk:
`--max-files` counts only files it keeps, and a directory that cannot hold one
is never listed (a `--scope` over 186 files of a 66k-file repo walks those
186). `grep` takes the same intersection, applied to the files it searches
(its ripgrep walk is not pruned by it). A `--scope`
that does not exist, an `--ignore-dir` given a path rather than a directory
name, and a filter that keeps no file at all each print a warning on stderr.

`scan` also counts what the walk left out, by reason (`skipped`: `gitignored`,
`ignore-dir`, `over-max-bytes`, `binary-ext`, `lockfile`, `minified`, `filter`,
`nested-repo`, the symlink cases and `index-output`; a skipped directory counts
once, since its contents are never listed). `scan --skipped` lists every skip,
sorted by path, and `scan --why <path>` explains one path as `{path, indexed,
reason, detail}`: the detail names the ignore file, line and pattern that
decided it, its size against `--max-bytes`, the
`--scope`/`--include`/`--exclude` that filtered it out, or the skipped
directory above it.

### Naming a symbol

`callers`, `hierarchy`, `implementations`, `callgraph`, `callpath` and `refs`
(and MCP `callers`, `find_references`, `type_hierarchy`, `implementations`,
`call_graph`, `call_path`) read a symbol the same way, so an id copied out of one answer pastes into the next:

| form | means |
|---|---|
| `greet` | the name. A single-answer command picks the first homonym; `find_references` covers them all, and then tags each call site with the declaring file it binds to (`def`) |
| `greet@src/lib/greet.ts` | the declaration in that file — any homonym, the first included |
| `src/lib/greet.ts#greet`, `src/a.ts#Greeter/hello` | a symbol id, as `callgraph` prints it |
| `Greeter/hello` | a member of `Greeter` |

An unknown symbol is an error (exit 2; MCP `isError`). A known one that no call
site binds to is still an answer, and says why it is empty:

```jsonc
// codeindex callers register_blueprint --repo flask
{
  "name": "register_blueprint",
  "error": "no tracked callers for \"register_blueprint\"",
  "defs": [ /* src/flask/sansio/app.py:570, src/flask/sansio/blueprints.py:256 */ ],
  "unresolvedSites": 74,   // sites naming it that bind to no single definition
  "sample": [ /* the first five */ ],
  "hint": "…"
}
```

`find`, `refs` and `outline` print the same answers as MCP `find_symbol`,
`find_references` and `symbols_overview`: each declaration's complete
signature, doc comment, parent and line span, which `symbols` leaves out.
`find` takes a name or `Parent/name` (`--substring`, `--include-body`,
`--concise`, `--limit`, default 50) and answers `[]` when nothing matches;
`refs` takes any symbol form above and, like MCP, still answers for a name the
repo does not declare; `outline` exits 2 on a file the index does not hold.
Like every read command they reuse a fresh persisted index (`--index`).

`symbol-at <file:line>` (MCP `symbol_at`; `file:line:col` works too) turns a
grep hit, a stack frame or a diagnostic into a symbol: the innermost
declaration holding the line, with its id, which pastes into `callers`,
`callgraph` and `callpath`, and the declarations around it, outermost first.
`symbol` is `null` outside every declaration. Regex-tier files record no end
lines, so there the answer is the nearest declaration above, marked
`"approximate": true`.

`callpath <from> <to>` (MCP `call_path`) answers how one symbol reaches
another: the shortest chains of calls, following dispatch like `callgraph`
(a step onto an override says `"via": "dispatch"`). Ties are listed in id
order and `pathCount` counts every equally short chain; `--limit` (default 5)
caps how many are spelled out, with `truncated` set. `--depth` caps the hops
(default 8, max 16). When there is no path, `hops` is `null`, and
`reverseHops` says whether `<to>` reaches `<from>` instead. `--files` asks the
same question of two files over import, use and call edges ("why does A
depend on B"), with `impact`'s rules: a Go import reaches its whole package,
and a call inferred from a name alone is a step only with
`--include-inferred` (otherwise `inferredHops` says one would connect them).

`callers --raw <name>` (MCP `raw: true`) lists every call site of a name before
any binding, with its receiver and enclosing symbol. `callers --with-caller`
(MCP `withCaller: true`) keeps the binding and adds `caller` to each site: the
id of the declaration the call sits in, the node `callgraph` draws that call
from. `callgraph` walks at most 5
hops and says `depthClamped` when asked for more. It also follows dispatch. An
`overrides` edge links a method to the nearest supertype method of the same
name (a Go method to the method of an interface its type implements). A call
binds to the method its receiver's declared type names, so walking out through
`Shape/area` also reaches `Square/area`, and walking in to `Square/area`
reaches the callers of `Shape/area`. `neighbors` reports every edge
kind linking each neighbour — an incoming import and an outgoing inferred call to
the same file are two links, strongest evidence first — and rejects an unknown
`--kind`. `impact` walks imports, uses and calls backwards; a Go import reaches
every non-test file of the package it names, and a call inferred from a name
alone is counted (`inferredDependents`) rather than followed unless
`--include-inferred`. MCP `impact` and `neighbors` answer the same from the
persisted graph (`target`, `depth`, `includeInferred`; `kinds` as an array),
so an agent can ask who depends on a file without pulling the whole `graph`.
File arguments (`complexity`, `outline`, `symbol-at`, `impact`, `neighbors`) may
be written `./path`, absolute or with backslashes; `complexity` exits 2 on a
file the index does not hold. `--limit` caps `complexity`, `risk` and `deadcode`, the last as
`{ total, shown, truncated, candidates }` like MCP `dead_code`.

`complexity` counts branch keywords and operators in code only. Comments,
docstrings and string literals are blanked first, per language, so a docstring
full of "if" and "for" adds nothing. Python, Ruby and Lua `and`/`or` count like
`&&`/`||`. Classes and other containers are not ranked beside functions, and
a nested function counts toward its own score, not its parent's. `risk` uses
the same code-only count per file.

`deadcode` lists exported symbols no call site binds to, in two tiers:
`unreferenced` when no other file of the same language names the symbol, and
`uncalled` when one does (an import, a type position, a base-class list, a
call of the same name that no binding could settle). It also checks the
declaring file outside the declaration. The evidence comes from the AST's
identifiers, call sites, imports and inheritance. When that evidence cannot
see a name (the AST keeps only 5+ character identifiers, and a regex-tier file
keeps none), deadcode reads the other files' text before it claims
`unreferenced`. Only callables are candidates by default: functions, methods,
classes and function-valued consts. `--kinds all` (MCP `kinds: "all"`) adds
types, properties and constants, which are reported only when unreferenced,
since they are never "called". Some symbols are roots and are never
candidates:

- test files, and tail files (examples, docs, fixtures, scripts, Go
  `testdata`) unless `--include-tail` is passed;
- names the language calls itself (Python `__dunder__`, Go `init`/`main`, JS
  `constructor`);
- a method that overrides a live one (called, or public API), since dispatch
  runs it whenever the base method is called. The same goes for the top of an
  override chain in a class whose base lies outside the repo, which the
  framework may call;
- the package's public API. That means what a manifest entry point declares or
  re-exports: package.json `main`/`module`/`exports`/`bin`/`types`, with a
  build path like `dist/index.js` or `scripts/cli.mjs` mapped back to its
  `src/` file, pyproject `[project.scripts]`, a crate's `lib.rs`/`main.rs`, and
  every Python package `__init__.py`. The members and base classes of the
  public classes count too. When no manifest names an entry,
  `index`/`main`/`cli`/`mod`/`lib`/`__main__` basenames stand in.

### How a call binds

`callers`, `callgraph`, graph.json's `call` edges and SCIP references share one
binder, so they agree on every call site. It reads what the site states, with no
type inference:

- **the receiver.** `self.f()`, or a Go method's own receiver variable, reaches
  a member of the enclosing type; `pkg.F()` / `ns.f()` the module that import
  names, and nothing when it lives outside the repo (`errors.New`, `io.Copy`,
  `_json.dumps`); any other `x.f()` never a same-file homonym (`this.map.get(k)`
  is not `Store.get`, `c.ClientIP()` is not a `ClientIP` field), in Go and
  Python only a method, and nothing when the enclosing signature types `x` with
  a package from outside the repo (`t *testing.T`). In Go and Python a bare
  `f()` reaches a function or a type, never a method.
- **what imports rename and barrels re-export**: `import { a as b }`, a default
  import, `import * as ns`, `from m import a as b`, then `export { a } from`,
  `export *` and a Python package's `__init__.py`, up to three hops.
- **visibility.** A Go package is its directory: an unexported helper binds from
  every file of it, a `_test.go` file only from its own package's tests, and
  another package only through an import. JS/TS and Go never bind on a name
  alone; elsewhere a name-only guess (graph.json labels it `inferred`) never
  lands in a test file, nor goes from the product into examples, docs or
  scripts.

`callers --recall` (MCP `recall: true`) adds the name-only matches back — a
unique JS/TS name with no import, a same-file homonym whatever the receiver, a
proximity guess anywhere — and labels each site `corroborated` or `unique-name`.

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

Three things make the output readable rather than a wall of strings:

- **Namespace families.** Path-like values are grouped by their root, so an app
  with forty route literals reports one `/checkout` finding, not forty.
- **Config files are read too.** JSON, YAML and TOML values are extracted
  alongside code, because the duplications that actually hurt are the ones that
  cross a language boundary — a threshold declared in TypeScript and again in a
  rules JSON, a route called from a Kubernetes manifest. Nothing else compares
  those pairs.
- **Only fixed values count.** A template with an interpolation (`${id}`,
  `f"{id}"`, `#{id}`) is not a value another file could restate, and a string
  standing alone as a statement — a Python docstring, a `"use client"`
  directive — is documentation or a pragma. Wherever a grammar parsed the file,
  neither is collected (the regex fallback reads lines, not syntax).
- **Repetition with no possible owner is left out.** A value seen only across
  GitHub Actions workflows (`ubuntu-latest`, `actions/checkout@v4`), or only
  across one kind of package manifest that cannot inherit (`pyproject.toml`,
  `package.json`, `composer.json`, `go.mod` in each example project), names no
  fix. The same value in CI *and* in `pyproject.toml` is still reported. In Go,
  one constant name declared in two files of a package is read as build-tag
  variants of one holder (`binding.go` / `binding_nomsgpack.go`), not as two
  competing ones.

```sh
codeindex literals --repo . --min-files 3 --min-count 5   # tighten the floors
codeindex literals --repo . --include-tests               # count test files too
```

As a CI gate, via the `literals` builtin rule (defaults to the two actionable
tiers; `tiers` narrows it, and `minFiles`/`minCount`/`includeTests` take the
command's thresholds). The rule computes the whole list, so it fails on exactly
what `codeindex literals` reports, not only on the 24-entry headline that
`graph.json` carries:

```json
[{ "name": "no-uncentralized-routes", "builtin": "literals", "tiers": ["competing"] }]
```

```sh
codeindex rules --repo . --config codeindex.rules.json    # exit 1 on violations
```

A rules config is validated strictly, because a gate that silently checks
nothing is worse than none. A key the rule does not read (`sevrity`), an unknown
tier, or an edge kind the graph does not emit fails with exit 2 and names the
file. A forbidden-edge rule whose `from` or `to` globs match no indexed file
can never fire, so it is reported as an `unmatched` warning. Over MCP,
`check_rules` reads a `configPath` only when it resolves inside the repository.

The `orphans` builtin lists code files nothing connects to. It leaves out tests,
entrypoint-looking names (`index`, `main`, `cli`, `wsgi`, …), languages that no
import, call or use edge in the repository reaches (SQL, shell scripts), and,
in Go, Java, Kotlin and Scala, files whose package is connected: files in one
directory see each other without imports, so an unexported helper called from
a sibling file has no edge of its own.

An arrow function returning a value (`export const getPath = () => "/a/b"`) is
a *consumer*, not a source of truth, and is reported as a call site. A lookup
table (`export const ROUTES = { … }`) genuinely is one, and is reported as a
holder.

## Monorepos and import resolution

`codeindex workspaces` lists the packages of a monorepo with their declared
dependency graph, one cycle if there is one, and a topological build order. It
reads npm/yarn `workspaces`, `pnpm-workspace.yaml` (block or flow list), lerna,
nx, Cargo `[workspace]`, `go.work` (without one, every nested `go.mod` outside
`vendor`, `testdata` and `fixtures` dirs), Maven `<modules>` (recursing into
nested aggregators), uv workspaces, Composer path repositories and Gradle
`include` (multi-line forms too; `project(':x')` and `projects.x` type-safe
accessors become edges). Manifests are read as JSONC, like the resolver reads
them; one that still does not parse is named in `warnings` instead of being
dropped silently.

`--check` compares what each package declares with what its code imports,
using the link-graph's resolved import edges:

- `undeclared` — a package imports a sibling its manifest does not list. It
  works in a hoisted checkout and breaks the isolated install, the publish or
  `go mod tidy`. Any entry makes the command exit 1, a CI gate like `rules`.
  Nx members are skipped: Nx infers project dependencies from imports.
- `unusedDeclared` — a declared sibling no import uses (npm, pnpm, lerna,
  Cargo and Go only; informational, never fails the check).

`codeindex resolution` says whether the graph can be trusted for a language
before you rely on `impact`, `callers` or `deadcode` there. Per importer
language it counts imports that `resolved` to an in-repo file, went `external`
(third-party or stdlib, by design no edge), `dangling` (a local target that
does not exist, by reason) and `unsupported` (no resolver for that language),
lists the top dangling specifiers with an example importer and the top
external packages (`--limit`, default 10; `--lang` for one language), notes a
language that yields no import edges at all, and repeats the config `warnings`
(an unparseable `tsconfig.json` or `package.json`, a missing `extends` base)
that silently turn resolvable imports external. `index` prints those warnings
to stderr too. Nothing here changes an artifact.

`codeindex mermaid [target]` focuses the diagram on a module slug, a module
directory or a file (its module), and fails on anything else rather than
printing an empty diagram.

## SCIP export

`codeindex scip` writes a [SCIP](https://github.com/sourcegraph/scip) index.
Symbols are global: the package the file's nearest manifest names (npm
`package.json`, `go.mod`, Cargo, `pyproject.toml`, Maven, Composer; `. . .`
when there is none), one namespace per file, then the declaration chain with
the suffix each kind calls for:

```text
codeindex python flask 3.1.0 `src/app.py`/create_app().index().     a function nested in a function
codeindex python flask 3.1.0 `src/app.py`/create_app().Task#run().  a method of a class nested in one
codeindex gomod example.com/svc . `context.go`/Context#BindWith().  a Go method declared in deprecated.go
codeindex npm @acme/web 1.2.3 `shapes.ts`/Geo/area().               a function in a namespace
codeindex npm @acme/web 1.2.3 `shapes.ts`/over(16).                 a repeated overload, told apart by its line
```

Every symbol kind maps to its SCIP `Kind` (property, field, enum member,
constructor, getter, macro, namespace, package, …), and a Go method declared
in another file of its package hangs off the type it belongs to. A re-export
(`export { X } from`, `from .app import X as X`) is a reference to the
declaration it forwards, not a second definition; `export * from` names nothing
and emits nothing. A member whose owner is not in the index (a type from
another crate) keeps a `Owner#` descriptor under its own file.

The inheritance `hierarchy` resolves becomes `relationships`: a subtype is an
implementation of each type it extends or implements, so "Find
implementations" on a base lists its subclasses, and a method overriding a
same-named supertype method is an implementation and a reference of it, so
"Find references" on the contract's method reaches the overrides.

Every occurrence and relationship names a symbol the index defines, and
`scip lint` finds nothing else to report, with one caveat that is upstream's:
its relationship pass only knows the documents it has already visited, in Go
map order, so a relationship to a symbol of another document is reported as
missing at random.
## What git history says

Four commands read the commit history rather than the code: `churn` (commits
per file), `hotspots` (churn × size: where work and defects concentrate),
`risk` (churn × complexity) and `coupling` (files that change together).

```sh
codeindex hotspots --repo . --since "6 months ago" --limit 10
codeindex coupling --repo . --hidden        # co-change that no import explains
codeindex churn    --repo packages/api      # one package of a monorepo
```

- **Paths are relative to `--repo`**, which may be any directory inside the git
  repository: point it at one package of a monorepo and history is limited to
  that package, keyed the way its index is.
- **`--since` takes a ref or a date**: a tag, branch or sha (commits after it),
  or `2024-01-01` / `"6 months ago"`. Anything else is an error (exit 2), never
  an empty window that reads as "nothing changed".
- **Every answer says what it could read.** Outside a repository, or before the
  first commit, `ok`/`churnOk` is `false` and `error` says why. A **shallow
  clone** answers with `shallow: true`: counts are lower bounds, and the clone's
  boundary commit is left out, because git compares it with an empty tree and
  it would count as a change to every file (a depth-1 CI checkout therefore has
  no visible history at all).
- **`hotspots` ranks only files that changed** in the window and labels test
  files `test: true`.
- **`coupling` works over the index**: pairs are limited to indexed files, so
  deleted paths drop out and `--scope`/`--include`/`--exclude` apply. Each pair
  says whether a graph edge (import, call, use, inheritance, doc link) already
  `linked` the two files; `--hidden` keeps only the pairs with no such edge.
  Pairs whose names already declare them (same directory, same name up to the
  first dot: `x.po`/`x.mo`, `x.js`/`x.min.js`, `x.ts`/`x.test.ts`) are left
  out. Pairs are ranked by `confidence`, the lower bound of the 95% Wilson
  interval for `strength`: 12 shared commits out of 13 rank above a thinly
  evidenced 3 out of 3. `--min-together` (default 3) and `--max-commit-files`
  (default 30) tune the mining. The second one skips mass-refactor commits by
  their whole size, including files outside `--repo`.
- **Renames are not followed.** Rename detection is the expensive part of
  `git log`, and on a blobless partial clone it downloads blobs. A file's
  history before a rename stays under its old path.
- The output does not depend on the user's git config (colour, diff prefixes,
  signature display, external diff drivers). One `git log` pass is shared by
  all four commands and reused while HEAD stays the same, so an MCP session
  asking for `onboard`, `hotspots` and `risk` reads the history once.

## Reviewing a diff

`codeindex delta` maps the git diff onto the graph: changed files, the symbols
enclosing each hunk, the blast radius, and a risk score per module in which
every point comes with the reason that fired it.

```sh
codeindex delta --repo .                  # the branch vs its merge-base with the default branch
codeindex delta --repo . --staged --json  # the staged changeset, as JSON
codeindex delta --repo . --fail-on HIGH   # CI gate: exit 1 when a module scores HIGH
```

The MCP `delta` tool answers the same question for an agent that has just
edited files: `{base?, staged?, depth?}` return the JSON result, `concise`
drops the hunks and reduces each enclosing symbol to `name/kind/line`, `limit`
keeps the highest-scoring modules (and says it truncated), and
`format: "text"` returns the panel. It is in the `impact` and `risk` profiles.

- **A removed file that is still imported is the highest-weighted signal**
  (`brokenImport`, 40). The worktree's graph no longer holds a deleted or
  renamed file, so delta puts the removed paths back and re-resolves the
  graph's dangling imports: the ones that land on a removed path are listed
  under `broken` with their importer (and `renamedTo` for a move), the module
  the file was removed from is scored even when nothing else in it changed,
  and the importers count as its direct dependents.
- **The engine's own output is not part of a review.** Paths under the index
  directory (`--index`, default `.codeindex`) are dropped from the diff, and so
  are untracked files in directories the walker never indexes (`node_modules/`,
  `dist/`, …). A tracked change in such a directory stays listed as
  `unindexed`.
- **Before the first commit** there is no merge-base: every file (staged,
  with `--staged`) is reviewed as added, against the empty tree.
- **The diff is read before the index.** A clean worktree answers
  `no changes` without loading or walking anything (0.4 s instead of 15 s on a
  66k-file repository), and symbol attribution reads only the changed files'
  definitions.

## Docker

`ghcr.io/maxgfr/codeindex` ships the same zero-dependency bundle (`engine.mjs`
+ `cli.mjs` + the AST grammars), Node and Git, with no `npm install`. Git
supports revision metadata and the `churn`, `coupling` and `delta` commands.
Multi-arch (`linux/amd64`, `linux/arm64`),
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

The image runs as `node` and trusts `/work` as a Git safe directory so a host
mount with a different owner remains usable. To test local engine and embedding
builds, including offline semantic search:

```sh
docker build -t codeindex:qa .
docker build -t codeindex-embed:qa docker/embed
node scripts/test-docker.mjs codeindex:qa codeindex-embed:qa
```

The [engine validation report](docs/engine-validation-2026-09-07.md) records the
tested architecture and runtime checks.

## Text search (`grep`)

`codeindex grep '<regex>' --repo .` returns JSON hits sorted by file then line:
`{file, line, col, text}`. It uses ripgrep when it is on `PATH` and a pure-JS
scan otherwise, and both give the same answer:

- **One dialect.** The pattern is a JavaScript regular expression on both
  backends. Before it reaches ripgrep it is translated so that `\w`, `\b` and
  `\d` stay ASCII and `.` still stops at `\r`, as they do in JavaScript.
  Anything that cannot be translated exactly (lookaround, backreferences) runs
  on the JS engine instead, and a note on stderr says so. Syntax that
  JavaScript would read as a literal but you probably meant as an operator
  (`\A`, `\z`, `[[:alpha:]]`, `\x{41}`) is rejected with an explanation.
- **One file universe.** grep searches the files every other command indexes.
  `--ignore-dir`, `--no-gitignore` and `--max-bytes` apply to it too. `--scope`
  (a directory or a single file) is ANDed with `--include`/`--exclude`. Globs
  are rooted at the repo: `*.ts` matches root-level files only, `**/*.ts`
  matches at any depth.
- **Bounded output.** Results stop at `--max-hits` (default 200). When the cap
  cuts the list, stderr says so and gives the number of matching files. A line
  longer than 300 characters comes back as a window around the match, and
  `col` gives the match's position in the full line.
- **Bounded time.** ripgrep's regex engine runs in linear time. JavaScript's
  can backtrack exponentially (`(a+)+b`), so the JS scan runs in a worker thread
  with a time limit (`--timeout-ms`, default 10000). When the limit is reached,
  the hits from the files already scanned are returned, together with a note
  naming the file where the scan stopped.

The MCP `grep` tool returns the bare hit array by default. With
`withMeta: true` it returns `{ hits, truncated, filesMatched, notes? }`. A
result cut short by the time limit always comes back in that form, with
`timedOut: true`.

## Search

`codeindex search "<query>" --repo .` ranks files with keyless **BM25F** over six
weighted fields: symbol names, path segments, doc headings (markdown and
reStructuredText), the file
summary, per-symbol **doc comments**, and the **prose body** (words from comments
and short string literals, a template's fixed text included, captured at
extraction time so they ride the incremental cache). An all-lowercase compound
file name (`tsconfigparsing.go`, `knownsymlinks.go`) is also indexed as the
words it is made of, when the repo uses those words as names, so "parse
tsconfig json" reaches it.

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
test file ranks below the code it tests unless the query asks for tests; fixture
and snapshot trees (`testdata/`, `fixtures/`, `__snapshots__/`) rank lower
still, unless the query says `fixture` or `testdata`. A
barrel's re-exports (`export { x } from`, Python's `from .x import y as y`) are
indexed as prose rather than as names, so the module that defines a name ranks
above the `__init__.py` or `index.ts` that re-exports it. English
stopwords are dropped from a sentence, but not from a name: a query that is only
a stopword (`default`), or a capitalised stopword the repo declares as a symbol
(`Use middleware`, `Context.Set` — gin's `Use` and `Set`), is searched as the
name it is. A query term that
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

`--rank graph` (MCP `rank: "graph"`) multiplies each score by the file's
PageRank over the resolved import graph, relative to an average file: a leaf is
×0.95, a file with ten times the average PageRank ×1.16. Go files are left
alone, because a Go import resolves to the package's alphabetically first file.
It is opt-in because it does not win: on flask it lifts MRR from 0.807 to 0.824,
on a second flask query set it drops it from 0.851 to 0.816, and gin,
microsoft/TypeScript and the judged corpus do not move.

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
| `droppedStopwords` | why an all-stopword query returned an empty array (a stopword searched as a name is not listed) |
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
is present, and `search --semantic` reads it back instead of re-encoding the
corpus: a stored vector is reused only for the same unit text under the same
model and `EMBED_VERSION`, so after an edit only the changed units are encoded,
and a stale, foreign or corrupt file costs a re-encode, never a wrong ranking
(microsoft/TypeScript, 244k units: 12.1 s to encode, 2.3 s to read and reuse).
`index` and `embed build` reuse the previous file the same way and write the
bytes a fresh build would. Fusion reuses the engine's `rrf` helper (k=60);
`SCHEMA_VERSION` is untouched (a dedicated `EMBED_VERSION` keys the sidecar).

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
offset 8            UTF-8 JSON  { embedVersion, modelId, dim, count, records:[{file,symbol,line,hash}] }
offset 8+headerLen  int8 body   count × dim signed bytes, row-major
```

No absolute path and no timestamp; records follow scan order, so two builds of
an unchanged repo are byte-identical. `hash` is 64 bits of the sha1 of the text
the record encodes — what makes a vector reusable. `EMBED_VERSION` + `modelId` +
`dim` invalidate a stale or foreign artifact. Granularity is per-symbol (name +
signature + doc comment + file summary + path segments), with a per-file
fallback for symbol-less files so every file with content is represented.
Re-exports get no unit of their own: the defining file already has one, and a
barrel of nothing but re-exports falls back to its file-level unit. With the
doc comment in the unit, the fused ranking beats plain BM25 on every set we
measured with the official model (MRR: flask 0.8307 vs 0.8232, gin 0.7862 vs
0.7642, the judged corpus 0.9583 vs 0.9375).

**Fusion is by RANK, never a score blend**: BM25 scores and integer dot products
live on incomparable scales, so `searchSemantic` uses the shared `rrf` helper
(k=60) and adds `semanticSymbol` — the corpus symbol whose embedding was closest
for that file, when that similarity is positive — additively to the lexical
result. A file the lexical side
ranked keeps every lexical field (`matchedFields`, `line`, `symbolHits`,
`fuzzyTerms`, `bridgedOnly`); a file only the embedding side found has an empty
`matchedTerms` and the `line` of its closest symbol. `--exact` and `--rank`
apply to the lexical side, so `--exact` keeps bridged-only rows out of the fused
list too. `--explain` (MCP: `explain: true`) reports the verdict for the rows
actually returned, from the same scoring pass: an answer carried by embedding
neighbours alone is `weak`, never "No file matches", and
`semanticOnlyResults` counts those rows.

To implement your own server, `CODEINDEX_EMBED_ENDPOINT` is the **base URL** and
the client derives two routes:

| method + path | request | response |
|---|---|---|
| `POST {base}/embed` | `{ "texts": ["…", …] }` | `{ "vectors": [[…float…], …] }` — same order, one row per text |
| `GET {base}/healthz` | — | `200` (any body) when ready |

Any dimension is accepted and vectors need not be pre-normalized — the engine
L2-normalizes and int8-quantizes whatever it receives, through the *same* tail
as the static tier, so ranking stays a pure integer dot product. Requests time
out after `CODEINDEX_EMBED_TIMEOUT_MS` (default 30 000); a corpus goes out in
batches of 64, four in flight. Endpoint corpus vectors are **never written to
`embeddings.bin`**: that tier is deterministic per image digest, not
byte-golden, so pin the digest. When the repo has an index (`index` wrote
`.codeindex/cache.json`), `search --semantic` keeps them in
`.codeindex/embed-cache/endpoint-<url hash>.bin`, keyed by the unit text and by
a fingerprint of the model (the vector of one fixed text, fetched each run), so
the next search sends only new texts and a different model behind the same URL
starts over. Without an index, nothing is written into the repo. The MCP server
does the same in memory: after an edit it re-sends only the changed units. The reference server is
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
| `model.json` present but broken (bad JSON or shape) | lexical + a stderr note naming the file; `embed status` reports `model: { present: true, error }`, `index` skips only `embeddings.bin` |
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
    "args": ["--stdio"],
    "initializationOptions": { "tsserver": { "useSyntaxServer": "never" } }
  }]
}
```

```sh
codeindex lsp status --repo .           # config, PATH resolution, files claimed
codeindex lsp status --repo . --probe   # also start each server, read its real capabilities
```

Each server may set `timeoutMs` (per request, default 5000) and
`startupTimeoutMs` (the `initialize` handshake, default 15000). The environment
variables `CODEINDEX_LSP_TIMEOUT_MS` and `CODEINDEX_LSP_STARTUP_TIMEOUT_MS`
override both for every server and take precedence over `lsp.json`, so a CI
job or a slow machine can retune them without editing a shared file.
`CODEINDEX_LSP_CONFIG` points at a config elsewhere; set to `off`, `0` or an
empty string, it disables the tier even when the repository has one.

The TypeScript example disables its separate syntax server because codeindex
opens short-lived query sessions. Otherwise an early reference request can be
answered before the semantic project is ready and return only the declaration.
Other servers use their own initialization options; codeindex does not infer a
server configuration from its binary name.

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
static tier and server disagree, while `staticOnly` can indicate a homonym or
an incomplete language-server answer. These are investigation leads, not proof
that either tier is wrong.
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
  reason for unavailable configured servers. For compatibility, references
  without any configuration retain their original static-only shape; the new
  callers option explicitly reports missing configuration.

### Type-aware callers

`callers` accepts `lsp: true` in MCP, with a required `name`, or a symbol
positional in the CLI:

```sh
codeindex callers greet --repo .
codeindex callers greet@src/greet.ts --repo . --lsp
```

The normal `def` and `callers` stay present. An additive `lsp` block contains
`server`, `ok`, optional `reason`, `calls` and `agreement`. Each call records its
call-site `file`, 1-based `line`, 0-based UTF-16 `character`, and the enclosing
`caller` location/name/LSP kind. Agreement compares call-site files, excluding
declaration-only files. `lsp status --probe` reports `callHierarchy`; servers
without it return the static answer and an explanation. A known declaration
can have LSP callers even when no static callers were tracked: the existing
static `error` notice then remains beside the successful `lsp` block.

Both references and callers route each declaration to its configured language
server, so a TypeScript/Python homonym does not send Python source to the
TypeScript server. Calls require `prepareCallHierarchy` and `incomingCalls`;
reference occurrences alone are not classified as calls. Missing configuration,
unsupported capabilities, process/pipe failures and timeouts keep the static
answer. Results already received survive a later failure with `ok: false`.

## Use as an MCP server

`codeindex mcp` (or `node scripts/cli.mjs mcp`) serves the engine over stdio.
Register it in Claude Code with:

```sh
claude mcp add codeindex -- codeindex mcp
```

**40 tools**, grouped by what they answer:

| group | tools |
|---|---|
| orient | `scan_summary`, `index_status`, `onboard` *(write)*, `repo_map`, `graph`, `mermaid`, `workspaces` |
| find | `search`, `explain_search`, `grep`, `find_symbol`, `symbols`, `symbols_overview`, `symbol_at` |
| impact | `find_references`, `callers`, `call_graph`, `call_path`, `impact`, `neighbors`, `dead_code`, `resolution_report`, `delta` |
| types | `type_hierarchy`, `implementations` |
| risk | `hotspots`, `churn`, `coupling`, `complexity`, `check_rules`, `duplicated_literals` |
| edit *(write)* | `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol` |
| memory | `write_memory`, `read_memory`, `list_memories`, `delete_memory` *(write except reads)* |
| tiers | `embed_status`, `lsp_status` |

`onboard` is the one that saves the most round trips: it composes
`scan_summary` + `workspaces` + `repo_map` + `hotspots` into one project brief
and persists it as the `onboarding` memory, so the second session reads instead
of rebuilding.

Arguments are checked against each tool's schema before anything is walked or
scanned: types, required arguments and enums (`call_graph`'s `direction`,
`search`'s `rank`). A mistake comes back at once as a tool error that names the
argument, never as a default applied in silence. `file` arguments accept
`./src/a.ts`, an absolute path inside the repository or `src\a.ts`. A file the
index does not hold is an error suggesting indexed files with the same name,
not an empty answer.
`repo_map` (and the brief's key-files section) ranks files by PageRank over the
edges production code creates, so a test harness that thousands of tests
import does not outrank the code it tests, and it leaves test files out. In each
file it shows the public types and functions first, then their methods, then
values, and counts what did not fit (`… 43 more`).

### Smaller read responses

MCP `find_symbol`, `find_references`, `callers`, `symbols_overview` and `symbols`
accept `concise: true` (and `delta`, where it drops each change's hunks).
Declarations are reduced to `name/kind/file/line`, plus
`parent` for a member so its `Parent/name` path stays formable, while
result membership, order, reference groups, call-site locations, confidence
labels and LSP metadata stay intact. Defaults retain their full existing shape.
`symbols` keeps its name-keyed groups and references for full-index requests.
The option is a query projection; it never changes persisted artifacts.

Symbolic edits preserve supported source encodings (UTF-8/BOM, UTF-16 LE/BE,
Latin-1) and line endings. Malformed UTF-16 and replacements that cannot be
represented in a Latin-1 source fail before writing. Memory notes stay under
`.codeindex/memories`; linked storage paths are refused rather than followed.

### Advertising fewer tools

Every advertised tool's full JSON Schema sits in an agent's context on **every
turn**, so a session that only ever searches is paying for the graph analytics
all day. `--tools` advertises a named subset:

```sh
codeindex mcp --tools find          # search, explain_search, grep, find_symbol, symbols, symbols_overview, symbol_at, embed_status
codeindex mcp --tools orient,impact # compose profiles with a comma
```

Profiles are `all` (the default), `orient`, `find`, `impact`, `edit`, `risk`
and `memory` (all four memory tools). Every tool belongs to at least one.
The MCP initialization response names the available profiles and active selection
in its `instructions`, so a client can discover this configuration in-session.
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
Add `--watch` to a pinned server to stop paying a whole-tree walk on every
call. On Linux the server watches each directory the scan walks, one inotify
watch per directory and never an ignored tree (`node_modules`, `.git`, build
outputs, gitignored paths…), up to 8192 directories. Before a call it waits
until every earlier filesystem event has been delivered (a barrier file in a
private temp directory). When no watched directory changed since the last walk,
the call reuses that walk and the scan behind it without a single stat: a warm
`find_symbol` on the 66k-file TypeScript repo drops from about 2.3 s to under
15 ms. Any change, including a deletion, a new directory or a `.gitignore`
edit, makes the call walk and re-check exactly as without `--watch`, so answers
never lag behind the disk. Git commit metadata is refreshed on every call. When
the watcher cannot prove freshness (too many directories, the inotify budget
exhausted, a barrier that never arrives), the server warns where relevant and
each call walks as usual. On macOS and Windows the native recursive watcher only
invalidates changed files eagerly, and every call still walks.

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
the 34 read tools, `destructiveHint`/`idempotentHint` on the six that write —
which is what lets a host auto-approve reads and confirm only writes. From
`2025-06-18`, the 26 tools whose result is always a JSON object also declare an
`outputSchema` and return `structuredContent`, so a client can validate and type
the result instead of re-parsing a string. The remaining tools return arrays,
argument-dependent shapes or plain text, which cannot yield a conforming
structured result without diverging from the text block — they are left
unschema'd rather than described inaccurately. Every schema is rooted at
`type: "object"`, as the official TypeScript SDK requires to list tools at all.
A lookup miss (`call_graph`, `type_hierarchy` or `implementations` naming
nothing in the repo) keeps its `{ "error": ... }` text but is flagged
`isError`, so a client validating against the schema reads it as the tool
error it is.

Responses are capped (`--max-response-bytes`, default 1 MB). Under the cap
nothing changes. Over it — where a whole-repo `graph` on a large monorepo runs
to millions of tokens and no client can accept it — the response is replaced by
a short notice naming the size, the arguments of that tool that narrow it, and
the persisted artifact when one on disk holds exactly the withheld answer
(checked byte for byte; a stale one gets the command that refreshes it). The
notice is sent as a tool error (`isError: true`): the model reads it and
narrows the call, and a client that validates `structuredContent` is not
handed a result that cannot conform. Most tools also take a
`limit`/`maxResults`/`top`/`maxEdges` argument to stay well under it.

Tool calls run one at a time, in arrival order, so answers stay deterministic;
`ping`, `initialize`, `tools/list` and argument errors are answered at once,
even behind a long first scan. `notifications/cancelled` is honoured: a queued
call is skipped, and a running one finishes (an edit is never left half-done)
but gets no response. A call that carries a `progressToken` receives
`notifications/progress` when its walk and its scan complete, which keeps an
SDK client's request timeout from firing during a long first scan.

`engine.mjs` is a pure side-effect-free library (safe for consumers to inline
into their own CLIs); `cli.mjs` is the thin standalone CLI/MCP wrapper.

## Command rewriting

`codeindex rewrite '<command line>'` maps an expensive tree-wide search onto
its indexed equivalent, for agent harnesses that intercept shell commands
(iterion's `rewriters` plugin kind, generalizing rtk):

```sh
$ codeindex rewrite 'grep -rn TODO src'
codeindex grep TODO --scope src --ignore-dir .codeindex
$ codeindex rewrite "rg -tpy -w 'def main'"
codeindex grep '\bdef main\b' --include '**/*.py' --include '**/*.pyi' --ignore-dir .codeindex
```

It prints the replacement and exits `0`. When it has no opinion, it exits `1`
with empty stdout, and the host should run the original command. It
understands recursive `grep`/`egrep`, `rg` and `git grep`:

- **The pattern.** POSIX BRE and ERE and Rust regex syntax, plus `-F`, `-w`
  and `-i`/`-S`, are restated as the JavaScript regex `codeindex grep` runs.
  In a BRE, `x+y` stays a literal `+`.
- **The files.** A path becomes `--scope` (`./` stripped, a file allowed). An
  `--include`/`-g` base-name glob becomes `**/<glob>`, and `-t` becomes the
  globs of that ripgrep type. `--ignore-dir .codeindex` turns off the default
  vendor/build/out/tmp skips, which none of these tools make. Gitignored files,
  lockfiles and binaries are still left out, on purpose.
- **The flags.** `-l` becomes `--files-with-matches`, and a pattern that starts
  with `-` goes behind `--`.

The parser is deliberately conservative. The rewrite is refused when the line
contains shell syntax outside single quotes (pipe, redirect, substitution,
chaining, braces, an unquoted glob in a path), an unrecognized or
output-changing flag (`rg -r` is `--replace`), a non-recursive `grep`, a path
outside the tree, more than one path, include/exclude rules whose order
matters, or regex syntax that cannot be translated exactly. A refusal costs
nothing, while a wrong rewrite would silently change what the agent asked for.
The test suite runs each supported form through the real tool and through its
rewrite, and checks that both find the same lines.

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
| MCP server | **40 tools**, subsettable by profile | none | yes, LSP-backed | yes | **codeindex** |
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
