# What is left, and why each piece is worth doing

Written to be handed to a planning session as-is. Every item below came out of
actually running the answer-quality benchmark against Serena 1.6.1 and Graphify
0.9.26 on 2026-08-12, not from imagining what might be missing.

**State of play.** The comparison table in the README now names a winner per
row. codeindex takes eight of them; ctags takes cold-index speed at every size,
install footprint and (with Serena) language coverage; Serena takes type-aware
references. The single row we were losing on payload — tokens per answer — was
closed by `find_symbol`'s `concise` flag: 25/25 at 35 tokens against Serena's
48, with the default left where it was.

The four items below are ordered by how much they change what an agent can
actually do, not by effort.

---

## 1. Benchmark the questions agents actually ask — not just find-symbol

**The gap.** The whole answer-quality benchmark asks one thing: *where is X
declared*. That is the easiest question in the set and the one a flat tags file
can nearly answer. The questions that decide whether a tool is useful to an
agent are the other three:

- *who calls X* — `find_references` / `callers`
- *what breaks if I change X* — `impact`, the blast radius
- *which files do I touch to do Y* — search plus the graph

None of them is measured. And the honest reason to write this test is not that
it flatters us: it is the test where **Serena should win**, because its
references are type-aware and ours are static. If our LSP tier is worth having,
this is the measurement that shows it; if it is not, this is the measurement
that says so.

**What to build.**

- Extend `tests/oracles/answers.ts` with a second case kind. scip-typescript's
  index carries `relationships` and per-occurrence roles, so "every file that
  references X" is derivable from the same authority already in use — no new
  oracle, no new trust assumption.
- A reference question needs a different grade than a location question:
  precision AND recall, not one file. Reuse the `correct`/`incomplete`/`wrong`
  vocabulary or replace it deliberately, but do not silently reuse a grader
  built for a single-answer question on a multi-answer one.
- Ask each server three ways: codeindex static, codeindex `lsp: true`, Serena.
  The `agreement` matrix the LSP tier already returns (`both` / `lspOnly` /
  `staticOnly`) is exactly the per-question evidence this benchmark needs, so
  wire it into the report rather than recomputing it.
- Extend the `answers` scenario in `scripts/bench/bench.mjs`; the harness,
  client, adapters and priming already exist.

**Definition of done.** A table in BENCHMARKS.md with a references row per
server, and a sentence in the README that is true whichever way it comes out.

---

## 2. Let the caller choose the payload everywhere, not just `find_symbol`

**The gap.** `concise` proved the principle on one tool and cut its answers by
2.5×. The same waste is in every other read tool: `find_references` returns full
`CodeSymbol` records for every definition, `callers` returns every call site with
its enclosing symbol, `symbols_overview` returns signature, span, visibility and
language for every declaration in a file. An agent resolving a path pays for all
of it, on every turn.

**What to build.** A single `concise` option with the same meaning across
`find_references`, `callers`, `symbols_overview` and `symbols` — the locating
fields only. One name, one meaning, or it becomes four flags nobody remembers.

**The constraints that make it safe**, all already established by `concise` on
`find_symbol`:

- The default does not move. Every existing consumer sees the bytes it saw.
- It changes the payload, never the result set. `tests/phase2.test.ts` has the
  shape of that test: assert the same declarations come back, then assert the
  payload shrank.
- The published benchmark keeps reporting defaults. A benchmark retuned to its
  own tool is not a benchmark.

**Worth measuring afterwards**: total tokens for a realistic agent trajectory
(orient → find → check references → edit) with and without it. That number is
the actual answer to "efficient for an AI", and nobody has it.

---

## 3. Extend the LSP tier to `callers`

**The gap.** The tier covers `find_references` and `find_symbol`. `callers` —
the tool agents lean on for impact analysis — is still static, and it is the one
where a homonym costs the most: a wrong caller list sends an agent to edit the
wrong file.

**Why it was deliberately left out**, and what has to change: LSP has no
primitive that maps onto `CallerIndex`. `callHierarchy/incomingCalls` needs a
`prepareCallHierarchy` per symbol and has much thinner server coverage than
`textDocument/references`. So it must be **capability-gated** — `lspStatus`
already reports `typeHierarchy`, and the same probe should report call hierarchy
— and it must degrade to the static index exactly as the current tier does.

**Do not skip**: the boundary test. `tests/lsp-boundary.test.ts` proves nothing
under `src/lsp/` is reachable from `src/pipeline.ts` by building this repo's own
graph. Any new wiring has to keep that green, and it is the reason the "cannot
change graph.json bytes" guarantee is structural rather than a promise.

---

## 4. The playground offers less than the CLI, silently

**The gap.** It is the shop window — the link in the README badge — and it has
no semantic search and no LSP tier. Both are Node-only for good reasons. What is
wrong is not the absence; it is that the palette does not say so. `commands.js`
already has the vocabulary for this: `churn`, `coupling`, `hotspots`, `risk`,
`delta` and `embed` are listed-but-disabled *with a stated reason*. `search
--semantic` and the LSP tier should be listed the same way, rather than being
invisible.

**Smaller, same spirit**: `--tools` profiles cannot be discovered from inside an
MCP session — a client cannot ask what profiles exist. One line in the
`scan_summary` or `lsp_status` response, or a profile list in the server's
`instructions`, would fix it.

---

## Known corpus gap, for whoever regenerates it

`nrwl/nx-examples` is absent from `tests/quality/answer-cases.json` and the
generator says why on stderr rather than quietly producing a narrower corpus:
its dependency install fails under both yarn (corepack refuses the download) and
npm (`workspace:*` protocol unsupported), so scip-typescript cannot type-check
it and no compiler-derived question exists for it. Either pin a fourth
TypeScript repo that installs cleanly, or teach `ensureDeps` to try `pnpm` first
for repos whose lockfile says so — `tests/oracles/external-diff.ts` already has
the attempt ladder.

Regenerate with:

```sh
CODEINDEX_ANSWERS=1 pnpm vitest run tests/answers-oracle.test.ts
node scripts/bench/bench.mjs --scenario answers
```

## One thing to keep

The comparison table is credible because it names the rows we lose. Whatever
gets added next, the rule that has to survive is the one already written into
the benchmark: **this project does not author the answer key to a table this
project appears in.** Every question comes from scip-typescript, every grader is
identical across servers, and every absent measurement says "not measured"
rather than nothing.
