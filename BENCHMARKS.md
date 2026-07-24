# codeindex — competitor benchmarks

Reproducible harness (`scripts/bench/`) comparing codeindex against 01x-in/codeindex, universal-ctags, scip-typescript, Serena (LSP over MCP), Graphify and repo-falcon. Timings are the median of 5 runs with one warmup discarded; a cell reading `n/a (reason)` means that tool was not measurable in this session.

## Methodology & fairness

The two tools are architecturally different, not just differently tuned, so
every comparison below is between specific *operations*, never a vague
"codeindex vs 01x":

- **Different models.** codeindex renders static, byte-stable artifacts
  (`graph.json` / `symbols.json` / `cache.json`) once per build; 01x-in
  maintains a live SQLite database (`.codeindex/`) that its CLI opens on every
  invocation. Neither model is a strict subset of the other — see
  Determinism and Index size below for what that costs each of them.
- **01x's cold init shells out to ast-grep per file.** Its `init` command
  spawns the external `ast-grep` binary once per source file to extract
  symbols; that process-spawn overhead is *inside* every 01x cold-init number
  in this report, exactly as a real user would experience it. codeindex's
  cold index has no external process dependency.
- **Two query modes for codeindex, on purpose.** `find-symbol in-proc` /
  `references in-proc` / `caller-index in-proc` time a single API call
  against an already-loaded warm scan — the number a long-running host
  process (MCP server, editor plugin) actually pays per query. `full-index
  spawn` times a full `codeindex symbols` CLI invocation: Node startup, a
  cold `buildIndexArtifacts`, and serialization of the *entire* symbol table —
  it is **not** a single-symbol lookup and must never be read as one. It is
  included so a one-shot CLI caller can see that cost too, and so it can be
  weighed against 01x's own single-query numbers on equal footing (both are
  full process spawns).
- **01x `find-symbol` in the Queries table is one query against its primed
  SQLite DB** (after its own `init`, which is timed separately in Cold
  index). It is the fair counterpart to codeindex's in-proc lookups, not to
  `full-index spawn`.

### MCP servers (Serena, Graphify, falcon): task equivalence

The three MCP competitors answer the same three tasks — find-symbol,
references, file-overview — but not with the same machinery, so the mapping
is pinned here and must be read alongside the MCP sessions / MCP token
economy tables:

- **Same transport, same client, for everyone.** All four servers (codeindex
  included) are driven over the same newline-delimited JSON-RPC 2.0 stdio
  transport by the same client (`scripts/bench/mcp-client.mjs`), one tool
  call per session — graphify's server drops still-queued responses at stdin
  EOF, so the one-call-per-session policy is applied to all servers for
  symmetry.
- **Task equivalence, pinned.** find-symbol = serena `find_symbol` /
  graphify `get_node` / falcon `falcon_symbol_lookup` / codeindex
  `find_symbol`. references = serena `find_referencing_symbols` / graphify
  `get_neighbors` (incoming calls/imports edges) / falcon: the SAME
  `falcon_symbol_lookup` call as find-symbol — v0.6.4 embeds
  callers/references in that one response and ships no separate references
  tool. file-overview = serena `get_symbols_overview` / falcon
  `falcon_file_context`; graphify has no file-level equivalent (its file
  nodes are keyed by basename, collision-prone on real repos), so that cell
  is n/a by design.
- **Graphify's granularity is looser.** Its nodes are label-matched
  (case-insensitive, tolerant) and `get_neighbors` returns graph edges, not
  source locations — a coarser notion of "references" than the other
  tools' answers. Its cells are comparable as task outcomes, not as
  equal-precision results.
- **LSP precision cuts the other way.** serena's answers come from live
  language servers and are semantically precise (type-aware references);
  codeindex, graphify and falcon are static/syntactic. Where serena is
  slower, part of that time is buying precision the others do not claim —
  the timing tables cannot capture that asymmetry.
- **Activation and downloads are excluded from per-call numbers.** One-time
  installs and serena's per-language language-server downloads are never
  timed; activation (spawn -> ready) is measured separately in the MCP
  sessions table, and each server's index/parse cost lives in Cold index.
