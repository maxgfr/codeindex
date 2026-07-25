// Deterministic rendering. The orchestrator hands over a plain data report
// (rows already ordered); this module owns ALL formatting and rounding so the
// structure — section order, columns, cell shape — is byte-stable across runs.
// Only the millisecond values and the Environment block vary between sessions,
// and Environment is explicitly outside the reproducibility scope.

// A cell is { v, k, runs? }. `v` is a number, a string, or { na: reason }.
// `k` selects the formatter. `runs` (timing cells only) annotates a per-cell run
// count when it was auto-downgraded below the session nominal. `na(reason)`
// builds a complete unavailable cell.
export function na(reason) {
  return { v: { na: reason } };
}

function isNa(v) {
  return v && typeof v === "object" && "na" in v;
}

function fmtBytes(v) {
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function fmtCell(c, nominalRuns) {
  const v = c.v;
  if (isNa(v)) return `n/a (${v.na})`;
  switch (c.k) {
    case "ms": {
      const base = String(Math.round(v));
      return c.runs && c.runs !== nominalRuns ? `${base} (${c.runs}×)` : base;
    }
    case "int": return String(v);
    case "ratio": return Number(v).toFixed(1);
    case "bytes": return fmtBytes(v);
    case "bool": return v ? "yes" : "no";
    case "text": default: return String(v);
  }
}

function table(headers, rows, nominalRuns) {
  const lines = [];
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    lines.push(`| ${row.map((c) => fmtCell(c, nominalRuns)).join(" | ")} |`);
  }
  return lines.join("\n");
}

// Hand-written methodology & fairness prose, embedded here so `--write`
// regenerates BENCHMARKS.md idempotently (it previously lived only in
// BENCHMARKS.md and was lost on every --write). Emitted verbatim between the
// intro paragraph and the first measured section. The "Notes on specific
// cells" subsection is session-specific by nature — update it HERE when a
// new measurement session changes those facts.
const METHODOLOGY = `## Methodology & fairness

The tools compared here are architecturally different, not just differently
tuned, so every comparison below is between specific *operations*, never a
vague "codeindex vs tool X":

- **Two query modes for codeindex, on purpose.** \`find-symbol in-proc\` /
  \`references in-proc\` / \`caller-index in-proc\` time a single API call
  against an already-loaded warm scan — the number a long-running host
  process (MCP server, editor plugin) actually pays per query. \`full-index
  spawn\` times a full \`codeindex symbols\` CLI invocation: Node startup, a
  cold \`buildIndexArtifacts\`, and serialization of the *entire* symbol table —
  it is **not** a single-symbol lookup and must never be read as one. It is
  included so a one-shot CLI caller can see that cost too.
- **ctags wins the small cold builds; the ranking flips as the repo grows.**
  universal-ctags emits a flat \`tags\` file with \`-R\`, and on a small repo it
  beats codeindex's richer graph+symbol artifacts by an order of magnitude —
  at that size codeindex is mostly paying Node startup and its wasm grammar
  load, and there is not enough work to spread across cores. On the largest
  repo measured here (\`vercel/next.js\`, ~20k indexed files) codeindex comes
  out ahead, because extraction is distributed over worker threads while a
  ctags pass is not. Read the Cold index table for where the crossover falls
  on your own repo size; either way ctags produces no call graph, no
  references and no MCP-servable structure, so this is a comparison of two
  different jobs, not a like-for-like race.

### MCP servers (Serena, Graphify): task equivalence

The two MCP competitors answer the same three tasks — find-symbol,
references, file-overview — but not with the same machinery, so the mapping
is pinned here and must be read alongside the MCP sessions / MCP token
economy tables:

- **Same transport, same client, for everyone.** All three servers (codeindex
  included) are driven over the same newline-delimited JSON-RPC 2.0 stdio
  transport by the same client (\`scripts/bench/mcp-client.mjs\`), one tool
  call per session — graphify's server drops still-queued responses at stdin
  EOF, so the one-call-per-session policy is applied to all servers for
  symmetry.
- **Task equivalence, pinned.** find-symbol = serena \`find_symbol\` /
  graphify \`get_node\` / codeindex \`find_symbol\`. references = serena
  \`find_referencing_symbols\` / graphify \`get_neighbors\` (incoming
  calls/imports edges) / codeindex \`find_references\`. file-overview = serena
  \`get_symbols_overview\` / codeindex \`symbols_overview\`; graphify has no
  file-level equivalent (its file nodes are keyed by basename, collision-prone
  on real repos), so that cell is n/a by design.
- **Graphify's granularity is looser.** Its nodes are label-matched
  (case-insensitive, tolerant) and \`get_neighbors\` returns graph edges, not
  source locations — a coarser notion of "references" than the other
  tools' answers. Its cells are comparable as task outcomes, not as
  equal-precision results.
- **LSP precision cuts the other way.** serena's answers come from live
  language servers and are semantically precise (type-aware references);
  codeindex and graphify are static/syntactic. Where serena is slower, part
  of that time is buying precision the others do not claim — the timing
  tables cannot capture that asymmetry.
- **Activation and downloads are excluded from per-call numbers.** One-time
  installs and serena's per-language language-server downloads are never
  timed; activation (spawn -> ready) is measured separately in the MCP
  sessions table, and each server's index/parse cost lives in Cold index.

### Token-economy caveat

The token-economy scenario's \`grep lines\` column locates symbol occurrences
with a plain **substring** match over the raw repo text. A short, common
identifier — e.g. Go's \`New\` in \`gin-gonic/gin\` — will match inside unrelated
tokens and non-symbol lines, inflating the grep-side line count (and therefore
the token estimate). This bias makes the naive-grep baseline look *more*
expensive than it truly is, so the absolute \`grep lines\` / token counts for
common short names should be read as an upper bound, not an exact figure.`;

