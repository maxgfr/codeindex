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

The two tools are architecturally different, not just differently tuned, so
every comparison below is between specific *operations*, never a vague
"codeindex vs 01x":

- **Different models.** codeindex renders static, byte-stable artifacts
  (\`graph.json\` / \`symbols.json\` / \`cache.json\`) once per build; 01x-in
  maintains a live SQLite database (\`.codeindex/\`) that its CLI opens on every
  invocation. Neither model is a strict subset of the other — see
  Determinism and Index size below for what that costs each of them.
- **01x's cold init shells out to ast-grep per file.** Its \`init\` command
  spawns the external \`ast-grep\` binary once per source file to extract
  symbols; that process-spawn overhead is *inside* every 01x cold-init number
  in this report, exactly as a real user would experience it. codeindex's
  cold index has no external process dependency.
- **Two query modes for codeindex, on purpose.** \`find-symbol in-proc\` /
  \`references in-proc\` / \`caller-index in-proc\` time a single API call
  against an already-loaded warm scan — the number a long-running host
  process (MCP server, editor plugin) actually pays per query. \`full-index
  spawn\` times a full \`codeindex symbols\` CLI invocation: Node startup, a
  cold \`buildIndexArtifacts\`, and serialization of the *entire* symbol table —
  it is **not** a single-symbol lookup and must never be read as one. It is
  included so a one-shot CLI caller can see that cost too, and so it can be
  weighed against 01x's own single-query numbers on equal footing (both are
  full process spawns).
- **01x \`find-symbol\` in the Queries table is one query against its primed
  SQLite DB** (after its own \`init\`, which is timed separately in Cold
  index). It is the fair counterpart to codeindex's in-proc lookups, not to
  \`full-index spawn\`.

### MCP servers (Serena, Graphify, falcon): task equivalence

The three MCP competitors answer the same three tasks — find-symbol,
references, file-overview — but not with the same machinery, so the mapping
is pinned here and must be read alongside the MCP sessions / MCP token
economy tables:

- **Same transport, same client, for everyone.** All four servers (codeindex
  included) are driven over the same newline-delimited JSON-RPC 2.0 stdio
  transport by the same client (\`scripts/bench/mcp-client.mjs\`), one tool
  call per session — graphify's server drops still-queued responses at stdin
  EOF, so the one-call-per-session policy is applied to all servers for
  symmetry.
- **Task equivalence, pinned.** find-symbol = serena \`find_symbol\` /
  graphify \`get_node\` / falcon \`falcon_symbol_lookup\` / codeindex
  \`find_symbol\`. references = serena \`find_referencing_symbols\` / graphify
  \`get_neighbors\` (incoming calls/imports edges) / falcon: the SAME
  \`falcon_symbol_lookup\` call as find-symbol — v0.6.4 embeds
  callers/references in that one response and ships no separate references
  tool. file-overview = serena \`get_symbols_overview\` / falcon
  \`falcon_file_context\`; graphify has no file-level equivalent (its file
  nodes are keyed by basename, collision-prone on real repos), so that cell
  is n/a by design.
- **Graphify's granularity is looser.** Its nodes are label-matched
  (case-insensitive, tolerant) and \`get_neighbors\` returns graph edges, not
  source locations — a coarser notion of "references" than the other
  tools' answers. Its cells are comparable as task outcomes, not as
  equal-precision results.
- **LSP precision cuts the other way.** serena's answers come from live
  language servers and are semantically precise (type-aware references);
  codeindex, graphify and falcon are static/syntactic. Where serena is
  slower, part of that time is buying precision the others do not claim —
  the timing tables cannot capture that asymmetry.
- **Activation and downloads are excluded from per-call numbers.** One-time
  installs and serena's per-language language-server downloads are never
  timed; activation (spawn -> ready) is measured separately in the MCP
  sessions table, and each server's index/parse cost lives in Cold index.
- **falcon does not index Rust** (v0.6.4 covers Go/JS-TS/Python/Java), so
  every falcon cell for \`BurntSushi/ripgrep\` reads \`n/a (rust not
  supported)\` — a capability gap, not a measurement failure.

### Token-economy caveat

The token-economy scenario's \`grep lines\` / \`01x formula ratio\` columns
locate symbol occurrences with a plain **substring** match over the raw repo
text (reproducing 01x's own published grep-based method, for comparability).
A short, common identifier — e.g. Go's \`New\` in \`gin-gonic/gin\` — will match
inside unrelated tokens and non-symbol lines, inflating the grep-side line
count (and therefore the token estimate) for both tools equally. This bias is
symmetric: it makes the naive-grep baseline look *more* expensive than it
truly is, which favors neither codeindex nor 01x in the ratio, but it means
the absolute \`grep lines\` / token counts for common short names should be
read as an upper bound, not an exact figure.

### Reference: 01x-in's own published figures (not measured here)

01x-in/codeindex publishes its own \`vercel/next.js\` numbers at
\`benchmarks/results/next.js.md\` in their repository (dated April 2026, on
their own machine, against their own SHA — which is **not** the SHA pinned in
this report's \`repos.mjs\`):

| Metric | 01x-in's published figure |
| --- | --- |
| \`init\` (cold), 11,064 files | 121,037 ms |
| \`reindex\` (single file) | 60 ms |
| \`find-symbol\` | 13 ms |

These are quoted here **only as external context** — they were measured by
01x-in, on their machine, on their SHA, and are **not** reproduced or
verified by this harness. They must never be read as this session's
measurement of 01x. The directly comparable, apples-to-apples figures are the
01x columns measured in this same session, on this same machine, against the
SHA pinned above (Cold index → \`01x init (ms)\`; Warm/incremental → \`01x
reindex file (ms)\`; Queries → \`01x find-symbol (ms)\`, all for \`vercel/next.js\`).

This report's \`vercel/next.js\` **Files** count (20,000) is codeindex's own
default walk cap (\`DEFAULT_MAX_FILES\`), confirmed hit in this session
(\`capped: true\`) — next.js has more source files on disk than that. 01x-in's
published 11,064 is their own tool's file count under their own ignore
rules, on their SHA. The two file counts are not on the same scope and
should not be read as "the same repo size."

### Notes on specific cells in this session

- **\`vercel/next.js\` — \`01x init\` (Cold index) is right at this harness's
  spawn-timeout boundary.** 01x's cold \`init\` on this repo takes roughly
  85-125s on this machine across repeated measurements — close to this
  harness's internal per-process spawn timeout (120s, \`runCmd\`'s
  \`execFileSync\` default) and to 01x-in's own published figure for the same
  operation (121,037 ms, see above). A separate measurement session on this
  same machine, same SHA, produced \`n/a (init exit null)\` here instead of a
  millisecond figure, because the spawn was killed after 120s. That earlier
  session's raw log and this session's \`86062 (3×)\` value are both authentic
  measurements of the same underlying fact: this operation's cost on this
  repo, on this architecture combination (external ast-grep spawn per file,
  ~12,000 files), sits right at that boundary and can read either way. The
  \`01x reindex file\` / \`01x find-symbol\` cells for \`vercel/next.js\` depend on
  a successful \`init\` to prime the DB first, so they inherit the same
  boundary risk.
- **\`socialgouv/code-du-travail-numerique\` — \`01x reindex file\` (Warm):
  \`n/a (reindex exit 1)\`.** This repo's deterministic "first code file"
  (auto-picked the same way for both tools' touch-target) is
  \`lighthouserc.cjs\`. codeindex classifies it as source; 01x's \`reindex\`
  rejects it deterministically with "cannot determine language for
  lighthouserc.cjs" (confirmed by direct reproduction outside this harness).
  This is a genuine, repeatable language-support gap on this one file, not a
  flaky failure — it reproduced identically across both sessions run for
  this report.`;

export function renderMarkdown(report, env) {
  const out = [];
  out.push("# codeindex — competitor benchmarks");
  out.push("");
  out.push(
    "Reproducible harness (`scripts/bench/`) comparing codeindex against " +
      "01x-in/codeindex, universal-ctags, scip-typescript, Serena (LSP over MCP), " +
      "Graphify and repo-falcon. Timings are the " +
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