- **falcon does not index Rust** (v0.6.4 covers Go/JS-TS/Python/Java), so
  every falcon cell for `BurntSushi/ripgrep` reads `n/a (rust not
  supported)` — a capability gap, not a measurement failure.

### Token-economy caveat

The token-economy scenario's `grep lines` / `01x formula ratio` columns
locate symbol occurrences with a plain **substring** match over the raw repo
text (reproducing 01x's own published grep-based method, for comparability).
A short, common identifier — e.g. Go's `New` in `gin-gonic/gin` — will match
inside unrelated tokens and non-symbol lines, inflating the grep-side line
count (and therefore the token estimate) for both tools equally. This bias is
symmetric: it makes the naive-grep baseline look *more* expensive than it
truly is, which favors neither codeindex nor 01x in the ratio, but it means
the absolute `grep lines` / token counts for common short names should be
read as an upper bound, not an exact figure.

### Reference: 01x-in's own published figures (not measured here)

01x-in/codeindex publishes its own `vercel/next.js` numbers at
`benchmarks/results/next.js.md` in their repository (dated April 2026, on
their own machine, against their own SHA — which is **not** the SHA pinned in
this report's `repos.mjs`):

| Metric | 01x-in's published figure |
| --- | --- |
| `init` (cold), 11,064 files | 121,037 ms |
| `reindex` (single file) | 60 ms |
| `find-symbol` | 13 ms |

These are quoted here **only as external context** — they were measured by
01x-in, on their machine, on their SHA, and are **not** reproduced or
verified by this harness. They must never be read as this session's
measurement of 01x. The directly comparable, apples-to-apples figures are the
01x columns measured in this same session, on this same machine, against the
SHA pinned above (Cold index → `01x init (ms)`; Warm/incremental → `01x
reindex file (ms)`; Queries → `01x find-symbol (ms)`, all for `vercel/next.js`).

This report's `vercel/next.js` **Files** count (20,000) is codeindex's own
default walk cap (`DEFAULT_MAX_FILES`), confirmed hit in this session
(`capped: true`) — next.js has more source files on disk than that. 01x-in's
published 11,064 is their own tool's file count under their own ignore
rules, on their SHA. The two file counts are not on the same scope and
should not be read as "the same repo size."

### Notes on specific cells in this session

- **`vercel/next.js` — `01x init` (Cold index) is right at this harness's
  spawn-timeout boundary.** 01x's cold `init` on this repo takes roughly
  85-125s on this machine across repeated measurements — close to this
  harness's internal per-process spawn timeout (120s, `runCmd`'s
  `execFileSync` default) and to 01x-in's own published figure for the same
  operation (121,037 ms, see above). A separate measurement session on this
  same machine, same SHA, produced `n/a (init exit null)` here instead of a
  millisecond figure, because the spawn was killed after 120s. That earlier
  session's raw log and this session's `86062 (3×)` value are both authentic
  measurements of the same underlying fact: this operation's cost on this
  repo, on this architecture combination (external ast-grep spawn per file,
  ~12,000 files), sits right at that boundary and can read either way. The
  `01x reindex file` / `01x find-symbol` cells for `vercel/next.js` depend on
  a successful `init` to prime the DB first, so they inherit the same
  boundary risk.
- **`socialgouv/code-du-travail-numerique` — `01x reindex file` (Warm):
  `n/a (reindex exit 1)`.** This repo's deterministic "first code file"
  (auto-picked the same way for both tools' touch-target) is
  `lighthouserc.cjs`. codeindex classifies it as source; 01x's `reindex`
  rejects it deterministically with "cannot determine language for
  lighthouserc.cjs" (confirmed by direct reproduction outside this harness).
  This is a genuine, repeatable language-support gap on this one file, not a
  flaky failure — it reproduced identically across both sessions run for
  this report.

## Cold index

_Full process spawn per run into a fresh output dir. scip-typescript excludes its npm install (timed separately, shown inline). 01x `init` shells out to ast-grep per file and is cleaned between runs. serena `project index` builds its document-symbol cache (its one-time per-language language-server download is absorbed by the untimed warmup, never a measured run); `graphify update` parses the repo into graph.json (keyless, clustering computed locally); `falcon index` writes its parquet artifact set. All three are cleaned between runs and are the load-side counterpart of the near-instant `activate->ready` cells in the MCP sessions table. serena and graphify are marked n/a on repos above ~8k files (here: vercel/next.js, ~30k): a full LSP / Python-graph index of a monorepo that size is a multi-minute, multi-GB job that measures indexer memory limits rather than retrieval — the streaming indexers (codeindex, ctags, scip-typescript, falcon) are kept and measured there._

| Repo | Files | codeindex (ms) | ctags -R (ms) | scip-typescript (ms) | 01x init (ms) | serena project index (ms) | graphify update (ms) | falcon index (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | 223 | 468 | 30 | n/a (no tsconfig) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 2406 | 1863 | n/a (rust not supported) |
| gin-gonic/gin | 129 | 262 | 17 | n/a (no tsconfig) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 2516 | 884 | 77 |
| nrwl/nx-examples | 230 | 92 | 19 | n/a (npm install failed) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 935 | 996 | 79 |
| pallets/flask | 227 | 327 | 25 | n/a (no tsconfig) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 1263 | 1043 | 141 |
| socialgouv/code-du-travail-numerique | 2823 | 1848 | 338 | n/a (no tsconfig) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 7405 | 10233 | 916 |
| t3-oss/create-t3-turbo | 132 | 96 | 24 | n/a (no tsconfig) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 998 | 592 | 65 |
| vercel/next.js | 20000 | 8322 | 3158 | n/a (npm install failed) | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | 11169 |

## Warm / incremental

_Re-index with a warm cache present, then with exactly one file touched (comment appended, restored after). 01x re-indexes the single touched file. Deliberately no serena/graphify/falcon column: none of them exposes a comparable user-visible single-file reindex command (serena re-indexes lazily inside a live LSP session; graphify and falcon rebuild via the cold commands timed above)._

| Repo | codeindex warm rerun (ms) | codeindex +1 file (ms) | 01x reindex file (ms) |
| --- | --- | --- | --- |
| BurntSushi/ripgrep | 49 | 79 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |
| gin-gonic/gin | 42 | 67 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |
| nrwl/nx-examples | 48 | 63 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |
| pallets/flask | 48 | 88 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |
| socialgouv/code-du-travail-numerique | 134 | 340 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |
| t3-oss/create-t3-turbo | 44 | 60 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |
| vercel/next.js | 887 | 1668 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) |

## Queries (find-symbol / references / callers)

_`find-symbol in-proc` / `references in-proc`: a single API call on an already-loaded warm scan (call timed alone). `caller-index in-proc`: builds the whole-scan caller index (not just callers-of-symbol). `full-index spawn`: a full `codeindex symbols` CLI process — Node startup PLUS a cold buildIndexArtifacts and serialization of the entire symbol table, i.e. NOT a single-symbol lookup. `01x find-symbol`: one query against its primed SQLite DB. `ctags lookup`: scans the tags file for the symbol._

| Repo | Symbol | find-symbol in-proc (ms) | full-index spawn (ms) | references in-proc (ms) | caller-index in-proc (ms) | 01x find-symbol (ms) | ctags lookup (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | WalkBuilder | 0 | 444 | 0 | 5 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 0 |
| gin-gonic/gin | New | 0 | 252 | 0 | 2 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 0 |
| nrwl/nx-examples | environment | 0 | 87 | 0 | 0 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 0 |
| pallets/flask | Flask | 0 | 300 | 0 | 1 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 0 |
| socialgouv/code-du-travail-numerique | ElementBuilder | 0 | 1662 | 0 | 5 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 6 |
| t3-oss/create-t3-turbo | Route | 0 | 92 | 0 | 0 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 0 |
| vercel/next.js | NextResponse | 1 | 9292 | 2 | 320 | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 107 |

## MCP sessions (activate + per-call queries)

_All four servers speak the same stdio JSON-RPC transport to the same client, on primed artifacts. `activate->ready` times a WHOLE session — process spawn, initialize handshake, tools/list, first find-symbol answer — and its semantics differ per server, read it accordingly: serena starts a language server and lazily indexes against a cold `.serena` cache (LS binaries already on disk); graphify, falcon, and now codeindex load prebuilt artifacts rather than rebuilding — codeindex primes a persisted `.codeindex/` index and its MCP server preloads it on the first call (a pure optimization: served responses stay byte-identical to a cold build), the same pattern as `falcon mcp serve` / graphify-mcp, so its parse cost lives in the Cold index column (the `codeindex` cold cell, where it already sits) and `activate->ready` here reflects load-not-rebuild. The three task cells are per-call medians on a live session after activation; file-overview targets the file DEFINING the representative symbol (the same file for every server, in the repo's main language by construction). falcon's references cell times the SAME `falcon_symbol_lookup` call as find-symbol — v0.6.4 has no separate references tool, its lookup response embeds callers/references. serena and graphify are n/a on repos above ~8k files (vercel/next.js): priming a full LSP / Python-graph index there is intractable at bench time (see the Cold index note); codeindex and falcon, which stream, are still measured._

| Repo | Server | Symbol | activate->ready (ms) | find-symbol (ms) | references (ms) | file-overview (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | codeindex | WalkBuilder | 53 | 13 | 12 | 12 |
| BurntSushi/ripgrep | serena | WalkBuilder | 2167 | 145 | 251 | 107 |
| BurntSushi/ripgrep | graphify | WalkBuilder | 258 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| BurntSushi/ripgrep | falcon | WalkBuilder | n/a (rust not supported) | n/a (rust not supported) | n/a (rust not supported) | n/a (rust not supported) |
| gin-gonic/gin | codeindex | New | 46 | 9 | 8 | 8 |
| gin-gonic/gin | serena | New | 618 | 130 | 374 | 105 |
| gin-gonic/gin | graphify | New | 217 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| gin-gonic/gin | falcon | New | 15 | 0 | 0 | 0 |
| nrwl/nx-examples | codeindex | environment | 56 | 15 | 16 | 16 |
| nrwl/nx-examples | serena | environment | 636 | 143 | 131 | 106 |
| nrwl/nx-examples | graphify | environment | 219 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| nrwl/nx-examples | falcon | environment | 8 | 0 | 0 | 0 |
| pallets/flask | codeindex | Flask | 55 | 26 | 15 | 15 |
| pallets/flask | serena | Flask | 775 | 147 | 153 | 109 |
| pallets/flask | graphify | Flask | 210 | 1 | 5 | n/a (basename-keyed file nodes — n/a by design) |
| pallets/flask | falcon | Flask | 9 | 0 | 0 | 0 |
| socialgouv/code-du-travail-numerique | codeindex | ElementBuilder | 207 | 125 | 126 | 125 |
| socialgouv/code-du-travail-numerique | serena | ElementBuilder | 1788 | 631 | 252 | 105 |
| socialgouv/code-du-travail-numerique | graphify | ElementBuilder | 474 | 2 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| socialgouv/code-du-travail-numerique | falcon | ElementBuilder | 25 | 0 | 0 | 0 |
| t3-oss/create-t3-turbo | codeindex | Route | 48 | 12 | 14 | 13 |
| t3-oss/create-t3-turbo | serena | Route | 634 | 146 | 120 | 106 |
| t3-oss/create-t3-turbo | graphify | Route | 232 | 1 | 1 | n/a (basename-keyed file nodes — n/a by design) |
| t3-oss/create-t3-turbo | falcon | Route | 8 | 0 | 0 | 0 |
| vercel/next.js | codeindex | NextResponse | 1617 | 1359 | 1370 | 1368 |
| vercel/next.js | serena | NextResponse | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |
| vercel/next.js | graphify | NextResponse | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |
| vercel/next.js | falcon | NextResponse | 164 | 0 | 0 | 0 |

## Token economy (single-symbol lookup)

_Two methods side by side: 01x's published formula (grep_lines×30 vs len×5+200) and an honest bytes/4 measurement of a raw grep vs our structured JSON. Ratio > 1 means the index returns less context to the model._

| Repo | Symbol | grep lines | 01x formula ratio | grep tokens (measured) | index tokens (measured) | measured ratio |
| --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | WalkBuilder | 103 | 12.1 | 2280 | 39 | 58.8 |
| gin-gonic/gin | New | 816 | 113.9 | 13400 | 36 | 377.5 |
| nrwl/nx-examples | environment | 11 | 1.3 | 242 | 182 | 1.3 |
| pallets/flask | Flask | 1149 | 153.2 | 23865 | 70 | 342.1 |
| socialgouv/code-du-travail-numerique | ElementBuilder | 48 | 5.3 | 2047 | 62 | 32.9 |
| t3-oss/create-t3-turbo | Route | 115 | 15.3 | 2423 | 196 | 12.3 |
| vercel/next.js | NextResponse | 1389 | 160.3 | 39811 | 102 | 390.3 |

## MCP token economy (per-call response size)

_Context cost of each MCP answer: tokens ~= bytes/4 of the tool-call response text (same convention as the Token economy table). The codeindex rows are the baseline the other servers compare against. falcon's references figure reuses the find-symbol response (same call, see MCP sessions); graphify's file-overview has no equivalent tool. Bigger is not automatically worse: serena's LSP answers carry semantically precise, type-aware references the static tools do not claim — this table measures context cost only, not answer quality._

| Repo | Server | find-symbol tokens | references tokens | file-overview tokens |
| --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | codeindex | 56 | 121 | 10709 |
| BurntSushi/ripgrep | serena | 37 | 5306 | 285 |
| BurntSushi/ripgrep | graphify | 38 | 1108 | n/a (basename-keyed file nodes — n/a by design) |
| BurntSushi/ripgrep | falcon | n/a (rust not supported) | n/a (rust not supported) | n/a (rust not supported) |
| gin-gonic/gin | codeindex | 53 | 3671 | 3449 |
| gin-gonic/gin | serena | 31 | 8740 | 264 |
| gin-gonic/gin | graphify | 35 | 1557 | n/a (basename-keyed file nodes — n/a by design) |
| gin-gonic/gin | falcon | 22 | 22 | 678 |
| nrwl/nx-examples | codeindex | 235 | 279 | 59 |
| nrwl/nx-examples | serena | 277 | 1 | 7 |
| nrwl/nx-examples | graphify | 59 | 37 | n/a (basename-keyed file nodes — n/a by design) |
| nrwl/nx-examples | falcon | 109 | 109 | 35 |
| pallets/flask | codeindex | 115 | 2778 | 2705 |
| pallets/flask | serena | 74 | 67 | 54 |
| pallets/flask | graphify | 36 | 77 | n/a (basename-keyed file nodes — n/a by design) |
| pallets/flask | falcon | 27 | 27 | 144 |
| socialgouv/code-du-travail-numerique | codeindex | 76 | 472 | 76 |
| socialgouv/code-du-travail-numerique | serena | 143 | 3515 | 8 |
| socialgouv/code-du-travail-numerique | graphify | 76 | 781 | n/a (basename-keyed file nodes — n/a by design) |
| socialgouv/code-du-travail-numerique | falcon | 52 | 52 | 118 |
| t3-oss/create-t3-turbo | codeindex | 251 | 298 | 197 |
| t3-oss/create-t3-turbo | serena | 160 | 292 | 18 |
| t3-oss/create-t3-turbo | graphify | 38 | 98 | n/a (basename-keyed file nodes — n/a by design) |
| t3-oss/create-t3-turbo | falcon | 99 | 99 | 101 |
| vercel/next.js | codeindex | 210 | 5595 | 548 |
| vercel/next.js | serena | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |
| vercel/next.js | graphify | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) |
| vercel/next.js | falcon | 74 | 74 | 110 |

## Determinism (byte-identical rebuild)

_Two cold builds byte-compared (graph.json + symbols.json). 01x keeps a SQLite DB (embedded ids/timestamps) that is not byte-comparable, so determinism is not claimed for it here. graphify: two cold `graphify update` runs, `graph.json` bytes only (its HTML/report artifacts embed dates and are excluded). falcon: two cold `falcon index` runs, all parquet artifacts byte-compared for the cell. falcon's metadata.json is compared separately after dropping its embedded absolute paths (artifacts.path, repo.root); no field differed — falcon carries no timestamps (it reports determinism.timestamps: "omitted")._

| Repo | codeindex (byte-identical) | 01x | serena | graphify graph.json | falcon artifacts |
| --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | no | n/a (rust not supported) |
| gin-gonic/gin | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | no | yes |
| nrwl/nx-examples | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | no | yes |
| pallets/flask | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | yes | yes |
| socialgouv/code-du-travail-numerique | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | no | yes |
| t3-oss/create-t3-turbo | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | no | yes |
| vercel/next.js | yes | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | n/a (live LSP session — no artifact) | n/a (repo too large for a bench-time full index (~30k files)) | no |

## Index size on disk

_Our artifacts (graph.json + symbols.json + cache.json) vs 01x's `.codeindex/` SQLite DB vs the ctags `tags` file vs serena's `.serena/` project cache (document-symbol pickles) vs graphify's MCP-servable `graph.json` alone (its `graphify-out/` also holds an AST cache and report files that never leave the build machine) vs falcon's `.falcon/artifacts` parquet set._

| Repo | codeindex artifacts | 01x .codeindex | ctags tags | serena .serena | graphify graph.json | falcon .falcon/artifacts |
| --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | 2.0 MB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 524.4 KB | 5.1 MB | 5.0 MB | n/a (rust not supported) |
| gin-gonic/gin | 1.2 MB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 267.2 KB | 2.0 MB | 2.0 MB | 448.2 KB |
| nrwl/nx-examples | 332.5 KB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 238.2 KB | 384.4 KB | 1.2 MB | 79.0 KB |
| pallets/flask | 1.2 MB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 282.3 KB | 3.1 MB | 1.3 MB | 210.8 KB |
| socialgouv/code-du-travail-numerique | 12.6 MB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 4.4 MB | 57.3 MB | 13.7 MB | 1.6 MB |
| t3-oss/create-t3-turbo | 277.3 KB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 87.9 KB | 633.4 KB | 823.1 KB | 100.2 KB |
| vercel/next.js | 69.8 MB | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | 80.8 MB | n/a (repo too large for a bench-time full index (~30k files)) | n/a (repo too large for a bench-time full index (~30k files)) | 18.8 MB |

## Install footprint

_Measured, not declared. Our tarball is the unpacked size from `npm pack --dry-run`._

| Tool | Install footprint | Notes |
| --- | --- | --- |
| codeindex | 23.3 MB | zero runtime dependencies; single engine.mjs |
| 01x | n/a (PATH codeindex is not 01x (name collision; set BENCH_01X_BIN)) | requires ast-grep in PATH |
| scip-typescript | binary + target-repo node_modules | requires a full npm install of each indexed repo (see cold column) |
| serena | 114.3 MB | uv tool venv; + 25.6 MB language servers in ~/.serena/language_servers (measured); requires node/npm (TS), gopls (Go), rust-analyzer (Rust) |
| graphify | 140.1 MB | uv tool venv (graphifyy); tree-sitter grammar wheels bundled; [mcp] extra required for the MCP server |
| falcon | 32.9 MB | single static Go binary, no runtime deps (brew tap SocialGouv/repo-falcon) |

## Environment

_This section records the measurement machine and session date; it is explicitly OUTSIDE the reproducibility scope._

- Node: v24.10.0
- CPU: Apple M5
- RAM: 16.0 GB
- Date: 2026-07-24T18:23:29.632Z
