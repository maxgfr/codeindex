// Graph traversal over a built link-graph: "what depends on this" (impact) and
// "what sits next to this" (neighbors). Both are pure functions of a `Graph` —
// no scan, no filesystem — so a consumer holding a persisted graph.json can
// answer them without re-walking the repo.
//
// Both share one hub gate. A hyper-connected node (a barrel, a types module)
// otherwise drags the entire graph into any depth-≥2 neighbourhood, which is
// the difference between an answer and a dump.
import type { Edge, Graph } from "./types.js";
import { byStr } from "./sort.js";

// Only these edge kinds carry a real "depends on" relation. A doc-link or a
// mention says something references the name, not that it would break.
const DEPENDS_KINDS = new Set(["import", "use", "call"]);

// The hub-gating threshold over a degree distribution: max(50, p99). p99 = the
// degree at index min(n-1, floor(0.99n)) of the ASCENDING degree array (numeric
// sort — deterministic without byStr).
//
// Deliberately DEGREE-based even though the graph carries pagerank/betweenness:
// the gate exists to bound traversal fan-out, and degree IS the fan-out cost —
// a high-pagerank/low-degree node is safe to expand through. It is also
// computed per call, so a kind-filtered view gates on that same subgraph rather
// than on a whole-graph metric that does not describe it. The 50 floor makes it
// a no-op on small graphs (never worse than ungated).
export function hubThreshold(degrees: number[]): number {
  const sorted = degrees.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const p99 = n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(0.99 * n))]!;
  return Math.max(50, p99);
}

export interface ImpactedFile {
  rel: string;
  module: string;
  depth: number; // hops from the target (1 = direct dependent)
}

export interface ImpactResult {
  target: string;
  scope: "module" | "file";
  seeds: string[]; // the files whose dependents we traced
  files: ImpactedFile[]; // transitive dependents, nearest first
  modules: string[]; // distinct modules touched
}

// Reverse dependency closure: every file that transitively IMPORTS, USES, or
// CALLS one of `seeds`, out to `depth` hops (default: the full closure).
export function reverseClosure(edges: Edge[], seeds: string[], depth = Infinity): Map<string, number> {
  const dependents = new Map<string, Edge[]>(); // target file → incoming depends-on edges
  for (const e of edges) {
    if (e.dangling || !DEPENDS_KINDS.has(e.kind)) continue;
    let arr = dependents.get(e.to);
    if (!arr) dependents.set(e.to, (arr = []));
    arr.push(e);
  }
  const depthOf = new Map<string, number>();
  const seen = new Set<string>(seeds);
  let frontier = [...seeds];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const e of (dependents.get(node) ?? []).slice().sort((a, b) => byStr(a.from, b.from))) {
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        depthOf.set(e.from, d);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return depthOf;
}

// "What breaks if I change this." Accepts a module slug or a file rel.
export function impactOf(graph: Graph, target: string, depth = Infinity): ImpactResult | undefined {
  const moduleOf = new Map(graph.files.map((f) => [f.rel, f.module]));
  const mod = graph.modules.find((m) => m.slug === target);
  const file = mod ? undefined : graph.files.find((f) => f.rel === target);
  if (!mod && !file) return undefined;

  const seeds = mod ? mod.members : [file!.rel];
  const depthOf = reverseClosure(graph.fileEdges, seeds, depth);
  const files: ImpactedFile[] = [...depthOf.entries()]
    .map(([rel, d]) => ({ rel, module: moduleOf.get(rel) ?? "root", depth: d }))
    .sort((a, b) => a.depth - b.depth || byStr(a.rel, b.rel));
  const modules = [...new Set(files.map((f) => f.module).filter((m) => m !== target))].sort(byStr);

  return { target, scope: mod ? "module" : "file", seeds, files, modules };
}

export interface NeighborLink {
  node: string;
  direction: "out" | "in";
  kind: string;
  weight: number;
  depth: number;
  confidence?: "extracted" | "inferred"; // only on a `call` edge — see Edge.confidence
}

export interface NeighborResult {
  target: string;
  scope: "module" | "file";
  links: NeighborLink[];
  members?: string[]; // for a module target
}

// Breadth-first walk from `start`, out to `depth` hops, in BOTH directions.
// With `kinds` set, only those edge kinds are traversed — and the degree
// distribution feeding the hub gate is measured over that same filtered
// subgraph, so the gate reflects the view the caller asked for.
function bfs(edges: Edge[], start: string, depth: number, kinds?: Set<string>): NeighborLink[] {
  const out = new Map<string, Edge[]>();
  const inn = new Map<string, Edge[]>();
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (e.dangling) continue;
    if (kinds && !kinds.has(e.kind)) continue;
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  // A non-start node at or above the threshold is EMITTED as a link but never
  // expanded THROUGH. Only bites at depth ≥ 2 — depth-1 links all come from
  // `start`, which always expands.
  const threshold = hubThreshold([...degree.values()]);
  const seen = new Set<string>([start]);
  const links: NeighborLink[] = [];
  let frontier = [start];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      if (node !== start && (degree.get(node) ?? 0) >= threshold) continue;
      for (const e of (out.get(node) ?? []).slice().sort((a, b) => byStr(a.to, b.to))) {
        if (seen.has(e.to)) continue;
        links.push({ node: e.to, direction: "out", kind: e.kind, weight: e.weight, depth: d, confidence: e.confidence });
        seen.add(e.to);
        next.push(e.to);
      }
      for (const e of (inn.get(node) ?? []).slice().sort((a, b) => byStr(a.from, b.from))) {
        if (seen.has(e.from)) continue;
        links.push({ node: e.from, direction: "in", kind: e.kind, weight: e.weight, depth: d, confidence: e.confidence });
        seen.add(e.from);
        next.push(e.from);
      }
    }
    frontier = next;
  }
  return links;
}

// What links to / from a module slug or a file rel, out to `depth` hops.
export function neighborsOf(graph: Graph, target: string, depth = 1, kinds?: Set<string>): NeighborResult | undefined {
  const mod = graph.modules.find((m) => m.slug === target);
  if (mod) {
    return { target, scope: "module", links: bfs(graph.moduleEdges, target, depth, kinds), members: mod.members };
  }
  const file = graph.files.find((f) => f.rel === target);
  if (file) {
    return { target, scope: "file", links: bfs(graph.fileEdges, target, depth, kinds) };
  }
  return undefined;
}
