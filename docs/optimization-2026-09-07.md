# Cache validation and reference-query optimization

Baseline: `f75f828893a9017d90a65bf1ecd5963dd1bb5139` (2.28.5).
Measured on 2026-09-07 with Node 24.19.0, Apple M5, 16 GB RAM.

## Changes

The persisted cache reader previously checked versions but trusted each JSON
record through a TypeScript assertion. A stat-matching entry containing
`record: {}` was accepted and could crash reference queries with
`f.symbols is not iterable`. CLI indexing could also keep that invalid entry
through its unchanged-artifacts fastpath instead of repairing the cache.

`src/cache.ts` now validates the cache at both entry points: session preload and
CLI `index`. It checks required and optional field types, nested extraction
records, canonical relative paths, symbol/file path agreement, SHA-1 syntax,
entry/record hash agreement and size metadata. Any invalid entry discards the
whole cache and causes a normal rebuild. Missing optional fields remain valid.
This checks structural integrity; it does not authenticate cache contents or
replace the existing content/stat freshness checks.

`findReferences` now uses the existing per-scan symbol-name index to collect
definitions. Filtering and sorting are unchanged, and the returned array is
independent of the cached array. The remaining file-reference pass still visits
files. Node/browser bundles and declarations were regenerated; the CLI wrapper
remained byte-identical. Public exports, response shapes and schema versions did
not change. No release was published.

## Measurements

Both engines indexed identical temporary source bytes and used the baseline's
core grammar assets. An initial comparison correctly failed when only the
candidate had extended grammars installed; the harness now explicitly pins the
grammar directory for both engines and all their child processes.

Each session contains one warmup and five measured samples per workload.
In-process reference-query samples average 1,000 calls alternating a symbol
lookup and a missing name. Index timings include process startup; MCP timings
are requests in an already initialized session with a primed index. The
incremental workload changes one source comment per iteration. A second session
was run because short MCP timings and parallel-index RSS varied.

The second session's medians are below. Values are **before → after**.

| Workload | Mini fixture | Codeindex source | Synthetic corpus |
|---|---:|---:|---:|
| Indexed files / symbols | 14 / 12 | 374 / 8,184 | 200 / 20,200 |
| Cold index, ms | 58.62 → 58.78 | 652.84 → 650.88 | 226.15 → 219.71 |
| Warm index, ms | 38.81 → 39.25 | 75.45 → 78.85 | 51.68 → 53.82 |
| One-file update, ms | 48.32 → 48.73 | 138.94 → 140.55 | 105.24 → 106.30 |
| Reference query in process, µs | 0.77 → 0.63 | 66.40 → 32.77 | 41.56 → 1.07 |
| Reference query over MCP, ms | 3.92 → 3.79 | 10.18 → 10.10 | 4.45 → 4.21 |
| MCP response text, bytes | 343 → 343 | 2,570 → 2,570 | 282 → 282 |

The reproducible gain is in reference-query computation: **2.02–2.03×** on
codeindex and **22–39×** on the synthetic symbol-heavy corpus across the two
sessions. On codeindex, second-session query sample ranges did not overlap:
65.70–67.83 µs before versus 32.50–33.43 µs after. The tiny fixture's sample
ranges overlap, so its apparent improvement is not claimed as a reliable gain.
MCP end-to-end latency is dominated by other work and does not show a consistent
large improvement. Response bytes, query results, MCP response text, graph JSON
and symbol JSON all matched exactly, checked with hashes in both sessions.

Cache validation has a measurable cost: warm CLI indexing added 3.4–5.3 ms on
codeindex and 2.1–3.5 ms on the synthetic corpus across the sessions. It is paid
when loading persisted JSON, not on each reference lookup in an existing scan.
No reduction in memory use or overall indexing time is claimed.

Peak RSS is measured in KiB using `process.resourceUsage().maxRSS`, in separate
processes for index runs and query batches. In the second session, maximum cold
index RSS across five samples was 97,296 → 98,576 KiB (mini),
1,596,992 → 1,669,712 KiB (codeindex), and 342,480 → 346,032 KiB (synthetic).
The query process peaked at 105,696 → 103,616 KiB, 1,044,064 → 1,096,192 KiB,
and 189,440 → 173,376 KiB respectively. Parallel extraction and garbage
collection make these peaks variable; the new name index can also retain
additional data when a session had not previously queried symbols by name.

Both sessions' samples, hashes and RSS measurements are in
[optimization-2026-09-07.json](optimization-2026-09-07.json).
Token counts there are estimates (`ceil(responseBytes / 4)`), not tokenizer
measurements. They are unchanged because the response bytes are unchanged.

To reproduce after building the candidate:

```sh
git worktree add --detach /tmp/codeindex-before f75f828893a9017d90a65bf1ecd5963dd1bb5139
node scripts/bench/optimization.mjs /tmp/codeindex-before "$PWD"
```

The harness creates and removes its own temporary corpora. It does not modify
either checkout or download competitor tools.

## Verification

| Command | Exit | Evidence |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | Lockfile unchanged; dependencies installed |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm build` | 0 | Node/browser bundles and declarations generated |
| `pnpm test` | 0 | 1,335 passed, 50 opt-in tests skipped |
| `pnpm quality:report` | 0 | 177 passed; quality baseline unchanged |
| `pnpm run test:e2e` | 0 | 38 passed across seven pinned real repositories and bundle checks |
| `pnpm run check:build` with an isolated Git index | 0 | Second build identical to the generated artifacts |
| Node 18.20.8 library import, CLI scan and search | 0 | Import succeeded; both output files nonempty |
| Benchmark harness, both comparable sessions | 0 | All three corpora's output equality assertions passed |

The reproducible-build command used a temporary `GIT_INDEX_FILE` containing the
newly generated artifacts, so it compared against this implementation rather
than the previous commit's bundles. The user's Git index was not changed.

Before the fix, 39 of the 42 new cache-validation tests failed. After the fix,
all 42 passed. Added integration coverage checks CLI recovery and an MCP
reference response against a cold server. Query coverage includes homonyms,
reexports, missing names, ordering and mutation of the returned array.

Independent read-only reviews covered correctness, failure handling, wiring
and plan conformance. The `verify` guard's full-bundle scan reported one existing
empty catch on a changed minified line. An independent comparison located the
same catch at the same character offset in both bundles, traced it to unchanged
`src/ignore.ts`, and counted identical catch clauses. The source-change guard
passed without allowances or changes to the checker; generated bytes were
verified by the second build.

Optional external compiler/ctags oracle refreshes were not run; the quality
report includes their previously recorded results. Real-repository E2E tests
were run separately despite being skipped by the default unit-test command.
