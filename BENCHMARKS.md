# codeindex — competitor benchmarks

Reproducible harness (`scripts/bench/`) comparing codeindex against 01x-in/codeindex, universal-ctags and scip-typescript. Timings are the median of 5 runs with one warmup discarded; a cell reading `n/a (reason)` means that tool was not measurable in this session.

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

_Full process spawn per run into a fresh output dir. scip-typescript excludes its npm install (timed separately, shown inline). 01x `init` shells out to ast-grep per file and is cleaned between runs._

| Repo | Files | codeindex (ms) | ctags -R (ms) | scip-typescript (ms) | 01x init (ms) |
| --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | 223 | 500 | 45 | n/a (no tsconfig) | 1506 |
| gin-gonic/gin | 129 | 277 | 20 | n/a (no tsconfig) | 1661 |
| nrwl/nx-examples | 230 | 101 | 21 | n/a (npm install failed) | 994 |
| pallets/flask | 227 | 307 | 26 | n/a (no tsconfig) | 1265 |
| socialgouv/code-du-travail-numerique | 2823 | 1746 | 371 | n/a (no tsconfig) | 13409 |
| t3-oss/create-t3-turbo | 132 | 103 | 24 | n/a (no tsconfig) | 449 |
| vercel/next.js | 20000 | 9398 | 3431 | n/a (npm install failed) | 86062 (3×) |

## Warm / incremental

_Re-index with a warm cache present, then with exactly one file touched (comment appended, restored after). 01x re-indexes the single touched file._

| Repo | codeindex warm rerun (ms) | codeindex +1 file (ms) | 01x reindex file (ms) |
| --- | --- | --- | --- |
| BurntSushi/ripgrep | 85 | 100 | 12 |
| gin-gonic/gin | 72 | 79 | 29 |
| nrwl/nx-examples | 77 | 82 | 14 |
| pallets/flask | 95 | 120 | 12 |
| socialgouv/code-du-travail-numerique | 339 | 344 | n/a (reindex exit 1) |
| t3-oss/create-t3-turbo | 66 | 73 | 11 |
| vercel/next.js | 1775 | 1828 | 11 |

## Queries (find-symbol / references / callers)

_`find-symbol in-proc` / `references in-proc`: a single API call on an already-loaded warm scan (call timed alone). `caller-index in-proc`: builds the whole-scan caller index (not just callers-of-symbol). `full-index spawn`: a full `codeindex symbols` CLI process — Node startup PLUS a cold buildIndexArtifacts and serialization of the entire symbol table, i.e. NOT a single-symbol lookup. `01x find-symbol`: one query against its primed SQLite DB. `ctags lookup`: scans the tags file for the symbol._

| Repo | Symbol | find-symbol in-proc (ms) | full-index spawn (ms) | references in-proc (ms) | caller-index in-proc (ms) | 01x find-symbol (ms) | ctags lookup (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BurntSushi/ripgrep | WalkBuilder | 0 | 466 | 8 | 5 | 5 | 0 |
| gin-gonic/gin | New | 0 | 275 | 3 | 2 | 5 | 0 |
| nrwl/nx-examples | environment | 0 | 116 | 2 | 0 | 7 | 0 |
| pallets/flask | Flask | 0 | 321 | 15 | 2 | 6 | 0 |
| socialgouv/code-du-travail-numerique | ElementBuilder | 0 | 1860 | 49 | 4 | 5 | 7 |
| t3-oss/create-t3-turbo | Route | 0 | 108 | 1 | 0 | 5 | 0 |
| vercel/next.js | NextResponse | 1 | 9600 | 579 | 323 | 5 | 121 |

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

## Determinism (byte-identical rebuild)

_Two cold builds byte-compared (graph.json + symbols.json). 01x keeps a SQLite DB (embedded ids/timestamps) that is not byte-comparable, so determinism is not claimed for it here._

| Repo | codeindex (byte-identical) | 01x |
| --- | --- | --- |
| BurntSushi/ripgrep | yes | n/a (SQLite) |
| gin-gonic/gin | yes | n/a (SQLite) |
| nrwl/nx-examples | yes | n/a (SQLite) |
| pallets/flask | yes | n/a (SQLite) |
| socialgouv/code-du-travail-numerique | yes | n/a (SQLite) |
| t3-oss/create-t3-turbo | yes | n/a (SQLite) |
| vercel/next.js | yes | n/a (SQLite) |

## Index size on disk

_Our artifacts (graph.json + symbols.json + cache.json) vs 01x's `.codeindex/` SQLite DB vs the ctags `tags` file._

| Repo | codeindex artifacts | 01x .codeindex | ctags tags |
| --- | --- | --- | --- |
| BurntSushi/ripgrep | 2.0 MB | 1.0 MB | 524.4 KB |
| gin-gonic/gin | 1.2 MB | 1.1 MB | 267.2 KB |
| nrwl/nx-examples | 332.3 KB | 104.0 KB | 238.2 KB |
| pallets/flask | 1.2 MB | 908.0 KB | 282.3 KB |
| socialgouv/code-du-travail-numerique | 12.6 MB | 1.3 MB | 4.4 MB |
| t3-oss/create-t3-turbo | 277.1 KB | 84.0 KB | 87.9 KB |
| vercel/next.js | 69.8 MB | 17.2 MB | 80.8 MB |

## Install footprint

_Measured, not declared. Our tarball is the unpacked size from `npm pack --dry-run`._

| Tool | Install footprint | Notes |
| --- | --- | --- |
| codeindex | 23.1 MB | zero runtime dependencies; single engine.mjs |
| 01x | 8.1 MB | binary only; + ast-grep 49.1 MB required |
| scip-typescript | binary + target-repo node_modules | requires a full npm install of each indexed repo (see cold column) |

## Environment

_This section records the measurement machine and session date; it is explicitly OUTSIDE the reproducibility scope._

- Node: v24.10.0
- CPU: Apple M5
- RAM: 16.0 GB
- Date: 2026-07-23T09:03:13.384Z
