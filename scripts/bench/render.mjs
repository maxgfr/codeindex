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

export function renderMarkdown(report, env) {
  const out = [];
  out.push("# codeindex — competitor benchmarks");
  out.push("");
  out.push(
    "Reproducible harness (`scripts/bench/`) comparing codeindex against " +
      "01x-in/codeindex, universal-ctags and scip-typescript. Timings are the " +
      `median of ${report.nominalRuns} runs with one warmup discarded; a cell reading ` +
      "`n/a (reason)` means that tool was not measurable in this session.",
  );
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
