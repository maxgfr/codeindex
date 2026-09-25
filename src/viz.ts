// Mermaid rendering of the module graph — inline-renderable in Claude, GitHub
// and most markdown viewers with zero infrastructure (the counter to graph-DB
// browsers). Deterministic: sorted nodes/edges, stable ids.
import type { Graph, ModuleNode, Tier } from "./types.js";
import { byStr } from "./sort.js";

export interface MermaidOptions {
  // Restrict to one module's neighborhood (the module plus every module it
  // touches, either direction). A module slug, a module's directory path, or a
  // file (meaning its module); anything else throws rather than rendering an
  // empty diagram that reads as "no dependencies".
  module?: string;
  maxEdges?: number; // default 80 — keeps diagrams renderable
}

// Mermaid node ids must be identifier-safe, and the readable mapping (every
// other character → "_") is not injective: `src/a-b` and `src/a_b` (slugs
// `src-a-b`, `src-a_b`) both became `src_a_b`, silently merging two modules
// into one node. Ids are assigned over EVERY slug of the graph in sorted
// order, so they never depend on which subset a diagram shows: a slug whose
// readable id is unique keeps it (existing diagrams stay byte-identical), and
// within a colliding group the first keeps it and the rest take the first free
// `_2`, `_3`, ….
function mermaidIds(graph: Graph, prefix: string): Map<string, string> {
  const slugs = new Set(graph.modules.map((m) => m.slug));
  for (const e of graph.moduleEdges) slugs.add(e.from).add(e.to);
  const sorted = [...slugs].sort(byStr);
  const base = new Map(sorted.map((s) => [s, prefix + s.replace(/[^A-Za-z0-9_]/g, "_")]));
  const uses = new Map<string, number>();
  for (const b of base.values()) uses.set(b, (uses.get(b) ?? 0) + 1);
  const taken = new Set([...base.values()].filter((b) => uses.get(b) === 1));
  const ids = new Map<string, string>();
  for (const s of sorted) {
    const b = base.get(s)!;
    let id = b;
    if (uses.get(b)! > 1) {
      for (let n = 2; taken.has(id); n++) id = `${b}_${n}`;
      taken.add(id);
    }
    ids.set(s, id);
  }
  return ids;
}

// The module slug a focus target names: a slug, a module directory path
// (`src/flask/json`, trailing slash tolerated), or a file rel (its module).
export function moduleSlugFor(graph: Graph, target: string): string | undefined {
  if (graph.modules.some((m) => m.slug === target)) return target;
  const path = target.replace(/\/+$/, "");
  const byPath = graph.modules.find((m) => m.path === path);
  if (byPath) return byPath.slug;
  return graph.files.find((f) => f.rel === target)?.module;
}

