// `delta`: map a git diff onto the link-graph — changed files → enclosing
// symbols → blast radius → a risk-scored, reasons-first review panel.
//
// The scoring is deterministic and mechanical; judging whether a risky change is
// CORRECT is not this engine's job. Reasons matter more than the number: every
// point of the score is explained by one reason string carrying its numbers, so
// a reviewer can disagree with a signal instead of with an opaque total.
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { Graph, ModuleNode, SymbolIndex } from "./types.js";
import type { RepoScan } from "./scan.js";
import type { DiffFile, DiffSpec, Hunk } from "./git.js";
import { NO_COMMITS_REF, emptyTreeId, isGitWorktree, resolveBaseRef, diffFiles, diffHunks, untrackedFiles } from "./git.js";
import { buildResolveContext, resolveDocLink, resolveImport } from "./resolve.js";
import { byStr } from "./sort.js";
import { IGNORE_DIRS } from "./walk.js";
import { have, sh, slugify } from "./util.js";
import { sha1 } from "./hash.js";
import { impactOf, reverseClosure } from "./traverse.js";

export interface DeltaOptions {
  base?: string;
  staged?: boolean;
  depth?: number; // blast-radius hops, default 2
  // The scan the graph was built from. With it, delta re-resolves the graph's
  // dangling imports against the files the diff removed, which is the only
  // way to see who still imports a deleted or renamed file: the graph of the
  // worktree no longer holds that file, so no edge points at it.
  scan?: RepoScan;
  // The persisted index directory, relative to the repo (default .codeindex):
  // its files are the engine's output, never part of a review.
  indexDir?: string;
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

// An import (or doc link) of a file the diff removed: it resolves to the
// removed path once that path is put back. `renamedTo` when the file moved.
export interface BrokenImport {
  from: string;
  spec: string;
  kind: "import" | "doc-link";
  target: string;
  renamedTo?: string;
}

export interface DeltaResult {
  base: { ref: string; mergeBase: string; staged: boolean };
  indexCommit?: string;
  depth: number;
  changes: DeltaChange[];
  modules: DeltaModule[];
  // Dangling imports leaving changed files, minus the ones `broken` explains.
  dangling: { from: string; spec: string; reason: string }[];
  broken: BrokenImport[];
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
  // A file the diff deleted or renamed is still imported. Weighs more than
  // `dangling`: that one may predate the diff or be a resolver blind spot,
  // while this breakage is the diff's own, and certain.
  brokenImport: 40,
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
// encloses the hunk and the file's defs carry no endLine (regex-tier spans it
// could not prove), the nearest def at or above the hunk is taken and flagged
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

// Who still imports a file the diff removed (deleted, or the old side of a
// rename). The worktree's graph cannot say directly — the file is gone, so the
// importer's edge is now dangling with only its spec left. Putting the removed
// paths back into a resolve context and re-resolving just the dangling specs
// answers it for every language the resolver knows, with no language logic
// here. Everything else about the context is the live scan's.
export function brokenImports(
  scan: RepoScan,
  graph: Graph,
  removed: { path: string; renamedTo?: string }[],
): BrokenImport[] {
  const dangling = graph.fileEdges.filter((e) => e.dangling && (e.kind === "import" || e.kind === "doc-link"));
  if (!dangling.length || !removed.length) return [];
  const ctx = buildResolveContext(scan);
  const renamedTo = new Map<string, string | undefined>();
  for (const r of removed) {
    // Re-created at the same path: nothing is missing there.
    if (ctx.fileSet.has(r.path)) continue;
    renamedTo.set(r.path, r.renamedTo);
    ctx.fileSet.add(r.path);
    const dir = r.path.includes("/") ? posix.dirname(r.path) : "";
    const list = ctx.filesByDir.get(dir);
    if (list) list.push(r.path);
    else ctx.filesByDir.set(dir, [r.path]);
    for (let d = dir; d && !ctx.dirSet.has(d); d = d.includes("/") ? posix.dirname(d) : "") ctx.dirSet.add(d);
  }
  if (!renamedTo.size) return [];
  const extOf = new Map(scan.files.map((f) => [f.rel, f.ext]));
  const out: BrokenImport[] = [];
  for (const e of dangling) {
    const ext = extOf.get(e.from);
    if (ext === undefined) continue;
    const kind = e.kind === "doc-link" ? "doc-link" : "import";
    const r = kind === "doc-link" ? resolveDocLink(e.from, e.to, ctx) : resolveImport(e.from, ext, e.to, ctx);
    if (r.kind !== "resolved" || !renamedTo.has(r.target)) continue;
    const to = renamedTo.get(r.target);
    out.push({ from: e.from, spec: e.to, kind, target: r.target, ...(to !== undefined ? { renamedTo: to } : {}) });
  }
  return out.sort((a, b) => byStr(a.target, b.target) || byStr(a.from, b.from) || byStr(a.spec, b.spec));
}

// The pure core: graph + symbols + parsed diff → the full result. No git, no
// filesystem — unit-testable with synthetic inputs. `broken` comes from
// brokenImports (deltaOfDiff computes it when it has the scan).
export function computeDelta(
  graph: Graph,
  symbols: SymbolIndex | undefined,
  diff: {
    files: DiffFile[];
    hunks: Map<string, Hunk[]>;
    base: DeltaResult["base"];
    notes?: string[];
    broken?: BrokenImport[];
  },
  depth: number = DEFAULT_DELTA_DEPTH,
): DeltaResult {
  const notes = [...(diff.notes ?? [])];
  if (!symbols) notes.push("symbol index missing — symbol-level attribution disabled");
  const broken = diff.broken ?? [];

  const fileByRel = new Map(graph.files.map((f) => [f.rel, f]));
  const moduleBySlug = new Map(graph.modules.map((m) => [m.slug, m]));

  // Defs of the changed indexed files only: symbols.defs spans the whole repo
  // (hundreds of thousands of entries on a large one), and a review touches a
  // handful of files.
  const defsByFile = new Map<string, NamedDef[]>();
  for (const df of diff.files) if (df.status !== "deleted" && fileByRel.has(df.path)) defsByFile.set(df.path, []);
  if (symbols && defsByFile.size) {
    for (const name of Object.keys(symbols.defs)) {
      for (const d of symbols.defs[name]!) defsByFile.get(d.file)?.push({ name, ...d });
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
  // diff either introduced or now sits on top of. One that points at a file
  // the diff removed is listed under `broken` instead, with its cause.
  const changedRels = new Set(changes.filter((c) => c.status !== "deleted").map((c) => c.path));
  const explained = new Set(broken.map((b) => `${b.from}\0${b.spec}`));
  const dangling = graph.fileEdges
    .filter(
      (e) =>
        e.dangling &&
        (e.kind === "import" || e.kind === "doc-link") &&
        changedRels.has(e.from) &&
        !explained.has(`${e.from}\0${e.to}`),
    )
    .map((e) => ({ from: e.from, spec: e.to, reason: e.reason ?? "unknown" }))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.spec, b.spec));

  // A relative import whose target lands in a directory the walker ignores
  // (vendor/, dist/, build/ …) is reported as dangling because the resolver only
  // looks inside the scan — but the file is there and the import works. It is a
  // blind spot in the graph, not a broken reference, so it must NOT carry the
  // dangling RISK weight: a repo that vendors a dependency would otherwise take
  // a permanent penalty on every change to the file that imports it. Still
  // listed above, so the blind spot stays visible.
  const intoIgnoredTree = (from: string, spec: string): boolean => {
    if (!spec.startsWith(".")) return false;
    const segs = from.split("/").slice(0, -1);
    for (const part of spec.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") segs.pop();
      else segs.push(part);
    }
    return segs.some((seg) => IGNORE_DIRS.has(seg));
  };

  // Group by module and score.
  const byModule = new Map<string, DeltaChange[]>();
  for (const c of changes) {
    if (c.status === "deleted" || !c.module) continue;
    let arr = byModule.get(c.module);
    if (!arr) byModule.set(c.module, (arr = []));
    arr.push(c);
  }

  // A removed file's breakage is charged to the module it was removed FROM —
  // the change a reviewer is looking at — even when no indexed file there
  // changed, and even when the whole directory is gone (the module then exists
  // only in this panel, under the slug the directory would have had).
  const moduleOfDir = new Map(graph.modules.map((m) => [m.path, m]));
  const slugOfRemoved = (rel: string): string => {
    const dir = rel.includes("/") ? posix.dirname(rel) : "(root)";
    const m = moduleOfDir.get(dir);
    if (m) return m.slug;
    const base = dir === "(root)" ? "root" : slugify(dir);
    return base && !moduleBySlug.has(base) ? base : `${base || "module"}-${sha1(dir).slice(0, 8)}`;
  };
  const brokenByModule = new Map<string, BrokenImport[]>();
  const removedPathOf = new Map<string, string>(); // synthetic slug → removed dir
  for (const b of broken) {
    const slug = slugOfRemoved(b.target);
    if (!moduleBySlug.has(slug)) removedPathOf.set(slug, b.target.includes("/") ? posix.dirname(b.target) : "(root)");
    let arr = brokenByModule.get(slug);
    if (!arr) brokenByModule.set(slug, (arr = []));
    arr.push(b);
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
  for (const slug of [...new Set([...byModule.keys(), ...brokenByModule.keys()])].sort(byStr)) {
    const m = moduleBySlug.get(slug);
    const gonePath = removedPathOf.get(slug);
    if (!m && gonePath === undefined) continue;
    const moduleChanges = byModule.get(slug) ?? [];
    const moduleBroken = brokenByModule.get(slug) ?? [];
    const reasons: string[] = [];
    let score = 0;

    // 0. A removed file that is still imported: the build breaks.
    const brokenImportsOnly = moduleBroken.filter((b) => b.kind === "import");
    if (brokenImportsOnly.length) {
      score += RISK_WEIGHTS.brokenImport;
      const targets = [...new Set(brokenImportsOnly.map((b) => b.target))].sort(byStr);
      const first = targets[0]!;
      const importers = [...new Set(brokenImportsOnly.filter((b) => b.target === first).map((b) => b.from))].sort(byStr);
      const firstBroken = brokenImportsOnly.find((b) => b.target === first)!;
      const what = firstBroken.renamedTo !== undefined ? `renamed ${first} (now ${firstBroken.renamedTo})` : `removed ${first}`;
      const shown = importers.slice(0, 3).join(", ") + (importers.length > 3 ? ", …" : "");
      const more = targets.length > 1 ? ` (+${targets.length - 1} more removed file${targets.length > 2 ? "s" : ""})` : "";
      reasons.push(`${what} is still imported by ${importers.length} file${importers.length === 1 ? "" : "s"} (${shown})${more}`);
    }

    // 1. Exported API changed.
    const exportedNames = [...new Set(moduleChanges.flatMap((c) => c.symbols.filter((s) => s.exported).map((s) => s.name)))].sort(byStr);
    if (exportedNames.length) {
      score += RISK_WEIGHTS.exportedChange;
      const shown = exportedNames.slice(0, 3).join(", ") + (exportedNames.length > 3 ? ", …" : "");
      reasons.push(exportedNames.length === 1 ? `exported symbol ${shown} changed` : `exported symbols ${shown} changed`);
    }

    // 2. Structural importance of the touched module.
    const pct = m ? percentile(metricValues, metricOf(m)) : 0;
    if (pct >= 0.9) {
      score += RISK_WEIGHTS.hubHigh;
      reasons.push(`${metricName} p${Math.round(pct * 100)} hub`);
    } else if (pct >= 0.75) {
      score += RISK_WEIGHTS.hubMed;
      reasons.push(`${metricName} p${Math.round(pct * 100)} hub`);
    }

    // 3. Blast radius — union of the reverse closure of each changed file. A
    // removed file has no node left to walk from, so its importers stand in as
    // its direct dependents and the walk continues from them.
    const depthByRel = new Map<string, number>();
    const impModules = new Set<string>();
    const reach = (rel: string, d: number): void => {
      const prev = depthByRel.get(rel);
      if (prev === undefined || d < prev) depthByRel.set(rel, d);
    };
    for (const c of moduleChanges) {
      const imp = impactOf(graph, c.path, depth);
      if (!imp) continue;
      for (const f of imp.files) reach(f.rel, f.depth);
      for (const im of imp.modules) if (im !== slug) impModules.add(im);
    }
    const importers = [...new Set(moduleBroken.map((b) => b.from))].sort(byStr);
    if (importers.length && depth >= 1) {
      const hops = new Map(importers.map((rel) => [rel, 1]));
      for (const [rel, d] of reverseClosure(graph.fileEdges, importers, depth - 1)) hops.set(rel, d + 1);
      for (const [rel, d] of hops) {
        reach(rel, d);
        const im = fileByRel.get(rel)?.module ?? "root";
        if (im !== slug) impModules.add(im);
      }
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
    const testable = m !== undefined && m.tier <= 1 && m.symbols > 0 && nonTestCode.has(slug);
    const coveredBy = m?.testedBy ?? [];
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
    const moduleDangling = dangling.filter(
      (d) => moduleChanges.some((c) => c.path === d.from) && !intoIgnoredTree(d.from, d.spec),
    );
    if (moduleDangling.length) {
      score += RISK_WEIGHTS.dangling;
      const first = moduleDangling[0]!;
      const more = moduleDangling.length > 1 ? ` (+${moduleDangling.length - 1} more)` : "";
      reasons.push(`dangling import "${first.spec}" in ${first.from}${more}`);
    }

    score = Math.min(100, score);
    const removedHere = [...new Set(moduleBroken.map((b) => b.target))].filter((t) => deleted.includes(t));
    const changedFiles = [...moduleChanges.map((c) => c.path), ...removedHere].sort(byStr);
    const allSyms = moduleChanges.flatMap((c) => c.symbols);
    // The changed files carrying the most exported surface first; after a
    // removal, the importers that must now be fixed.
    const open = [
      ...moduleChanges
        .slice()
        .sort(
          (a, b) =>
            b.symbols.filter((s) => s.exported).length - a.symbols.filter((s) => s.exported).length ||
            b.symbols.length - a.symbols.length ||
            byStr(a.path, b.path),
        )
        .map((c) => c.path),
      ...importers.filter((rel) => !changedRels.has(rel)),
    ].slice(0, OPEN_CAP);

    modules.push({
      slug,
      path: m?.path ?? gonePath!,
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
    broken,
    deleted: deleted.sort(byStr),
    unindexed: unindexed.sort(byStr),
    notes,
  };
}

// The git side of a review, on its own: the base, the changed files and their
// hunks. It needs no index, so a caller can run it first and skip loading the
// artifacts when there is nothing to review.
export interface DeltaDiff {
  base: DeltaResult["base"];
  files: DiffFile[];
  hunks: Map<string, Hunk[]>;
  notes: string[];
}

// The engine's own output directory, and anything else the walker would never
// index, is not part of a review: `index --out .codeindex` (the documented
// default) otherwise showed up as three unindexed files in every delta, and an
// untracked node_modules/ as thousands. Tracked paths are kept outside the
// index directory: a committed change is the diff's own even where the walker
// does not look, and the panel lists it as unindexed. Untracked paths are
// judged by the walker's default ignore set.
function reviewFilter(repo: string, indexDir: string | undefined): (path: string, tracked: boolean) => boolean {
  const idx = relative(resolve(repo), resolve(repo, indexDir ?? ".codeindex")).split(sep).join("/");
  const inIndex = idx && !idx.startsWith("..") && !isAbsolute(idx) ? (p: string) => p === idx || p.startsWith(`${idx}/`) : () => false;
  return (path, tracked) => {
    if (inIndex(path)) return false;
    if (tracked) return true;
    const dirs = path.split("/").slice(0, -1);
    return !dirs.some((d) => IGNORE_DIRS.has(d) || d.startsWith(".codeindex-edit-"));
  };
}

export function readDeltaDiff(repo: string, opts: DeltaOptions = {}): DeltaDiff | DeltaError {
  if (!have("git")) return { error: "git is required for delta and was not found on PATH" };
  if (!isGitWorktree(repo)) return { error: `delta needs a git worktree — ${repo} is not inside one` };

  const notes: string[] = [];
  let base: DeltaResult["base"];
  if (opts.staged) {
    // `git diff --cached` compares the index with HEAD, or with the empty tree
    // while there is no HEAD yet — the first commit, staged.
    const head = sh("git", ["-C", repo, "rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.ok) base = { ref: "HEAD", mergeBase: head.stdout.trim(), staged: true };
    else {
      const empty = emptyTreeId(repo);
      if (!empty) return { error: "cannot resolve HEAD, nor the empty tree" };
      base = { ref: NO_COMMITS_REF, mergeBase: empty, staged: true };
      notes.push("no commits yet — every staged file is reviewed as added");
    }
  } else {
    const r = resolveBaseRef(repo, opts.base);
    if ("error" in r) return { error: r.error };
    if (r.note) notes.push(r.note);
    base = { ref: r.ref, mergeBase: r.mergeBase, staged: false };
  }

  const keep = reviewFilter(repo, opts.indexDir);
  const spec: DiffSpec = opts.staged ? { staged: true } : { mergeBase: base.mergeBase };
  const files = diffFiles(repo, spec).filter((f) => keep(f.path, true));
  if (!opts.staged) {
    const known = new Set(files.map((f) => f.path));
    for (const u of untrackedFiles(repo)) {
      if (!known.has(u) && keep(u, false)) files.push({ path: u, status: "added" });
    }
  }
  return { base, files, hunks: files.length ? diffHunks(repo, spec) : new Map(), notes };
}

// A review with nothing in it, answered without an index.
export function emptyDelta(diff: DeltaDiff, depth: number = DEFAULT_DELTA_DEPTH): DeltaResult {
  return { base: diff.base, depth, changes: [], modules: [], dangling: [], broken: [], deleted: [], unindexed: [], notes: diff.notes };
}

// A read diff → computeDelta, against a graph the caller already built. The
// caller owns index freshness: a consumer serving a PERSISTED graph must gate
// on its own staleness oracle first, because symbol line-mapping is only
// correct against an index built from the same bytes, and a confidently wrong
// attribution is worse than "rebuild first".
export function deltaOfDiff(
  diff: DeltaDiff,
  graph: Graph,
  symbols: SymbolIndex | undefined,
  opts: DeltaOptions = {},
): DeltaResult {
  const notes = [...diff.notes];
  const removed = diff.files.flatMap((f) =>
    f.status === "deleted"
      ? [{ path: f.path }]
      : f.status === "renamed" && f.oldPath !== undefined
        ? [{ path: f.oldPath, renamedTo: f.path }]
        : [],
  );
  let broken: BrokenImport[] = [];
  if (removed.length && opts.scan) broken = brokenImports(opts.scan, graph, removed);
  else if (removed.length) notes.push("no scan supplied — importers of removed files were not traced");
  return computeDelta(graph, symbols, { ...diff, notes, broken }, opts.depth ?? DEFAULT_DELTA_DEPTH);
}

// Git plumbing → computeDelta in one call (see deltaOfDiff on freshness).
export function deltaFor(
  repo: string,
  graph: Graph,
  symbols: SymbolIndex | undefined,
  opts: DeltaOptions = {},
): DeltaResult | DeltaError {
  const diff = readDeltaDiff(repo, opts);
  return "error" in diff ? diff : deltaOfDiff(diff, graph, symbols, opts);
}

// The human panel. Stdout-only by design: delta output is ephemeral per-worktree
// state — machine consumers take the JSON.
export function formatDeltaPanel(res: DeltaResult): string {
  const { ref, mergeBase, staged } = res.base;
  // "vs origin/main (merge-base 1a2b3c4)", "vs HEAD (1a2b3c4)" for the staged
  // changes, "vs the empty tree" before the first commit.
  const vs =
    ref === NO_COMMITS_REF
      ? "vs the empty tree (no commits yet)"
      : `vs ${ref} (${staged ? "" : "merge-base "}${mergeBase.slice(0, 7)})`;
  const what = staged ? "staged changes" : "changes";
  if (!res.changes.length && !res.unindexed.length) {
    return `codeindex: no ${what} ${vs}\n`;
  }
  const changedCount = res.changes.length + res.unindexed.length;
  const lines = [
    `codeindex: delta ${staged ? "of staged changes " : ""}${vs} — ${changedCount} changed file(s), ` +
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
  // One line per removed file, naming everything that still imports it.
  const brokenTargets = [...new Set(res.broken.map((b) => b.target))];
  for (const target of brokenTargets) {
    const hits = res.broken.filter((b) => b.target === target);
    const moved = hits[0]!.renamedTo !== undefined ? ` (renamed to ${hits[0]!.renamedTo})` : "";
    const from = [...new Set(hits.map((b) => b.from))];
    lines.push(`  broken:    ${target}${moved} still imported by ${from.join(", ")}`);
  }
  if (res.deleted.length) lines.push(`  deleted:   ${res.deleted.join(", ")}`);
  if (res.unindexed.length) lines.push(`  unindexed: ${res.unindexed.join(", ")}`);
  return lines.join("\n") + "\n";
}
