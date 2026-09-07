# Engine validation — 2026-09-07

The engine passes the executed checks below after fixes to editing, memory
storage, MCP contracts, LSP transport/routing and the Docker distribution.
This validates the tested workflows; it is not a claim that static references
are semantically exact or that every supported language has compiler coverage.
The GitHub Pages work was limited to explaining unavailable browser commands.
No release or deployment was published.

Baseline: `272490846c871e8705b5074b024027aa7917a068`. Candidate: the working-tree
changes accompanying this report. Host: macOS, Apple M5, Node 24.19.0;
containers: Docker Desktop, Node 22, native `linux/arm64`.

Before pushing, release commit `99e74c6` (2.28.6) was integrated from `main`.
The bundles were regenerated; build, typecheck, all 1,405 default tests,
reproducible-build checks and both Docker runtime suites passed again.

## Defects reproduced and corrected

| Problem | Correction and regression evidence |
|---|---|
| Symbol editing corrupted UTF-16 and Latin-1 sources | Preserve original encoding, BOM and newline convention. Reject malformed UTF-16 and unrepresentable replacement text before writing. `tests/edit-encoding.test.ts` exercises byte round trips. |
| Memory paths could follow links outside the repository | Check storage components and leaf files; reject symbolic links and existing hard-linked leaves. Preserve normal repositories reached through a symlink. `tests/memory-boundary.test.ts` verifies outside bytes remain intact. |
| Targeted MCP callers violated its advertised output schema | Add the targeted response branch and enforce exactly one matching `oneOf` branch. `tests/mcp-output.test.ts` covers the actual transport response. |
| Benchmark path grading accepted ambiguous suffixes and differed from tests | Share one resolver/grader, reject ambiguity, retain bracket/dollar route filenames, deduplicate files. `tests/answer-benchmark.test.ts` and oracle tests exercise false positives and missing answers. |
| Benchmark smoke tests rewrote the tracked corpus during parallel tests | Use a temporary corpus through `CODEINDEX_ANSWER_CORPUS`. Retain prior unselected repository questions and provenance during bounded regeneration. |
| Qualified callers missed the first declaration stored under a bare key | Resolve `name@file` against declaration identity in both CLI and MCP. |
| LSP references used the first language server for multiple languages | Group declarations by configured server and open each with its own language. Mock protocol tests cover multi-server routing and failure. |
| A closed LSP stdin could cause an unhandled `EPIPE` | Route stream errors through transport exit handling. `tests/lsp-transport.test.ts` reproduces a real child closing its pipe. |
| TypeScript sessions could answer before semantic project loading | Document and exercise `initializationOptions.tsserver.useSyntaxServer: "never"` for short-lived TypeScript sessions. Real compiler-backed references pass through the shipped CLI. |
| Docker silently lost Git metadata/analytics | Include Git and trust the documented `/work` mount despite differing host ownership. Real committed fixtures now match host graph bytes, churn, coupling and delta. |

Encoding, memory, MCP schema, grading, qualified lookup, LSP routing/pipe and
Docker defects were reproduced before their respective fixes. Subsequent review
caught the hard-link case, which received its own failing regression before the
fix. These tests check public behavior and data integrity rather than snapshots
of implementation details.

## Implemented follow-ups

- Compiler-derived reference questions extend the benchmark with precision,
  recall, empty/unavailable answers, latency, response size and LSP agreement.
- `concise: true` covers MCP references, callers, symbol indexes and file
  overviews, preserving membership and confidence evidence. Default answers
  remain unchanged.
- `callers <name|name@file> --lsp` and MCP `callers` with `lsp: true` append
  incoming-call evidence and explicit capability/failure status. Artifact files
  remain unchanged by the LSP request.
- MCP initialization announces available and active profiles. The playground
  explains why semantic search and LSP need Node.

## Executed checks

| Check | Result |
|---|---|
| `pnpm build` and `pnpm typecheck` | Passed |
| `pnpm test` | 1,405 passed; 53 opt-in tests skipped; no unhandled errors |
| `pnpm run test:e2e` | 38 passed across pinned real repositories and distribution checks |
| `pnpm quality:report` | 177 passed; existing extraction baseline unchanged |
| Real TypeScript language server through CLI/MCP | 3 passed: incoming calls, concise calls, external-file references |
| External-oracle helper tests | 16 passed; 7 external refresh cases skipped |
| Controlled product scenarios | Direct callers, two-hop impact, search-to-impact and missing answers passed |
| Node 18.20.8 compatibility | Library import, CLI scan and search succeeded |
| Reproducible build with isolated Git index | Second Node/browser build byte-identical; user's Git index untouched |
| Docker bundle identity | Tested image engine matches the final generated engine bytes |
| Docker engine and real embeddings | All runtime checks below passed |
| Performance harness | Output equality assertions passed on all three identical input corpora |