export function renderMarkdown(report, env) {
  const out = [];
  out.push("# codeindex — competitor benchmarks");
  out.push("");
  out.push(
    "Reproducible harness (`scripts/bench/`) comparing codeindex against " +
      "universal-ctags, Serena (LSP over MCP) and Graphify. Timings are the " +
      `median of ${report.nominalRuns} runs with one warmup discarded; a cell reading ` +
      "`n/a (reason)` means that tool was not measurable in this session.",
  );
  out.push("");
  out.push(METHODOLOGY);
  out.push("");
  for (const s of report.sections) {
    out.push(`## ${s.title}`);
    if (s.note) {
      out.push("");
      out.push(`_${s.note}_`);
    }
    out.push("");
    out.push(table(s.headers, s.rows, report.nominalRuns));
    out.push("");
  }
  out.push("## Environment");
  out.push("");
  out.push("_This section records the measurement machine and session date; it is explicitly OUTSIDE the reproducibility scope._");
  out.push("");
  out.push(`- Node: ${env.node}`);
  out.push(`- CPU: ${env.cpu}`);
  out.push(`- RAM: ${env.ram}`);
  out.push(`- Date: ${env.date}`);
  out.push("");
  return out.join("\n");
}

// Same data, machine-readable, for site/benchmarks.json. Each cell keeps both a
// stable `display` string and the raw value so downstream charts need no reparse.
export function renderJson(report, env) {
  const cellJson = (c) => {
    if (isNa(c.v)) return { display: `n/a (${c.v.na})`, na: c.v.na };
    return { display: fmtCell(c, report.nominalRuns), value: c.v, kind: c.k, ...(c.runs ? { runs: c.runs } : {}) };
  };
  return {
    generatedAt: env.date,
    environment: { node: env.node, cpu: env.cpu, ram: env.ram, date: env.date },
    nominalRuns: report.nominalRuns,
    sections: report.sections.map((s) => ({
      id: s.id,
      title: s.title,
      note: s.note ?? null,
      headers: s.headers,
      rows: s.rows.map((row) => row.map(cellJson)),
    })),
  };
}
