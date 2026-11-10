# Code audit — November 2026

Audit of `@maxgfr/codeindex` at v2.31.16 (`a49cb7b`), followed by fixes. 19 commits:
12 bug fixes, 4 optimizations, 3 quality commits.

## Summary

1. The codebase is in good shape: strict TypeScript, 122 test files, a
   byte-reproducible build checked in CI, no shell injection, no hardcoded
   secret, `pnpm audit` clean. The baseline was green before any change.
2. The defects found sit at the edges: patterns and config a **cloned
   repository** controls (.gitignore globs, `.git/config`, workspace manifests),
   an **MCP client's** arguments, an older supported **Node**, and one extraction
   rule that produced **false call edges**.
3. 12 bugs are fixed, each with a regression test. Two could hang a scan or
   run a command from repository content alone; one silently disabled parallel
   extraction on Node 18.
4. 4 optimizations are measured between 3× and 90× on the paths they touch
   (C/C++ include resolution, scoped grep, Go impact, workspace check), all with
   byte-identical output.
5. 7 important issues are documented but **not** fixed, because each needs a
   design decision or touches deployment config. The largest is a second source
   of false call edges (calls on a literal or indexed receiver).

## Baseline (before any change)

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm run check:build` (bundles reproducible from source) | pass |
| `pnpm test` | 118 files passed, 4 skipped — 2221 tests passed, 1259 skipped (env-gated e2e/oracle suites) — 42.9 s |
| `pnpm audit` | no known vulnerabilities |
| `pnpm outdated` | majors only: typescript 5.9 → 7.0, vitest 4.1 → 5.1, tsup 8.5 → 9.0, @types/node 20 → 26, @semantic-release/{changelog,exec,git} |
| Lint | **none exists** — no ESLint/Biome/Prettier config in the repository |

After the changes: 119 files, 2260 tests passed, same skips; typecheck and
`check:build` pass. `scan` and `graph` output of the rebuilt CLI is
byte-identical to the baseline bundle on `tests/fixtures/mini-repo` and on
`src/`.

**A caveat on the measurements.** The machine was shared and heavily loaded
during the audit (load average 23 to 48). Timings below are therefore **CPU
time**, minimum of interleaved before/after runs in one process, not
wall-clock. The same load made tests in five files exceed their 5 s timeout
at one point or another; each file passes when re-run alone (see "Important"
below).

## Bugs fixed

Every fix has a regression test. How each defect was established:

- **Test run against the previous code, where it fails**: 2, 4, 6, 7, 12.
- **Reproduced directly**: 1 (timings), 5 (a marker file written by the
  repository's command), 8 (Node 18.20.8), 10 (the emitted pattern), 9 (the
  72k-character unit; the 8192 limit is the server's own constant).
- **Read in the code path, not run on the previous code**: 3, 11.

| # | Commit | Where | Issue | Fix | Test |
|---|---|---|---|---|---|
| 1 | `b651ab7` | `src/glob.ts`, `src/ignore.ts`, `src/workspaces.ts`, new `src/wildcard.ts` | **ReDoS.** Globs compiled to backtracking regexes: `a*a*…b` cost ×4 per extra star (245 ms at 8 stars, 985 ms at 9, for one 40-character path). Reachable from a committed `.gitignore`, a `workspaces` list, `--include/--exclude/--scope`, MCP `include`/`exclude`/`globs` and rules files — a cloned repository could hang every scan. | Patterns are kept as tokens. Up to two wildcards they compile to the same RegExp as before; beyond that they run as an NFA simulation (cost = pattern × subject). | `tests/wildcard.test.ts` — the two forms are compared on 8 000 generated cases; 30-star patterns answer under the 1 s budget |
| 2 | `29290e2` | `src/engine-cli.ts` | `cmd in COMMAND_FLAGS` accepted inherited keys: `codeindex toString --help` printed an empty help page and **exited 0**; `codeindex valueOf --limit 1` crashed. `mcp --help` exited 2 ("unknown flag") and `rewrite --help` exited 1 in silence, although the README promises help for every command. | `Object.hasOwn`; the help flag is read before `mcp` and `rewrite` parse their own arguments. | `tests/cli.test.ts` |
| 3 | `bae1f22` | `src/ast/grammars-pull.ts`, `src/embed/model.ts` | `grammars pull` **installed the wasm archive unverified** when the `.sha256` sidecar could not be fetched (the README says it is verified before anything is written). No download had a timeout; inflating the archive was unbounded. | Fail-closed when the target names a checksum; `AbortSignal.timeout` on every fetch (30 s checksum, 10 min archive/model); `maxOutputLength` on gunzip. | `tests/grammars-pull.test.ts`, `tests/embed.test.ts` |
| 4 | `b59f839` | `src/mcp.ts` | On `mcp --repo A --trust-lsp-config`, a call naming another `repo` had **that directory's** `.codeindex/lsp.json` read and its command spawned. | The flag covers the pinned repository only. | `tests/lsp-config.test.ts` (drives a real MCP session) |
| 5 | `19ac12e` | `src/util.ts`, `src/git.ts` | A repository-local `core.fsmonitor` names a command git runs on `ls-files` and `diff`: a directory arriving with its own `.git/config` got **a command executed by `codeindex scan`** (reproduced). Public `diffFiles`/`diffHunks` passed their merge-base to git unguarded, so `--output=/tmp/x` wrote a file. | Every git call overrides `core.fsmonitor=false`; option-like or missing bases are refused and `--end-of-options` is passed. | `tests/git.test.ts` |
| 6 | `d433078` | `src/lsp/client.ts`, `src/lsp/protocol.ts` | A server's own request (`workspace/configuration`, …) whose numeric id met one of ours **settled our request with `undefined`** — references came back empty. Server requests were never answered. `file:///repo/../etc/x` was accepted and returned as `../etc/x`. | A message naming a method is never a reply; server requests are answered; dot segments are resolved before the containment test. | `tests/lsp.test.ts` |
| 7 | `63870d9` | `src/lsp/{config,pool,client}.ts`, `src/embed/endpoint.ts` | A timeout above 2³¹−1 ms makes `setTimeout` fire after 1 ms: `CODEINDEX_LSP_TIMEOUT_MS=10000000000` timed every request out at once. | Budgets are capped at the maximum a timer takes. | `tests/lsp.test.ts`, `tests/lsp-config.test.ts` |
| 8 | `1f36c76` | `src/pool.ts` | The worker bootstrap used static `import` in an `eval` worker — a SyntaxError before Node 20.19 / 22.7. On **Node 18 (supported by `engines`) no worker started** and every index silently fell back to sequential. | CommonJS bootstrap with a dynamic `import()`. | `tests/pool.test.ts` (parses the bootstrap as a classic script) + run by hand on Node 18.20.8, 20.20.2, 22.23.2, 24.22.2: 0 worker-built records before on 18, 132/132 after on all four |
| 9 | `cec5633` | `src/embed/endpoint.ts` | The reference embedding server rejects a text over 8192 characters, and one rejected text failed the whole corpus build. A file-level unit joins every heading of a document (72k characters for a 1 500-release changelog), so **`search --semantic` always fell back to lexical** on such a repository. | Texts are cut to the limit before being sent. | `tests/endpoint.test.ts` |
| 10 | `08887cd` | `src/rewrite.ts` | Several `-e` patterns were joined as alternatives without renumbering groups: `-e '\(a\)\1' -e '\(b\)\1'` became `(?:(a)\1)|(?:(b)\1)`, which matches every `b`. | Such a command is declined (left to run as written). | `tests/rewrite.test.ts` |
| 11 | `dd0383b` | `src/browser/globals.ts` | The browser `Buffer.from(text, "utf16le")` encoded UTF-8, so a symbol edit on a UTF-16 file wrote UTF-8 bytes after a UTF-16 BOM. | `utf16le` (and aliases) implemented in `from` and `byteLength`. | `tests/browser-shims.test.ts` |
| 12 | `bb57265` | `src/ast/node.ts`, `src/bind.ts`, `src/types.ts` | The AST tier dropped a receiver whose name is not `[A-Za-z_]\w*`. `$el.render()`, `clicks$.subscribe()`, `this.#cache.get(k)` and Ruby's `@repo.save` were recorded as **bare calls** and bound to a same-file function of that name: a call edge to something never called. | The receiver is kept (`$` is part of the name; `#`/`@` sigils are dropped, as the regex tier reads them). `EXTRACTOR_VERSION` 18 → 19. | `tests/call-binding.test.ts` |