export function renderMermaid(graph: Graph, opts: MermaidOptions = {}): string {
  const maxEdges = opts.maxEdges ?? 80;
  const focus = opts.module ? moduleSlugFor(graph, opts.module) : undefined;
  if (opts.module && !focus) throw new Error(`no such file or module in the index: ${opts.module}`);
  const idOf = mermaidIds(graph, "");
  let edges = [...graph.moduleEdges].filter((e) => !e.dangling);
  if (focus) {
    edges = edges.filter((e) => e.from === focus || e.to === focus);
  }
  edges.sort((a, b) => b.weight - a.weight || byStr(a.from, b.from) || byStr(a.to, b.to));
  const dropped = Math.max(0, edges.length - maxEdges);
  edges = edges.slice(0, maxEdges);

  const shown = new Set<string>();
  for (const e of edges) {
    shown.add(e.from);
    shown.add(e.to);
  }
  if (focus) shown.add(focus);

  const lines: string[] = ["graph LR"];
  for (const m of [...graph.modules].sort((a, b) => byStr(a.slug, b.slug))) {
    if (!shown.has(m.slug)) continue;
    lines.push(`  ${idOf.get(m.slug)}["${m.slug}${m.tier === 0 ? " (core)" : ""}"]`);
  }
  for (const e of edges) {
    const label = e.kind === "import" ? "" : `|${e.kind}|`;
    lines.push(`  ${idOf.get(e.from)} -->${label} ${idOf.get(e.to)}`);
  }
  if (dropped) lines.push(`  %% ${dropped} lighter edges omitted (maxEdges=${maxEdges})`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Clustered whole-graph view. `renderMermaid` above answers "what sits around
// THIS module" and returns raw mermaid; this one answers "what does the whole
// repo look like" — grouped into tier subgraphs, capped by MODULE count as well
// as edge count, fenced, and reporting exactly what it dropped.
//
// Two functions rather than one flag because the truncation contract differs:
// the neighborhood view caps edges only and notes the drop in a comment, while
// a whole-graph view has to bound nodes first (a 400-module repo is unreadable
// long before it hits 80 edges) and hand the caller the counts so it can say so
// in prose. Returning counts from the existing function would have been a
// breaking change for its CLI and MCP callers.
// ---------------------------------------------------------------------------

export interface ClusteredMermaidResult {
  content: string; // a fenced ```mermaid block, ready to embed in markdown
  shownModules: number;
  totalModules: number;
  shownEdges: number;
  totalEdges: number;
}

export interface ClusteredMermaidOptions {
  maxModules?: number; // default 40 — most-connected first
  maxEdges?: number; // default 80 — heaviest first
  title?: string; // leading %% comment; defaults to "module graph"
}

const TIER_LABEL: Record<Tier, string> = { 0: "Foundations", 1: "Features", 2: "Tail" };
const CLUSTER_MAX_MODULES = 40;
const CLUSTER_MAX_EDGES = 80;

const degreeOf = (m: ModuleNode): number => m.degIn + m.degOut;

export function renderMermaidClustered(
  graph: Graph,
  opts: ClusteredMermaidOptions = {},
): ClusteredMermaidResult {
  const maxModules = opts.maxModules ?? CLUSTER_MAX_MODULES;
  const maxEdges = opts.maxEdges ?? CLUSTER_MAX_EDGES;
  // Prefixed so a slug starting with a digit still yields a valid id.
  const ids = mermaidIds(graph, "m_");
  const clusterNodeId = (slug: string): string => ids.get(slug)!;

  const ranked = graph.modules.slice().sort((a, b) => degreeOf(b) - degreeOf(a) || byStr(a.slug, b.slug));
  const shown = ranked.slice(0, maxModules);
  const shownSet = new Set(shown.map((m) => m.slug));

  // Only edges whose BOTH ends survived the module cap — a dangling half-edge
  // would render as a node the caller was told was dropped.
  const edges = graph.moduleEdges
    .filter((e) => shownSet.has(e.from) && shownSet.has(e.to))
    .sort((a, b) => b.weight - a.weight || byStr(a.from, b.from) || byStr(a.to, b.to))
    .slice(0, maxEdges);

  const lines: string[] = [];
  lines.push(
    `%% ${opts.title ?? "module graph"} — ${shown.length} of ${graph.modules.length} modules, ` +
      `${edges.length} of ${graph.moduleEdges.length} edges`,
  );
  if (shown.length < graph.modules.length || edges.length < graph.moduleEdges.length) {
    lines.push("%% truncated to the most-connected modules/edges; see graph.json for the full graph");
  }
  lines.push("flowchart LR");

  for (const tier of [0, 1, 2] as Tier[]) {
    const inTier = shown.filter((m) => m.tier === tier);
    if (!inTier.length) continue;
    lines.push(`  subgraph ${TIER_LABEL[tier]}`);
    for (const m of inTier) lines.push(`    ${clusterNodeId(m.slug)}["${m.path.replace(/"/g, "'")}"]`);
    lines.push("  end");
  }

  for (const e of edges) {
    const label = e.weight > 1 ? `|${e.weight}| ` : "";
    lines.push(`  ${clusterNodeId(e.from)} -->${label ? " " + label : " "}${clusterNodeId(e.to)}`);
  }

  return {
    content: "```mermaid\n" + lines.join("\n") + "\n```\n",
    shownModules: shown.length,
    totalModules: graph.modules.length,
    shownEdges: edges.length,
    totalEdges: graph.moduleEdges.length,
  };
}
