// `delta`: map a git diff onto the link-graph — changed files → enclosing
// symbols → blast radius → a risk-scored, reasons-first review panel.
//
// The scoring is deterministic and mechanical; judging whether a risky change is
// CORRECT is not this engine's job. Reasons matter more than the number: every
// point of the score is explained by one reason string carrying its numbers, so
// a reviewer can disagree with a signal instead of with an opaque total.
import type { Graph, ModuleNode, SymbolIndex } from "./types.js";
import type { DiffFile, DiffSpec, Hunk } from "./git.js";
import { isGitWorktree, resolveBaseRef, diffFiles, diffHunks, untrackedFiles } from "./git.js";
import { byStr } from "./sort.js";
import { have, sh } from "./util.js";
import { impactOf } from "./traverse.js";

export interface DeltaOptions {
  base?: string;
  staged?: boolean;
  depth?: number; // blast-radius hops, default 2
}

export interface ChangedSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
  endLine?: number;
  parent?: string;
  approx?: boolean; // attributed by nearest-def fallback, not exact enclosure
}

export interface DeltaChange {
  path: string;
  status: DiffFile["status"];
  oldPath?: string;
  binary?: boolean;
  linesAdded?: number;
  linesDeleted?: number;
  module?: string;
  hunks: { start: number; end: number }[];
  symbols: ChangedSymbol[];
}

export interface DeltaModule {
  slug: string;
  path: string;
  score: number; // 0–100
  bucket: "HIGH" | "MEDIUM" | "LOW";
  reasons: string[]; // one per fired signal, fixed order, numbers included
  changedFiles: string[];
  changedSymbols: { total: number; exported: number };
  impact: { directFiles: number; transitiveFiles: number; modules: string[] };
  tests: { status: "covered" | "gap" | "n/a"; files: string[] };
  open: string[]; // best changed files to open first
}

export interface DeltaResult {
  base: { ref: string; mergeBase: string; staged: boolean };
  indexCommit?: string;
  depth: number;
  changes: DeltaChange[];
  modules: DeltaModule[];
  dangling: { from: string; spec: string; reason: string }[];
  deleted: string[];
  unindexed: string[];
  notes: string[];
}

export type DeltaError = { error: string };

// The fixed weight table — exported so consumers and tests pin every signal
// exactly rather than inferring it from totals.
export const RISK_WEIGHTS = {
  exportedChange: 25, // an exported symbol changed: consumers may break
  hubHigh: 20, // pagerank percentile ≥ .90
  hubMed: 10, // pagerank percentile ≥ .75
  blastHigh: 20, // ≥ 20 dependent files or ≥ 5 dependent modules
  blastMed: 10, // ≥ 5 dependent files
  testGap: 20, // a testable module with no covering test
  surprise: 10, // the module sits on a surprising cross-community edge
  dangling: 15, // a changed file carries a dangling import
} as const;

const HIGH_MIN = 60;
const MEDIUM_MIN = 30;
const OPEN_CAP = 3;
export const DEFAULT_DELTA_DEPTH = 2;

interface NamedDef {
  name: string;
  file: string;
  line: number;
  endLine?: number;
  kind: string;
  exported: boolean;
  parent?: string;
}