## Optimizations

All four leave output byte-identical (checked by the benchmark scripts, which
compare a digest of both sides' results).

| Commit | Change | Corpus | Before → after (CPU, min of interleaved runs) |
|---|---|---|---|
| `a8e62ec` | `resolveC` memoizes the include-root probe per spec instead of building one candidate path per `include`/`inc`/`src` directory for every `#include` | 3 000 C files, 600 include roots, 66 000 includes — graph build from a ready scan | **6 528 ms → 891 ms** (7.3×) |
| `6b02508` | A scoped grep on the JavaScript backend prunes the walk instead of walking the whole tree and filtering afterwards | same tree, one-directory scope | **68 ms → 21 ms** (3.2×); the remainder is worker start-up. ripgrep backend untouched |
| `4267211` | `closureOver` takes a Go package's importers once per closure instead of once per file of the package | one 3 000-file package, 500 importers — `impactOf` on the package | **98.7 ms → 1.1 ms** (~90×) |
| `82b89ec` | `packageOf` walks a path's ancestors through a map instead of testing every package directory as a prefix | 400 packages, 20 000 import edges — the lookups `workspaces --check` makes | **376 ms → 4.9 ms** (~77×) |

The corpora are synthetic (generated, deterministic). They show the algorithmic
gain on the shape that triggers it; a small or differently shaped repository
will see little or nothing.

**The project's own harness, baseline against this branch**
(`node scripts/bench/optimization.mjs <a49cb7b checkout> .`, 5 runs, Node 24.22).
It exits 0, which means `graph.json`, `symbols.json`, the `findReferences`
answer and the MCP answer have the same SHA-256 on both sides for all three
corpora. Wall-clock medians, in ms:

| Corpus | Cold index | Warm index | One file edited | MCP `find_references` |
|---|---|---|---|---|
| mini fixture (14 files) | 111 → 103 | 77 → 84 | 100 → 121 | 9.4 → 10.5 |
| codeindex source (466 files) | 1 091 → 1 024 | 142 → 132 | 375 → 329 | 24.3 → 20.2 |
| synthetic (200 files, 20 200 symbols) | 496 → 481 | 109 → 104 | 244 → 285 | 11.7 → 14.9 |

These move by up to 20 % in both directions, which is the load noise of the
machine, not an effect: none of the four optimizations is on these paths, and
none of the fixes shows up as a regression.

**Tried and dropped.** Moving the `STRICT` early return ahead of the homonym
copy in `src/bind.ts`: the whole graph build takes 54 ms on a 2 000-file
TypeScript corpus saturated with homonyms, so there was nothing to measure.

## Behavior changes to be aware of

Everything below is intended, but it is observable:

- **`grammars pull` fails when the checksum cannot be fetched** (decided with
  you). A `CODEINDEX_GRAMMARS_URL` mirror is still unverified, as documented.
- **Downloads time out** (30 s for the checksum, 10 min for the grammar archive
  and the embedding model). A link too slow for 10 min now fails instead of
  waiting.
- **`mcp --repo A --trust-lsp-config` no longer trusts another repository's
  `lsp.json`** (decided with you). An unpinned server still does — see open
  question 6. `CODEINDEX_TRUST_LSP_CONFIG=1` still trusts everything.
- **Call edges and call sites change** for receivers named with `$`, JS private
  fields and Ruby instance/class variables: those sites gain a `receiver`, and
  the false edges they produced disappear. `EXTRACTOR_VERSION` is 19, so an
  existing `.codeindex/cache.json` is re-extracted once.
- **Node 18 now really runs extraction workers** (above 200 files, as
  documented): faster, and it uses more threads than before.
- **git**: `core.fsmonitor` is disabled for the engine's own git calls;
  `diffFiles`/`diffHunks` return nothing for a missing or option-like base
  (they passed `undefined` or the option through to git).
- **LSP**: the client now answers a server's requests; a budget above
  2 147 483 647 ms is capped there.
- **Embedding endpoint**: a text longer than 8192 characters is cut before
  being sent.
- **`rewrite`** declines several `-e` patterns when one has a back-reference
  (exit 1, "run the original") instead of emitting a wrong pattern.
- **CLI**: `mcp --help` and `rewrite --help` print help and exit 0; a command
  named after an inherited property (`toString`, …) is an unknown command, exit 2.
- **Public surface (`engine.d.mts`), additive only**: `pullGrammars(…, { target })`,
  an optional `timeoutMs` on `fetchGrammarsTarball` and `fetchExpectedSha256`,
  an optional `cRootMemo` on `ResolveContext`, and `EXTRACTOR_VERSION = 19`.
  Glob and gitignore verdicts are unchanged.

## Issues found, not fixed

"Reproduced" means I ran it; "read" means I confirmed it in the code;
"reported" means a sweep flagged it and I did not verify it further.

### Critical

None.

### Important

1. **Calls on a receiver that cannot be named are recorded as bare calls**
   (reproduced). `'a,b'.split(',')`, `items[0].run()` and Python's
   `', '.join(parts)` are extracted with no receiver, so each binds to a
   same-file function called `split`, `run` or `join` if there is one — a false
   call edge, the same class as bug 12 but on literals, subscripts and
   parenthesised expressions (`src/ast/node.ts` `readReceiver`).
   *Recommendation:* a call whose callee is a member access must never be read
   as bare. Either drop such sites or give them a placeholder receiver. Not
   done here because it changes extraction output on every repository and the
   quality baselines (`site/quality.json`) with it — see open question 2.
2. **The extraction cache does not know which grammar build produced a record**
   (read). Reuse is keyed on `SCHEMA_VERSION`/`EXTRACTOR_VERSION` and on which
   grammar *keys* were loaded (`src/cache.ts` `extractedAlike`). The wasm
   grammars were re-vendored (`1a04b03`) with `EXTRACTOR_VERSION` unchanged, so
   after an upgrade unchanged files keep records parsed by the old grammar and a
   warm index can differ from a cold one. No divergence was observed; the key
   simply omits an input. *Recommendation:* record a digest of each loaded wasm
   in the extraction profile, or have the grammar re-pin workflow bump
   `EXTRACTOR_VERSION`. Not done: the freshness proof deliberately avoids
   loading grammars, and a digest changes that cost.
3. **An MCP `--repo` pin is not a boundary** (read; documented and tested as
   designed). A per-call `repo` overrides it for every tool, including the three
   symbol edits and the memory writes, and `--tools` profiles only hide tools —
   a hidden one is still callable. *Recommendation:* when a server is pinned,
   refuse a different `repo` for write tools at least — open question 3.
4. **`main-image.yml` republishes `:latest` from the commit before the version
   bump** (read). It runs after each successful Release and checks out
   `workflow_run.head_sha`, then pushes `:latest`, overwriting the image
   `release.yml` just built from the tag. `ghcr.io/maxgfr/codeindex:latest`
   then carries the previous `ENGINE_VERSION`. `site.yml` avoids this with
   `ref: main`. Deployment config — not touched.
5. **The embedding server is open on the network** (read).
   `docker/embed/server.mjs` listens on `0.0.0.0` with no authentication and no
   limit on concurrent requests; `embed serve --run` publishes it with
   `-p 8756:8756` (all host interfaces) from an unpinned `:latest`; and
   `docker/embed` has no lockfile, so each image build resolves
   `@xenova/transformers`' dependency tree afresh. *Recommendation:*
   `-p 127.0.0.1:8756:8756`, a pinned image tag, a committed lockfile.
6. **The MCP session cache is not filtered by extraction tier** (read).
   `getScanParallel` (`src/mcp/session.ts`) reuses in-memory records without the
   `compatibleEntries` check the CLI applies. If a grammar becomes available
   while a server runs (`grammars pull` in another terminal), new and edited
   files are extracted at the AST tier and unchanged ones stay at the regex
   tier until restart.
7. **No linter, and the suite is sensitive to machine load.** There is no lint
   step, so unused imports and unreachable branches are only caught by review.
   Many tests spawn the CLI under vitest's default 5 s timeout: under load,
   `query-surfaces`, `endpoint`, `grep`, `delta` and `navigation` each had a
   test time out once, and each file passed when re-run alone. *Recommendation:* add a linter (Biome is enough), and
   raise the timeout for the CLI-spawning suites.

### Minor

- **grep**: a search worker that dies (out of memory) is only noticed at the
  deadline and reported as "timed out", and MCP `grep.timeoutMs` has no
  maximum, so a client can block the server for as long as it asks (read). The
  ripgrep and JavaScript backends search different files in a repository that
  holds nested repositories or sits under a parent `.gitignore` (reported).
- **walk**: a directory that cannot be read is skipped without a `skip` entry,
  while unreadable files are reported (reported). A file unreadable at index
  time is kept as an empty record until it is edited (reported). The containment
  test builds `root + sep`, which is wrong when the root is `/` or a drive root
  (read).
- **`.gitignore`**: a pattern that does not compile (`[z-a]`) is dropped in
  silence, so files git would ignore are indexed (read).
- **MCP endpoint embeddings**: the in-session index is rebuilt without a model
  id, so vectors of two models can mix if the model behind the URL changes
  during a session; the CLI passes `endpointModelId()` (read).
- **Path arguments**: `--include /src/**` matches nothing in `scan` while `grep`
  strips the leading `/`; `impact src/../a.ts` fails on the CLI but resolves
  over MCP (reported).
- **CLI flags**: global flags a command does not read are accepted in silence
  (`grep --max-files 5`); `mcp --max-response-bytes 1.5` is accepted although
  number flags are documented as whole numbers; `--tools ","` advertises zero
  tools without an error (reported).
- **Edits**: `atomicWrite` resolves the target at write time, so a file swapped
  for a symlink between scan and edit is followed (read; needs local write
  access racing the edit).
- **Robustness of inputs the engine writes itself**: `parseEmbedModel` allocates
  `vocab × dim` before validating either; `freshness.json` keys are not
  path-checked as `cache.json`'s are; `readMemory` reports a refused symlink as
  "no memory named …" (reported).
- **Embedding server**: a rejected model-load promise is cached forever (every
  later request answers 500), and there is no SIGTERM handler, so `docker stop`
  waits out the grace period (reported).
- **Pair keys**: file pairs are joined with `|`, so a path containing `|` can
  collide or mis-split in `derived.ts`, `calls.ts`, `graph.ts` (reported).
- **Performance, not measured here**: `findReferences` regex-scans all retained
  doc text per query; `bm25` counts document frequency by scanning every
  document per term; a shared tsconfig base is re-parsed for each config
  extending it; `delta` rebuilds the resolve context for `brokenImports`; the
  Ruby, PHP and Lua resolvers probe every root per import, as C did.
- **CI**: the Node 18 smoke job only runs the mini fixture, below the 200-file
  threshold, which is why bug 8 went unseen. A forced `--workers 2` run there
  would have caught it. Whether `feat!:` yields a major release with the default
  commit-analyzer preset is worth checking (not verified).
- **Stale notes**: `scripts/fetch-grammars.mjs` says web-tree-sitter 0.26 cannot
  load the Dart grammar; the dependency is now 0.27 and the claim is worth
  re-testing.
- **Dependencies**: only major upgrades are pending (table above). None was
  applied: each is a toolchain migration, not a fix.

## Open questions

1. **Line count.** `"a\n"` is counted as 2 lines (`src/scan.ts`), a value
   persisted in `graph.json` and used by hotspot ranking. Intended, or an
   off-by-one? Changing it changes output bytes.
2. **Unnameable receivers** (important issue 1): drop those call sites, or keep
   them with a placeholder receiver? The first loses name-only matches in
   `callers --recall`; the second adds a new value consumers will see.
3. **Pinned MCP server**: should a per-call `repo` different from the pin be
   refused for write tools (edits, memory)? It breaks a test that documents the
   override (`tests/mcp.test.ts`).
4. **`embed serve --run`**: bind to `127.0.0.1` by default? It removes LAN access
   for anyone relying on it.
5. **`--include /abs/path`**: is a leading `/` an absolute path (today, in
   `scan`) or a root anchor (today, in `grep`)?
6. **`mcp --trust-lsp-config` without `--repo`** still trusts the config of
   whichever repository a call names — there is no pinned one to restrict it
   to. Should the flag require `--repo`, as `--watch` does?
7. **Grammar re-pins and the cache** (important issue 2): a wasm digest in the
   extraction profile, or an `EXTRACTOR_VERSION` bump in the re-pin workflow?
