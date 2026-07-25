# codeindex — competitor benchmarks

Reproducible harness (`scripts/bench/`) comparing codeindex against universal-ctags, Serena (LSP over MCP) and Graphify. Timings are the median of 5 runs with one warmup discarded; a cell reading `n/a (reason)` means that tool was not measurable in this session.

## Methodology & fairness

The tools compared here are architecturally different, not just differently
tuned, so every comparison below is between specific *operations*, never a
vague "codeindex vs tool X":

- **Two query modes for codeindex, on purpose.** `find-symbol in-proc` /
  `references in-proc` / `caller-index in-proc` time a single API call
  against an already-loaded warm scan — the number a long-running host
  process (MCP server, editor plugin) actually pays per query. `full-index
  spawn` times a full `codeindex symbols` CLI invocation: Node startup, a
  cold `buildIndexArtifacts`, and serialization of the *entire* symbol table —
  it is **not** a single-symbol lookup and must never be read as one. It is
  included so a one-shot CLI caller can see that cost too.
- **ctags is faster on cold, flat tags only.** universal-ctags emits a flat
  `tags` file with `-R` and, on a cold build of a small repo, beats
  codeindex's richer graph+symbol artifacts. That is an honest win for the
  simpler data model, not a like-for-like result: ctags produces no call
  graph, no references, and no MCP-servable structure — see the Queries and
  Cold index tables for both sides of that trade.

### MCP servers (Serena, Graphify): task equivalence

The two MCP competitors answer the same three tasks — find-symbol,
references, file-overview — but not with the same machinery, so the mapping
is pinned here and must be read alongside the MCP sessions / MCP token
economy tables:

- **Same transport, same client, for everyone.** All three servers (codeindex
  included) are driven over the same newline-delimited JSON-RPC 2.0 stdio
  transport by the same client (`scripts/bench/mcp-client.mjs`), one tool
  call per session — graphify's server drops still-queued responses at stdin
  EOF, so the one-call-per-session policy is applied to all servers for
  symmetry.
- **Task equivalence, pinned.** find-symbol = serena `find_symbol` /
  graphify `get_node` / codeindex `find_symbol`. references = serena
  `find_referencing_symbols` / graphify `get_neighbors` (incoming
  calls/imports edges) / codeindex `find_references`. file-overview = serena
  `get_symbols_overview` / codeindex `symbols_overview`; graphify has no
  file-level equivalent (its file nodes are keyed by basename, collision-prone
  on real repos), so that cell is n/a by design.
- **Graphify's granularity is looser.** Its nodes are label-matched
  (case-insensitive, tolerant) and `get_neighbors` returns graph edges, not
  source locations — a coarser notion of "references" than the other
  tools' answers. Its cells are comparable as task outcomes, not as
  equal-precision results.
- **LSP precision cuts the other way.** serena's answers come from live
  language servers and are semantically precise (type-aware references);
  codeindex and graphify are static/syntactic. Where serena is slower, part
  of that time is buying precision the others do not claim — the timing
  tables cannot capture that asymmetry.
- **Activation and downloads are excluded from per-call numbers.** One-time
  installs and serena's per-language language-server downloads are never
  timed; activation (spawn -> ready) is measured separately in the MCP
  sessions table, and each server's index/parse cost lives in Cold index.

### Token-economy caveat

The token-economy scenario's `grep lines` column locates symbol occurrences
with a plain **substring** match over the raw repo text. A short, common
identifier — e.g. Go's `New` in `gin-gonic/gin` — will match inside unrelated
tokens and non-symbol lines, inflating the grep-side line count (and therefore
the token estimate). This bias makes the naive-grep baseline look *more*
expensive than it truly is, so the absolute `grep lines` / token counts for
common short names should be read as an upper bound, not an exact figure.

## Cold index

