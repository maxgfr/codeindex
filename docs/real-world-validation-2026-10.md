# Real-world validation — 2026-10

Every CLI command and every one of the 40 MCP tools was run against 19 public
repositories pinned by commit, covering 13 language families. The answers were
compared with what independent tools say they must contain: `git`, `ripgrep`,
`git check-ignore` and a protobuf reader. This report lists what that campaign
found and how each finding was classified.

Baseline: `d15d835` (2.31.5). Host: macOS, Apple Silicon, Node 24.19.0,
git 2.x, ripgrep 14.

## Corpus

The seven repositories of the existing build ratchet, plus twelve pinned on
2026-10-12, each chosen as an independent proof for a language family the
engine claims. None of them was used to design a resolver.

| Repository | Language | What it exercises |
|---|---|---|
| socialgouv/code-du-travail-numerique | TypeScript | Yarn workspaces, Next.js app dir |
| t3-oss/create-t3-turbo | TypeScript | Turborepo + pnpm, conditional `exports` |
| nrwl/nx-examples | TypeScript | Nx, root `tsconfig.base.json` aliases |
| pallets/flask | Python | src layout, package imports |
| gin-gonic/gin | Go | module-rooted imports |
| BurntSushi/ripgrep | Rust | cargo workspace |
| spring-projects/spring-security | Java + Kotlin | large Gradle multi-project |
| sinatra/sinatra | Ruby | bare `require` across lib roots |
| jbogard/MediatR | C# | namespace `using` across projects |
| jqlang/jq | C | quoted includes, vendored libraries |
| fmtlib/fmt | C++ | `include/fmt` headers, `.h` read as C++ |
| vuejs/pinia | Vue + TypeScript | pnpm monorepo, VitePress docs |
| sveltejs/realworld | Svelte | SvelteKit `$lib` alias, generated `./$types` |
| slimphp/Slim | PHP | composer PSR-4 |
| square/okhttp | Kotlin | Gradle multi-project, mkdocs docs |
| open-telemetry/opentelemetry-go | Go | nested modules |
| elixir-plug/plug | Elixir | module aliases |
| folke/lazy.nvim | Lua | `require` onto `lua/` |
| com-lihaoyi/os-lib | Scala | Mill layout, `src-2`/`src-3` |

The catalog, with each pin and the dangling ratio measured at it, is
`tests/real-repos.ts`.

## Method

`tests/e2e-commands.test.ts` (opt-in: `pnpm test:e2e:commands`) builds each
repository's index once, then runs every command of `codeindex --help` and every
MCP tool through one `codeindex mcp` session. It runs the built CLI, the surface
users get.

Every call is held to five invariants: the expected exit code, valid JSON on
stdout where JSON is promised, no stack trace on stderr, byte-identical output
on a second run, and the repository's time budget. MCP answers must also stay
under the server's `--max-response-bytes` on the wire.

Per repository, the oracles in `tests/oracles/real-world.ts` check:

| Command | Compared with |
|---|---|
| `scan` | `git ls-files -co --exclude-standard`: every file git would build is indexed or skipped with a reason; nothing `git check-ignore` ignores is indexed |
| `grep` (literal) | the hits of `rg -F` on the indexed files |
| `refs` | every referencing file contains the name as a word (`rg -lw`); recall is reported |
| `callers` | its files are a subset of `refs` |
| `impact` | it contains every direct importer in graph.json |
| `delta --base HEAD~5` | `git diff --name-only` |
| `churn` | an independent parse of `git log --numstat` over the same window |
| `workspaces` | every manifest exists on disk |
| `scip` | it decodes, and `project_root` is a valid URI that round-trips to the repo |
| `mermaid` | no raw angle bracket or unbalanced quote in a label |
| `outline` / `symbol_at` / `find_symbol` | the three agree on every declaration of the most-imported files |
| symbolic edits | replacing a declaration with its own body leaves the file byte-identical |

`tests/adversarial.test.ts` complements it with a synthetic corpus that runs in
CI: inputs that cost seconds to minutes, or came out wrong, before this campaign.

## Findings

Each finding is one of three things. A **bug** gets a failing test reduced to a
minimal fixture, then a fix. An **oracle false positive** is a defect of the
check, corrected in the oracle. A **documented limit** is a known boundary of a
static, build-system-free indexer.

### Bugs

