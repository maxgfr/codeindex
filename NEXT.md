# Engine follow-up

The four previous priorities are implemented in the current working tree:

- Compiler-derived reference questions complement declaration questions. The
  benchmark reports precision/recall, empty/unavailable answers, latency and
  response volume separately for static codeindex, codeindex with LSP and Serena.
- MCP `concise: true` extends to references, callers, file symbol overviews and
  symbol indexes without changing default answers or result membership.
- `callers <name> --lsp` and MCP `callers` with `lsp: true` append incoming-call
  evidence, capability status and reasons for degradation. Multilanguage
  declarations are routed to their own configured servers.
- MCP initialization advertises available/active profiles. The existing
  playground lists the Node-only semantic/LSP variants with an explanation.

The engine remains a deterministic static indexer. Type-aware results depend on
an explicitly configured server and its project coverage. Reference occurrences
are not call edges; agreement differences are evidence to investigate, not proof
that one tier is correct. The controlled callers/impact/search tests are local
product checks and do not author the answer key for competitor comparisons.

See `docs/engine-validation-2026-09-07.md` for executed checks, measured reference
coverage, fixes, Docker validation and remaining limitations. New measurements
must retain corpus revision/tool versions and report unavailable measurements.