_Full process spawn per run into a fresh output dir. ctags emits a flat `tags` file with `-R` and, on small cold builds, is faster than codeindex's richer graph+symbol artifacts — an honest win for the simpler data model. serena `project index` builds its document-symbol cache (its one-time per-language language-server download is absorbed by the untimed warmup, never a measured run); `graphify update` parses the repo into graph.json (keyless, clustering computed locally). Both are cleaned between runs and are the load-side counterpart of the near-instant `activate->ready` cells in the MCP sessions table. serena and graphify are marked n/a on repos above ~8k files (here: vercel/next.js, ~30k): a full LSP / Python-graph index of a monorepo that size is a multi-minute, multi-GB job that measures indexer memory limits rather than retrieval — the streaming indexers (codeindex, ctags) are kept and measured there._

| Repo | Files | codeindex (ms) | ctags -R (ms) | serena project index (ms) | graphify update (ms) |
| --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | 223 | 358 | 32 | 2192 | 1759 |
| gin-gonic/gin | 129 | 187 | 20 | 2352 | 884 |
| nrwl/nx-examples | 230 | 131 | 21 | 878 | 803 |
| pallets/flask | 227 | 238 | 28 | 1118 | 1001 |
| socialgouv/code-du-travail-numerique | 2823 | 640 | 335 | 7595 | 10215 |
| t3-oss/create-t3-turbo | 132 | 129 | 26 | 939 | 600 |
| vercel/next.js | 20000 | 2843 | 3320 | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |

## Warm / incremental

_Re-index with a warm cache present, then with exactly one file touched (comment appended, restored after). Deliberately no serena/graphify column: neither exposes a comparable user-visible single-file reindex command (serena re-indexes lazily inside a live LSP session; graphify rebuilds via the cold command timed above)._

| Repo | codeindex warm rerun (ms) | codeindex +1 file (ms) |
| --- | --- | --- |
| BurntSushi/ripgrep | 53 | 105 |
| gin-gonic/gin | 46 | 91 |
| nrwl/nx-examples | 52 | 91 |
| pallets/flask | 51 | 114 |
| socialgouv/code-du-travail-numerique | 140 | 342 |
| t3-oss/create-t3-turbo | 48 | 87 |
| vercel/next.js | 918 | 1783 |

## Queries (find-symbol / references / callers)

_`find-symbol in-proc` / `references in-proc`: a single API call on an already-loaded warm scan (call timed alone). `caller-index in-proc`: builds the whole-scan caller index (not just callers-of-symbol). `full-index spawn`: a full `codeindex symbols` CLI process — Node startup PLUS a cold buildIndexArtifacts and serialization of the entire symbol table, i.e. NOT a single-symbol lookup. `ctags lookup`: scans the tags file for the symbol._