// Every symbol whose range encloses a changed hunk, innermost first. When no def
// encloses the hunk and the file's defs carry no endLine (regex-extracted
// languages), the nearest def at or above the hunk is taken and flagged
// `approx` — never silently presented as exact.
export function symbolsInHunks(defs: NamedDef[], hunks: Hunk[]): ChangedSymbol[] {
  const out: ChangedSymbol[] = [];
  const seen = new Set<string>();
  const push = (d: NamedDef, approx: boolean): void => {
    const key = `${d.name}:${d.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: d.name,
      kind: d.kind,
      exported: d.exported,
      line: d.line,
      ...(d.endLine !== undefined ? { endLine: d.endLine } : {}),
      ...(d.parent !== undefined ? { parent: d.parent } : {}),
      ...(approx ? { approx: true } : {}),
    });
  };
  const span = (d: NamedDef): number => (d.endLine ?? d.line) - d.line;
  for (const h of hunks) {
    const enclosing = defs.filter((d) => d.line <= h.end && (d.endLine ?? d.line) >= h.start);
    if (enclosing.length) {
      enclosing.sort((a, b) => span(a) - span(b) || b.line - a.line || byStr(a.name, b.name));
      for (const d of enclosing) push(d, false);
    } else {
      const above = defs.filter((d) => d.line <= h.start && d.endLine === undefined);
      const near = above[above.length - 1]; // defs are line-sorted
      if (near) push(near, true);
    }
  }
  return out;
}

// Percentile by STRICTLY-SMALLER count so ties never rank anyone above anyone:
// with all values equal the percentile is 0, not an artifact of sort order.
function percentile(values: number[], mine: number): number {
  if (values.length <= 1) return 0;
  let smaller = 0;
  for (const v of values) if (v < mine) smaller++;
  return smaller / (values.length - 1);
}

// The pure core: graph + symbols + parsed diff → the full result. No git, no
// filesystem — unit-testable with synthetic inputs.
export function computeDelta(
  graph: Graph,
  symbols: SymbolIndex | undefined,
  diff: { files: DiffFile[]; hunks: Map<string, Hunk[]>; base: DeltaResult["base"]; notes?: string[] },
  depth: number = DEFAULT_DELTA_DEPTH,
): DeltaResult {
  const notes = [...(diff.notes ?? [])];
  if (!symbols) notes.push("symbol index missing — symbol-level attribution disabled");

  const fileByRel = new Map(graph.files.map((f) => [f.rel, f]));

  const defsByFile = new Map<string, NamedDef[]>();
  if (symbols) {
    for (const [name, entries] of Object.entries(symbols.defs)) {
      for (const d of entries) {
        let arr = defsByFile.get(d.file);
        if (!arr) defsByFile.set(d.file, (arr = []));
        arr.push({ name, ...d });
      }
    }
    for (const arr of defsByFile.values()) arr.sort((a, b) => a.line - b.line || byStr(a.name, b.name));
  }

  const deleted: string[] = [];
  const unindexed: string[] = [];
  const changes: DeltaChange[] = [];
  for (const df of [...diff.files].sort((a, b) => byStr(a.path, b.path))) {
    const carry = {
      ...(df.oldPath !== undefined ? { oldPath: df.oldPath } : {}),
      ...(df.binary ? { binary: true } : {}),
      ...(df.linesAdded !== undefined ? { linesAdded: df.linesAdded } : {}),
      ...(df.linesDeleted !== undefined ? { linesDeleted: df.linesDeleted } : {}),
    };
    if (df.status === "deleted") {
      deleted.push(df.path);
      changes.push({ path: df.path, status: df.status, ...carry, hunks: [], symbols: [] });
      continue;
    }
    const node = fileByRel.get(df.path);
    if (!node) {
      unindexed.push(df.path);
      continue;
    }
    // A file added whole (including untracked) has no hunks in the diff: treat
    // the entire file as changed so its symbols are attributed.
    let hunks = diff.hunks.get(df.path) ?? [];
    if (!hunks.length && df.status === "added" && !df.binary) hunks = [{ start: 1, end: Math.max(node.lines, 1) }];
    const syms = df.binary ? [] : symbolsInHunks(defsByFile.get(df.path) ?? [], hunks);
    changes.push({
      path: df.path,
      status: df.status,
      ...carry,
      module: node.module,
      hunks: hunks.map((h) => ({ start: h.start, end: h.end })),
      symbols: syms,
    });
  }

  // Dangling imports leaving any changed indexed file — broken references the
  // diff either introduced or now sits on top of.
  const changedRels = new Set(changes.filter((c) => c.status !== "deleted").map((c) => c.path));
  const dangling = graph.fileEdges
    .filter((e) => e.dangling && (e.kind === "import" || e.kind === "doc-link") && changedRels.has(e.from))
    .map((e) => ({ from: e.from, spec: e.to, reason: e.reason ?? "unknown" }))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.spec, b.spec));

  // Group by module and score.
  const byModule = new Map<string, DeltaChange[]>();
  for (const c of changes) {
    if (c.status === "deleted" || !c.module) continue;
    let arr = byModule.get(c.module);
    if (!arr) byModule.set(c.module, (arr = []));
    arr.push(c);
  }

  const nonTestCode = new Set<string>();
  for (const f of graph.files) {
    if (f.fileKind === "code" && !f.testFile) nonTestCode.add(f.module);
  }
  const pagerankKnown = graph.modules.some((m) => m.pagerank !== undefined);
  const metricOf = (m: ModuleNode): number => (pagerankKnown ? (m.pagerank ?? 0) : m.degIn + m.degOut);
  const metricValues = graph.modules.map(metricOf);
  const metricName = pagerankKnown ? "pagerank" : "degree";

  const modules: DeltaModule[] = [];
  for (const slug of [...byModule.keys()].sort(byStr)) {
    const m = graph.modules.find((x) => x.slug === slug);
    if (!m) continue;
    const moduleChanges = byModule.get(slug)!;
    const reasons: string[] = [];
    let score = 0;

    // 1. Exported API changed.
    const exportedNames = [...new Set(moduleChanges.flatMap((c) => c.symbols.filter((s) => s.exported).map((s) => s.name)))].sort(byStr);
    if (exportedNames.length) {
      score += RISK_WEIGHTS.exportedChange;
      const shown = exportedNames.slice(0, 3).join(", ") + (exportedNames.length > 3 ? ", …" : "");
      reasons.push(exportedNames.length === 1 ? `exported symbol ${shown} changed` : `exported symbols ${shown} changed`);
    }

    // 2. Structural importance of the touched module.
    const pct = percentile(metricValues, metricOf(m));
    if (pct >= 0.9) {
      score += RISK_WEIGHTS.hubHigh;
      reasons.push(`${metricName} p${Math.round(pct * 100)} hub`);
    } else if (pct >= 0.75) {
      score += RISK_WEIGHTS.hubMed;
      reasons.push(`${metricName} p${Math.round(pct * 100)} hub`);
    }

    // 3. Blast radius — union of the reverse closure of each changed file.
    const depthByRel = new Map<string, number>();
    const impModules = new Set<string>();
    for (const c of moduleChanges) {
      const imp = impactOf(graph, c.path, depth);
      if (!imp) continue;
      for (const f of imp.files) {
        const prev = depthByRel.get(f.rel);
        if (prev === undefined || f.depth < prev) depthByRel.set(f.rel, f.depth);
      }
      for (const im of imp.modules) if (im !== slug) impModules.add(im);
    }
    const transitiveFiles = depthByRel.size;
    const directFiles = [...depthByRel.values()].filter((d) => d === 1).length;
    const impact = { directFiles, transitiveFiles, modules: [...impModules].sort(byStr) };
    if (transitiveFiles >= 20 || impact.modules.length >= 5) {
      score += RISK_WEIGHTS.blastHigh;
      reasons.push(`${transitiveFiles} dependent files across ${impact.modules.length} modules (depth ${depth})`);
    } else if (transitiveFiles >= 5) {
      score += RISK_WEIGHTS.blastMed;
      reasons.push(`${transitiveFiles} dependent files across ${impact.modules.length} modules (depth ${depth})`);
    }

    // 4. Test gap — only for modules that should have tests at all.
    const testable = m.tier <= 1 && m.symbols > 0 && nonTestCode.has(slug);
    const coveredBy = m.testedBy ?? [];
    const tests: DeltaModule["tests"] = testable
      ? coveredBy.length
        ? { status: "covered", files: coveredBy }
        : { status: "gap", files: [] }
      : { status: "n/a", files: [] };
    if (tests.status === "gap") {
      score += RISK_WEIGHTS.testGap;
      reasons.push("no test covers this module");
    }

    // 5. Surprising cross-community coupling incident to the module.
    const sup = (graph.surprises ?? []).find((s) => s.from === slug || s.to === slug);
    if (sup) {
      score += RISK_WEIGHTS.surprise;
      reasons.push(`cross-community edge to ${sup.from === slug ? sup.to : sup.from} (surprising)`);
    }

    // 6. Dangling imports from this module's changed files.
    const moduleDangling = dangling.filter((d) => moduleChanges.some((c) => c.path === d.from));
    if (moduleDangling.length) {
      score += RISK_WEIGHTS.dangling;
      const first = moduleDangling[0]!;
      const more = moduleDangling.length > 1 ? ` (+${moduleDangling.length - 1} more)` : "";
      reasons.push(`dangling import "${first.spec}" in ${first.from}${more}`);
    }

    score = Math.min(100, score);
    const changedFiles = moduleChanges.map((c) => c.path).sort(byStr);
    const allSyms = moduleChanges.flatMap((c) => c.symbols);
    const open = moduleChanges
      .slice()
      .sort(
        (a, b) =>
          b.symbols.filter((s) => s.exported).length - a.symbols.filter((s) => s.exported).length ||
          b.symbols.length - a.symbols.length ||
          byStr(a.path, b.path),
      )
      .slice(0, OPEN_CAP)
      .map((c) => c.path);

    modules.push({
      slug,
      path: m.path,
      score,
      bucket: score >= HIGH_MIN ? "HIGH" : score >= MEDIUM_MIN ? "MEDIUM" : "LOW",
      reasons,
      changedFiles,
      changedSymbols: {
        total: new Set(allSyms.map((s) => `${s.name}:${s.line}`)).size,
        exported: new Set(allSyms.filter((s) => s.exported).map((s) => `${s.name}:${s.line}`)).size,
      },
      impact,
      tests,
      open,
    });
  }
  modules.sort((a, b) => b.score - a.score || byStr(a.slug, b.slug));

  return {
    base: diff.base,
    ...(graph.commit !== undefined ? { indexCommit: graph.commit } : {}),
    depth,
    changes,
    modules,
    dangling,
    deleted: deleted.sort(byStr),
    unindexed: unindexed.sort(byStr),
    notes,
  };
}

// Git plumbing → computeDelta, against a graph the caller already built. The
// caller owns index freshness: a consumer serving a PERSISTED graph must gate
// on its own staleness oracle first, because symbol line-mapping is only
// correct against an index built from the same bytes, and a confidently wrong
// attribution is worse than "rebuild first".
export function deltaFor(
  repo: string,
  graph: Graph,
  symbols: SymbolIndex | undefined,
  opts: DeltaOptions = {},
): DeltaResult | DeltaError {
  if (!have("git")) return { error: "git is required for delta and was not found on PATH" };
  if (!isGitWorktree(repo)) return { error: `delta needs a git worktree — ${repo} is not inside one` };

  const notes: string[] = [];
  let base: DeltaResult["base"];
  if (opts.staged) {
    const head = sh("git", ["-C", repo, "rev-parse", "HEAD"]);
    if (!head.ok) return { error: "cannot resolve HEAD — empty repository?" };
    base = { ref: "HEAD", mergeBase: head.stdout.trim(), staged: true };
  } else {
    const r = resolveBaseRef(repo, opts.base);
    if ("error" in r) return { error: r.error };
    if (r.note) notes.push(r.note);
    base = { ref: r.ref, mergeBase: r.mergeBase, staged: false };
  }

  const spec: DiffSpec = opts.staged ? { staged: true } : { mergeBase: base.mergeBase };
  const files = diffFiles(repo, spec);
  if (!opts.staged) {
    const known = new Set(files.map((f) => f.path));
    for (const u of untrackedFiles(repo)) {
      if (!known.has(u)) files.push({ path: u, status: "added" });
    }
  }

  return computeDelta(graph, symbols, { files, hunks: diffHunks(repo, spec), base, notes }, opts.depth ?? DEFAULT_DELTA_DEPTH);
}

// The human panel. Stdout-only by design: delta output is ephemeral per-worktree
// state — machine consumers take the JSON.
export function formatDeltaPanel(res: DeltaResult): string {
  const mb = res.base.mergeBase.slice(0, 7);
  const vs = `${res.base.staged ? "staged vs " : ""}${res.base.ref}`;
  if (!res.changes.length && !res.unindexed.length) {
    return `codeindex: no changes vs ${vs} (merge-base ${mb})\n`;
  }
  const changedCount = res.changes.length + res.unindexed.length;
  const lines = [
    `codeindex: delta vs ${vs} (merge-base ${mb}) — ${changedCount} changed file(s), ` +
      `${res.modules.length} module(s)${res.indexCommit ? `, index @ ${res.indexCommit}` : ""}`,
  ];
  for (const n of res.notes) lines.push(`  note: ${n}`);
  for (const m of res.modules) {
    lines.push(`  ${m.bucket.padEnd(6)} ${m.slug}  score ${m.score}${m.reasons.length ? ` — ${m.reasons.join("; ")}` : ""}`);
    const tests =
      m.tests.status === "gap" ? "GAP" : m.tests.status === "covered" ? `covered (${m.tests.files.length})` : "n/a";
    lines.push(`         open: ${m.open.join(", ") || "—"} · tests: ${tests}`);
  }
  if (res.dangling.length) {
    lines.push(`  dangling:  ${res.dangling.map((d) => `${d.spec} (from ${d.from})`).join(" · ")}`);
  }
  if (res.deleted.length) lines.push(`  deleted:   ${res.deleted.join(", ")}`);
  if (res.unindexed.length) lines.push(`  unindexed: ${res.unindexed.join(", ")}`);
  return lines.join("\n") + "\n";
}
