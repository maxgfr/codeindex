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
steps S-010 to S-023, each with a test that failed first.