The counts are separate suites and overlap; they must not be added together.
The default suite's opt-in skips include checks run separately above and other
external refreshes that were not run. Real LSP used
`typescript-language-server@5.1.3` and `typescript@5.9.3`, installed outside the
repository. The weekly E2E workflow now installs those pinned versions and runs:

```sh
CODEINDEX_TYPESCRIPT_LSP="$(command -v typescript-language-server)" \
  pnpm exec vitest run tests/lsp-real.test.ts
```

## Does it answer useful questions?

On `t3-oss/create-t3-turbo` at
`8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee`, the independent SCIP TypeScript
0.4.0 corpus gives these results:

| Question/tool | Exact | Partial | Wrong | Empty | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| 25 definitions, static codeindex | 25 | 0 | 0 | 0 | 100% | 100% |
| 25 reference questions, static codeindex | 20 | 4 | 1 | 0 | 90.5% | 96.0% |
| Same references, codeindex LSP | 8 | 3 | 0 | 14 | 44.0% | 34.6% |
| Same references, Serena 1.6.1 | 8 | 3 | 0 | 14 | 44.0% | 34.6% |

A reference answer is a set of files with non-definition occurrences of the
same compiler symbol, excluding its declaration file for every tool. Precision
and recall are macro means; empty answers count as zero. These occurrences are
not proof of calls. The LSP row grades only its LSP block, never static fallback.

The static tier finds most expected files here, but some homonyms are false
positives. For example, `Auth` finds `README.md` while the compiler expects
`packages/api/src/trpc.ts`. This remains a documented static-analysis limit.
LSP and Serena returned exactly the same file sets on all 25 questions, with
substantial cross-package gaps. LSP therefore remains optional evidence, not a
universal correctness switch. With TypeScript's default syntax-server fallback,
the initial short-lived LSP run returned 25 empty external-file answers;
disabling it produced the configured results above.

This refresh retains 50 prior definition questions for the other repositories
with their original provenance, yielding 100 stored questions total. Only the
50 t3 questions were freshly measured here. SCIP generated three empty
`tsconfig.json` files; every tool saw that same workspace and the raw report
records them. Tool/source provenance, configuration, all answers and agreement
sets are preserved in [the answer data](engine-validation-2026-09-07.answers.json).
Timing/token details are in [BENCHMARKS.md](../BENCHMARKS.md).

To rerun the answer scenario with installed competitor binaries, a configured
LSP server and the pinned workspace dependencies present:

```sh
CODEINDEX_LSP_CONFIG=/absolute/path/to/lsp.json \
  node scripts/bench/bench.mjs --repo t3-oss/create-t3-turbo --scenario answers
```

## Docker runtime validation

Both images were built locally, then run as uid 1000 with external networking
disabled. The repeatable smoke test creates its own fixture and removes its
containers afterward:

```sh
docker build -t codeindex:qa .
docker build -t codeindex-embed:qa docker/embed
node scripts/test-docker.mjs codeindex:qa codeindex-embed:qa
```

Engine checks cover AST spans, scan, cold index, warm reuse, search, callers,
MCP stdio and byte-identical host/container graphs with and without Git history.
Git churn, coupling and delta match host execution. The embedding image loads
its baked model offline and returns deterministic, finite, normalized vectors
of dimension 384. Empty batches, invalid JSON/types, size limits, HTTP 413/404
and health after rejected requests pass. Engine-to-embedding search asserts
`semanticSymbol` in a result, proving the semantic path executed successfully.

Tested image IDs:

- Engine: `sha256:975e7ea2e0ff8b2847311ab9c4b50295c1604f91c96dc1b142866b0882386885`
- Embeddings: `sha256:9d2a8583194cceb472f2e96557582b31dec3fdc873896e4c558154a0321d4287`

Native `linux/arm64` was tested. `linux/amd64` and published registry tags were
not executed. Local QA tags remain available; no image was published.

## Performance and limits of the audit

The [performance samples](engine-validation-2026-09-07.performance.json)
compare baseline and candidate on identical mini, codeindex and synthetic
corpora, using identical core grammars, one warmup and five samples. Graphs,
symbols, query answers and MCP response bytes match. The measurements ran
alongside other validation work and show mixed timing changes, including slower
cold/incremental samples. They do not establish a speed improvement or rule out
small regressions. This change does not claim a performance gain.

The ultraeval process structured baseline findings and independent reviews.
Its baseline score was 46/100 against a bar of 80, with three judges, two passing
calibration, and four verified findings including two critical data-integrity
issues. All three planted unsupported claims were rejected and three cache
mutations were caught by tests. That score concerns the original commit; it is
not a final score for these fixes. The closing evidence is the reproduced bugs,
regressions and runtime results above; no post-fix numerical regrading is claimed.

Source security review was targeted, without exhaustive fuzzing or a dependency
CVE refresh. Existing-link protections do not claim to eliminate races against
an actively hostile process replacing filesystem paths concurrently. Compiler
reference coverage remains TypeScript on one monorepo; the multilingual mock
LSP tests do not replace real-server coverage for every language. These limits
should guide further validation rather than being hidden by a passing score.