| Finding | Seen on | Step |
|---|---|---|
| An MCP answer with `structuredContent` goes out at about 1.8× its text, past `--max-response-bytes` (`impact` on spring-security: 1.6 MB against a 1 MB cap) | spring-security | S-020 |
| A quoted include of a C standard header with no local copy (`#include "stdio.h"`) is reported dangling; the compiler falls back to the system headers | jq | S-101 |
| SvelteKit's `$lib` alias is never resolved, and the generated `./$types` module is reported dangling: 41% of realworld's edges dangle and no `$lib` import reaches `src/lib` | sveltejs/realworld | S-102 |
| GFM footnote definitions (`[^2]: Trivial changes…`) are read as link reference definitions, giving dangling links to `Trivial`, `Jonathan`, `[Emit` | opentelemetry-go | S-103 |
| A markdown link to a file that exists but is not indexed (an image) is reported as a missing target | okhttp, sveltejs/realworld | S-104 |
| `tests/index-cache.test.ts` compares a realpath with a tmpdir path and fails on macOS, where `/var` is `/private/var` | baseline run | S-105 |

### Oracle false positives

| Finding | Correction |
|---|---|
| A directory symlink is one blob to git and one `directory-symlink` skip to the walk | the oracle matches the skip by its exact path |
| An uninitialised submodule is a gitlink and an empty directory | gitlinks (mode 160000) leave the git file list |
| `find_symbol` was capped at 500 matches while fmt declares more than 500 `TEST` macros | the round trip asks for every match |
| `delta` lists a changed lockfile under `unindexed`, not `changes` | the oracle reads `changes`, `unindexed` and `deleted` |

### Documented limits

| Finding | Why it stays |
|---|---|
| `#include "gtest/gtest.h"` (fmt) and `decNumber/decNumber.h` (jq) dangle | they resolve through `-I` directories that live in CMake or Make files; the engine reads no build system |
| VitePress root-absolute links (`/core-concepts/index.md` in pinia's docs) dangle | they are relative to the docs site root, which only the site configuration knows |
| Generated files (`api/typedoc-sidebar.json`, `vendor/autoload.php`) dangle | they do not exist in the checkout |
| gtest `TEST(suite, name)` blocks are declarations named `TEST` | the C++ grammar parses a macro invocation with a body as a function definition |

## Audit defects

The 64 defects found by reading the code before the campaign are fixed in
steps S-010 to S-023, each with a test that failed first: LSP config trust and
git hardening, the quadratic and cubic paths, cache reuse, thread-independent
extraction, gitignore semantics, import resolution, graph and diff semantics,
analyses and search, embeddings, the CLI argument contract, MCP limits and
response size, rendering, and tooling.

## After the fixes

| Check | Result |
|---|---|
| `pnpm typecheck`, `pnpm test` | pass — 2,198 tests (the baseline had 2 failing on macOS: a French-locale git message and a `/private/var` path, S-010 and S-105) |
| `pnpm test:e2e:commands` | 1,140 of 1,140 on the 19 repositories; the only notes left are report-only `refs` recall misses (a Jest snapshot and a `package.json` naming the symbol as text) |
| `pnpm test:e2e` | 98 of 98 |
| `pnpm check:build` | the committed bundles are byte-reproducible |
| `pnpm quality:report` | identical to the baseline |
| `tests/adversarial.test.ts` | every case green; before the fixes, 100k blank lines of Rust took 10 s, one line of 120k calls 20 s, a 30 MB LSP response read in 16 KB chunks 5 s |

Dangling ratios at the pins, before and after:

| Repository | Before | After | Why |
|---|---|---|---|
| sveltejs/realworld | 11/27 (40.7%) | 0/44 | `$lib`, `./$types`, a README image |
| jqlang/jq | 12/259 (4.6%) | 5/252 (2.0%) | quoted libc headers; the rest are generated `.inc` files and `-I` vendor paths |
| open-telemetry/opentelemetry-go | 16/6,844 | 0/6,835 | footnotes |
| square/okhttp | 6/6,032 | 1/6,028 | images; the one left is a link to a file that is not there |
| vuejs/pinia | 24/830 | 24/793 | unchanged links; 37 cross-language or imported-name `use` edges left |

Every ratchet in `tests/real-repos.ts` was re-pinned to the measured value.

Performance, measured with `scripts/bench/optimization.mjs` (2.31.5 against
this branch, same source bytes, 5 runs per mode, run twice): on the repository
itself and the synthetic corpus, cold, warm and incremental index, query and
MCP times moved within ±10% with mixed signs between the two runs. On the
14-file mini fixture the harness showed warm and incremental index 8–59%
slower, but a direct A/B of the same operations (10 runs each, twice) gave
72.9/75.7 ms against 77.2/73.6 ms warm and 114.0/100.8 ms against 113.1/101.4 ms
incremental, within noise. A `refs` query on that fixture costs 1.6 µs instead
of 0.9 µs (the `$`-aware mention boundary); on the larger corpus it is 16%
faster.
