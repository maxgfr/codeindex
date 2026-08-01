# Running the engine in a browser

`@maxgfr/codeindex/browser` is the same engine as `@maxgfr/codeindex`, resolved
against browser shims instead of node builtins. Same barrel, same extraction,
same link-graph, same renderers — and the same artifacts: indexing a tree
through the browser build produces `graph.json` and `symbols.json` **byte-identical**
to what the Node build produces from the same bytes on disk. That equivalence is
asserted in CI (`tests/browser-build.test.ts`) across three fixtures, with the
tree-sitter grammars asserted loaded so the comparison cannot pass vacuously.

A working example is [the playground](https://maxgfr.github.io/codeindex/playground/)
— source in [`site/playground/`](../site/playground/).

```
npm i @maxgfr/codeindex
```

```ts
import { mountFiles, loadGrammars, buildIndexArtifacts, searchIndex, renderGraphJson } from "@maxgfr/codeindex/browser";
```

There is no `browser` export condition on the main entry point, so a bundler
will never swap the Node build for this one behind your back. Ask for
`/browser` explicitly — the two are not interchangeable, because this one
indexes a filesystem you supply rather than one that exists.

## What differs from the Node build

| | |
|---|---|
| **Filesystem** | An in-memory VFS you populate. `walk`, `readText` and `scanRepo` read from it exactly as they read from disk under Node. |
| **Grammars** | Fetched through your transport instead of read from `scripts/grammars/`. You serve the `.wasm`; the engine never guesses a URL. |
| **git** | Absent. `headCommit` returns `undefined`, so `graph.json` carries no `commit`, and `churn` / `coupling` / `risk` / `delta` / `hotspots` have nothing to work with. This is the engine's existing degradation path, not a browser-specific branch. |
| **ripgrep** | Absent, so `grepRepo` uses its pure-JS backend. Identical result shape. |
| **Workers** | `scanRepoParallel` runs sequentially. Byte-identical output — parallelism was never allowed to change it. |
| **Embeddings** | `searchIndex` (BM25) works. `searchSemantic` needs a model you would have to host and load yourself. |

Everything else — extraction, import resolution, the graph, centrality,
communities, the test map, SCIP, the repo map, every search mode — runs
unmodified.

## Getting a tree in front of the engine

The VFS is mounted in two phases, and the split is the point rather than an
implementation detail.

**Phase A — mount paths and sizes, with no contents.** Sizes alone satisfy
`lstatSync`, which is all `walk()` needs. So the real walk runs *before* you
have fetched anything, and its keep-list is your download list: gitignore
chains, `IGNORE_DIRS`, `LOCKFILES`, `BINARY_EXT` and the 1 MiB per-file cap all
apply, and you never pay for a file the engine was going to discard anyway.

**Phase B — attach the bytes of what it kept**, then `pruneUnfetched()` to drop
everything still without contents, so nothing enters the index as a phantom
empty file.

```ts
import {
  resetVfs, mountFiles, setFileBytes, pruneUnfetched,
  loadGrammars, walk, buildIndexArtifacts, searchIndex,
} from "@maxgfr/codeindex/browser";

const ROOT = "/repo";

resetVfs();

// Phase A: the whole tree, sizes only. `manifest` is whatever you can enumerate
// cheaply — a git tree listing, a directory handle, a zip's central directory.
mountFiles(manifest.map((entry) => ({ path: `${ROOT}/${entry.path}`, size: entry.size })));

// walk() applies .gitignore, so give it the real bytes of those (they are tiny).
for (const path of gitignorePaths) {
  setFileBytes(`${ROOT}/${path}`, await readBytes(path));
}

// The engine decides what is worth reading.
const planned = walk(ROOT, { maxFiles: 5000 });
if (planned.capped) console.warn("hit the cap you asked for — the index is partial");

// Phase B: only these.
for (const file of planned.files) {
  setFileBytes(file.abs, await readBytes(file.rel));
}
pruneUnfetched();

// Load only the grammars these extensions need: a Go repo pays 217 KB and never
// touches the 5.4 MB C# grammar.
const grammars = await loadGrammars(
  new Set(planned.files.map((file) => file.ext)),
  (name) => fetch(`/grammars/${name}`).then((response) => response.arrayBuffer()).then((buffer) => new Uint8Array(buffer)),
);
if (grammars.tier !== "ast") console.warn(`regex tier: ${grammars.note}`);

const { scan, graph, symbols } = buildIndexArtifacts(ROOT);
const hits = searchIndex(scan, "http client retry");
```

If you already hold every file's contents — a directory the user picked, an
unpacked archive — mount them in one pass with `bytes` set and skip phase A's
staging entirely. The two phases matter when *fetching is the expensive part*.

### Serving the grammars

`loadGrammars` calls your `fetchWasm(name)` with bare filenames —
`web-tree-sitter.wasm` first, then `typescript.wasm`, `go.wasm` and so on. Copy
`node_modules/@maxgfr/codeindex/scripts/grammars/` into whatever your app serves
as static assets and point `fetchWasm` at it. They must be served as
`application/wasm`.

They are also worth caching: the set is immutable per release, so a `Cache`
entry keyed by URL never needs invalidating.

Skip this entirely and every language falls back to the regex tier (16
languages, still fully searchable, just without AST-exact symbols). That is a
real option for a small bundle — but `loadGrammars` returns the tier it
achieved, so say which one you got rather than implying the better one.

## API added by this build

Everything from the main barrel, plus:

| | |
|---|---|
| `resetVfs()` | Empty the VFS. Call between trees so one cannot leak into the next. |
| `mountFiles(files)` | Mount `{ path, size, bytes? }` entries. Omit `bytes` for phase A. |
| `setFileBytes(path, bytes)` | Attach contents to a mounted path (or add a new file). |
| `hasFileBytes(path)` | Whether a file's contents are resident. |
| `pruneUnfetched()` | Drop every file still without contents; returns how many. |
| `residentBytes()` | Total bytes held, for reporting a memory footprint. |
| `loadGrammars(exts, fetchWasm)` | Fetch and mount the minimal grammar set; returns the achieved tier. |
| `mountRuntime(bytes)` / `mountGrammar(key, bytes)` | Lower-level mounts, if you drive loading yourself. Mount *before* `ensureGrammars`, which reads them synchronously. |
| `grammarWasmName(key)`, `RUNTIME_WASM` | Filenames, for assembling your own URLs. |

`runCli` and `runMcpServer` are exported for signature compatibility and throw
if called: both are Node-only end to end.

## Sizing

The bundle is ~325 KB minified (~90 KB gzipped). Grammars are separate and
lazy: `go` 217 KB, `javascript` 412 KB, `python` 458 KB, `typescript` 1.4 MB,
plus the 201 KB tree-sitter runtime.

Run it in a Web Worker. Extraction is synchronous and CPU-bound by design —
that is what keeps rebuilds byte-identical — so on the main thread it blocks
the page.

Memory is roughly the source you mounted plus the index over it; the playground
caps itself at ~1 500 files / 12 MB of source, which lands around 150–300 MB in
the worker.