| Repo | Symbol | find-symbol in-proc (ms) | full-index spawn (ms) | references in-proc (ms) | caller-index in-proc (ms) | ctags lookup (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | WalkBuilder | 0 | 424 | 0 | 5 | 0 |
| gin-gonic/gin | New | 0 | 214 | 0 | 2 | 0 |
| nrwl/nx-examples | environment | 0 | 90 | 0 | 0 | 0 |
| pallets/flask | Flask | 0 | 268 | 0 | 1 | 0 |
| socialgouv/code-du-travail-numerique | ElementBuilder | 0 | 1291 | 0 | 6 | 6 |
| t3-oss/create-t3-turbo | Route | 0 | 96 | 0 | 0 | 0 |
| vercel/next.js | NextResponse | 1 | 6566 | 2 | 344 | 111 |

## MCP sessions (activate + per-call queries)

_All three servers speak the same stdio JSON-RPC transport to the same client, on primed artifacts. `activate->ready` times a WHOLE session — process spawn, initialize handshake, tools/list, first find-symbol answer — and its semantics differ per server, read it accordingly: serena starts a language server and lazily indexes against a cold `.serena` cache (LS binaries already on disk); graphify and now codeindex load prebuilt artifacts rather than rebuilding — codeindex primes a persisted `.codeindex/` index and its MCP server preloads it on the first call (a pure optimization: served responses stay byte-identical to a cold build), the same pattern as graphify-mcp, so its parse cost lives in the Cold index column (the `codeindex` cold cell, where it already sits) and `activate->ready` here reflects load-not-rebuild. The three task cells are per-call medians on a live session after activation; file-overview targets the file DEFINING the representative symbol (the same file for every server, in the repo's main language by construction). serena and graphify are n/a on repos above ~8k files (vercel/next.js): priming a full LSP / Python-graph index there is intractable at bench time (see the Cold index note); codeindex, which streams, is still measured._

| Repo | Server | Symbol | activate->ready (ms) | find-symbol (ms) | references (ms) | file-overview (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | codeindex | WalkBuilder | 62 | 17 | 13 | 15 |
| BurntSushi/ripgrep | serena | WalkBuilder | 2795 | 134 | 264 | 106 |
| BurntSushi/ripgrep | graphify | WalkBuilder | 287 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| gin-gonic/gin | codeindex | New | 52 | 10 | 10 | 9 |
| gin-gonic/gin | serena | New | 720 | 131 | 407 | 103 |
| gin-gonic/gin | graphify | New | 244 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| nrwl/nx-examples | codeindex | environment | 51 | 12 | 12 | 11 |
| nrwl/nx-examples | serena | environment | 665 | 131 | 114 | 105 |
| nrwl/nx-examples | graphify | environment | 239 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| pallets/flask | codeindex | Flask | 54 | 12 | 12 | 12 |
| pallets/flask | serena | Flask | 804 | 127 | 137 | 106 |
| pallets/flask | graphify | Flask | 239 | 1 | 5 | n/a (basename-keyed file nodes — n/a by design) |
| socialgouv/code-du-travail-numerique | codeindex | ElementBuilder | 153 | 75 | 75 | 72 |
| socialgouv/code-du-travail-numerique | serena | ElementBuilder | 1744 | 744 | 272 | 104 |
| socialgouv/code-du-travail-numerique | graphify | ElementBuilder | 521 | 2 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| t3-oss/create-t3-turbo | codeindex | Route | 51 | 11 | 12 | 11 |
| t3-oss/create-t3-turbo | serena | Route | 662 | 125 | 115 | 106 |
| t3-oss/create-t3-turbo | graphify | Route | 215 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| vercel/next.js | codeindex | NextResponse | 1008 | 735 | 726 | 723 |
| vercel/next.js | serena | NextResponse | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |
| vercel/next.js | graphify | NextResponse | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |

## Token economy (single-symbol lookup)

_An honest bytes/4 measurement of a raw grep vs our structured JSON. Ratio > 1 means the index returns less context to the model._

| Repo | Symbol | grep lines | grep tokens (measured) | index tokens (measured) | measured ratio |
| --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | WalkBuilder | 103 | 2280 | 39 | 58.8 |
| gin-gonic/gin | New | 816 | 13400 | 36 | 377.5 |
| nrwl/nx-examples | environment | 11 | 242 | 182 | 1.3 |
| pallets/flask | Flask | 1149 | 23865 | 70 | 342.1 |
| socialgouv/code-du-travail-numerique | ElementBuilder | 48 | 2047 | 62 | 32.9 |
| t3-oss/create-t3-turbo | Route | 115 | 2423 | 196 | 12.3 |
| vercel/next.js | NextResponse | 1389 | 39811 | 102 | 390.3 |

## MCP token economy (per-call response size)

_Context cost of each MCP answer: tokens ~= bytes/4 of the tool-call response text (same convention as the Token economy table). The codeindex rows are the baseline the other servers compare against. graphify's file-overview has no equivalent tool. Bigger is not automatically worse: serena's LSP answers carry semantically precise, type-aware references the static tools do not claim — this table measures context cost only, not answer quality._

| Repo | Server | find-symbol tokens | references tokens | file-overview tokens |
| --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | codeindex | 56 | 121 | 10709 |
| BurntSushi/ripgrep | serena | 37 | 5306 | 285 |
| BurntSushi/ripgrep | graphify | 38 | 1108 | n/a (basename-keyed file nodes — n/a by design) |
| gin-gonic/gin | codeindex | 53 | 3671 | 3449 |
| gin-gonic/gin | serena | 31 | 8740 | 264 |
| gin-gonic/gin | graphify | 35 | 1557 | n/a (basename-keyed file nodes — n/a by design) |
| nrwl/nx-examples | codeindex | 235 | 279 | 59 |
| nrwl/nx-examples | serena | 277 | 1 | 7 |
| nrwl/nx-examples | graphify | 59 | 37 | n/a (basename-keyed file nodes — n/a by design) |
| pallets/flask | codeindex | 115 | 2778 | 2705 |
| pallets/flask | serena | 74 | 67 | 54 |
| pallets/flask | graphify | 36 | 77 | n/a (basename-keyed file nodes — n/a by design) |
| socialgouv/code-du-travail-numerique | codeindex | 76 | 472 | 76 |
| socialgouv/code-du-travail-numerique | serena | 143 | 3515 | 8 |
| socialgouv/code-du-travail-numerique | graphify | 76 | 781 | n/a (basename-keyed file nodes — n/a by design) |
| t3-oss/create-t3-turbo | codeindex | 251 | 298 | 197 |
| t3-oss/create-t3-turbo | serena | 160 | 292 | 18 |
| t3-oss/create-t3-turbo | graphify | 38 | 98 | n/a (basename-keyed file nodes — n/a by design) |
| vercel/next.js | codeindex | 210 | 5595 | 548 |
| vercel/next.js | serena | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |
| vercel/next.js | graphify | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |

## Determinism (byte-identical rebuild)

_Two cold builds byte-compared (graph.json + symbols.json). serena keeps its symbols in a live LSP session, so there is no on-disk artifact to compare. graphify: two cold `graphify update` runs, `graph.json` bytes only (its HTML/report artifacts embed dates and are excluded)._

| Repo | codeindex (byte-identical) | serena | graphify graph.json |
| --- | --- | --- | --- |
| BurntSushi/ripgrep | yes | n/a (live LSP session — no artifact) | no |
| gin-gonic/gin | yes | n/a (live LSP session — no artifact) | yes |
| nrwl/nx-examples | yes | n/a (live LSP session — no artifact) | no |
| pallets/flask | yes | n/a (live LSP session — no artifact) | no |
| socialgouv/code-du-travail-numerique | yes | n/a (live LSP session — no artifact) | no |
| t3-oss/create-t3-turbo | yes | n/a (live LSP session — no artifact) | no |
| vercel/next.js | yes | n/a (live LSP session — no artifact) | n/a (repo too large for a bench-time full index (~30k files)) |

## Index size on disk

_Our artifacts (graph.json + symbols.json + cache.json) vs the ctags `tags` file vs serena's `.serena/` project cache (document-symbol pickles) vs graphify's MCP-servable `graph.json` alone (its `graphify-out/` also holds an AST cache and report files that never leave the build machine)._

| Repo | codeindex artifacts | ctags tags | serena .serena | graphify graph.json |
| --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | 2.0 MB | 524.4 KB | 5.1 MB | 5.0 MB |
| gin-gonic/gin | 1.2 MB | 267.2 KB | 2.0 MB | 2.0 MB |
| nrwl/nx-examples | 332.5 KB | 238.2 KB | 384.4 KB | 1.2 MB |
| pallets/flask | 1.2 MB | 282.3 KB | 3.1 MB | 1.3 MB |
| socialgouv/code-du-travail-numerique | 12.6 MB | 4.4 MB | 57.3 MB | 13.7 MB |
| t3-oss/create-t3-turbo | 277.3 KB | 87.9 KB | 633.4 KB | 822.3 KB |
| vercel/next.js | 69.8 MB | 80.8 MB | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |

## Install footprint

_Measured, not declared. Our tarball is the unpacked size from `npm pack --dry-run`._

| Tool | Install footprint | Notes |
| --- | --- | --- |
| codeindex | 23.4 MB | zero runtime dependencies; single engine.mjs |
| serena | 114.3 MB | uv tool venv; + 25.6 MB language servers in ~/.serena/language_servers (measured); requires node/npm (TS), gopls (Go), rust-analyzer (Rust) |
| graphify | 140.1 MB | uv tool venv (graphifyy); tree-sitter grammar wheels bundled; [mcp] extra required for the MCP server |

## Environment

_This section records the measurement machine and session date; it is explicitly OUTSIDE the reproducibility scope._

- Node: v24.15.0
- CPU: Apple M5
- RAM: 16.0 GB
- Date: 2026-07-25T10:36:55.397Z
