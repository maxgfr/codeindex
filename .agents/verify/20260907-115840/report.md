# PASS — verify light

Execution: native Codex subagents for the verification matrix, correctness,
failure handling, wiring, plan conformance, Node 18 gates and independent
refutation; primary agent ran the repository gates and benchmarks.

Baseline: `f75f828893a9017d90a65bf1ecd5963dd1bb5139`. Promise: the approved
conversation plan “Fiabiliser et optimiser codeindex”. Tracked changes and
whole-file additions were included. No source changes existed at the start.

This tier does not include the deep adversarial audit or a second-vendor review.
Executed repository E2E tests and benchmarks provide additional behavior
evidence; the skill's separate isolated behavior lane was not run.

## Evidence

| Command | Exit | Evidence |
|---|---:|---|
| `pnpm install --frozen-lockfile` | 0 | `Done in 1.2s using pnpm v10.33.0` |
| `pnpm typecheck` | 0 | `tsc --noEmit` |
| `pnpm build` | 0 | Node/browser build and declaration generation succeeded |
| `pnpm exec vitest run tests/cache-validation.test.ts` before the fix | 1 | 39 failed, 3 passed; expected regression proof |
| `pnpm exec vitest run tests/cache-validation.test.ts tests/preload.test.ts tests/derived.test.ts tests/phase2.test.ts` after the fix | 0 | 103 passed |
| `pnpm test` on the final implementation | 0 | 69 suites passed, 2 skipped; 1,335 tests passed, 50 skipped |
| `pnpm quality:report` | 0 | 177 passed |
| `pnpm run test:e2e` | 0 | 38 passed |
| `GIT_INDEX_FILE=/tmp/codeindex-opt-NYjPpV/build.index pnpm run check:build` | 0 | Build succeeded; artifact diff empty |
| `pnpm dlx node@18 --input-type=module -e 'import("./scripts/engine.mjs").then(m => { if (typeof m.scanRepo !== "function") process.exit(1); console.log("Node18 library import OK") })'` | 0 | `Node18 library import OK` |
| `pnpm dlx node@18 scripts/cli.mjs scan --repo tests/fixtures/mini-repo --out /tmp/codeindex-opt-NYjPpV/node18-scan.json` | 0 | Nonempty output verified by `test -s` |
| `pnpm dlx node@18 scripts/cli.mjs search client --repo tests/fixtures/mini-repo --out /tmp/codeindex-opt-NYjPpV/node18-search.json` | 0 | Nonempty output verified by `test -s` |
| `node scripts/bench/optimization.mjs /tmp/codeindex-opt-NYjPpV/baseline /Users/maxime/Downloads/codeindex` — two comparable sessions | 0 | Output equality passed for all three corpora |
| `git diff HEAD -- src tests scripts/bench \| node /Users/maxime/.agents/skills/verify/scripts/forbidden-repairs.mjs --include-untracked --pretty` | 0 | `CLEAN`, no allowances |

The temporary build index was initialized from HEAD, then populated with the
newly built bundles and grammars. The command therefore checked a second build
against the candidate artifacts. The real Git index was left untouched.

## Findings and requirements

No surviving regression findings. One generated-code guard alert was refuted.
The three defect-review lenses found no additional concrete candidates.

Requirements: 12/12 implemented. Shared validation, complete existing record
types, whole-cache fallback, optional legacy fields, indexed lookup, result
compatibility/ownership, three comparable corpora, all requested metrics, five
samples after warmup, generated artifacts/documentation, deterministic build
and Node 18 compatibility, unchanged public APIs and schemas.

Performance and raw measurements:
[report](../../../docs/optimization-2026-09-07.md) and
[samples](../../../docs/optimization-2026-09-07.json).

## Refutation and residual risk

The full-diff forbidden-repair guard exited 1 on `scripts/engine.browser.mjs:2`.
Its `error-swallow` match is an empty catch at character offset 13909 in BOTH
baseline and candidate. It maps to unchanged `src/ignore.ts:114–118`.
Independent TypeScript AST inspection found 85 catches, 15 empty, in each
bundle, with no parse errors. Identifier renaming changes the long minified
line, which the line-based guard treats as wholly new. No new swallowed error
was introduced. The guard was not edited or given an allowance; source changes
were scanned separately and generated bundles passed the reproducible build.

An initial benchmark failed its equality assertion because only the candidate
had extended grammars installed. The harness was corrected to use the same
baseline grammar directory for both versions. Both subsequent sessions passed.

The full default test run intentionally skips opt-in scenarios; its real-repo
E2E subset was then executed separately. External compiler/ctags oracle results
were not refreshed. No memory or broad MCP latency reduction is claimed.
Persisted-cache validation adds several milliseconds to warm CLI indexing;
in-process reference computation is about 2× faster on codeindex. No publishing,
deployment, commit, or push was performed.
