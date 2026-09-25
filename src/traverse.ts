// Graph traversal over a built link-graph: "what depends on this" (impact) and
// "what sits next to this" (neighbors). Both are pure functions of a `Graph` —
// no scan, no filesystem — so a consumer holding a persisted graph.json can
// answer them without re-walking the repo.
//
// Both share one hub gate. A hyper-connected node (a barrel, a types module)
// otherwise drags the entire graph into any depth-≥2 neighbourhood, which is
// the difference between an answer and a dump.
import type { Edge, EdgeKind, Graph } from "./types.js";
import { byStr } from "./sort.js";

// Only these edge kinds carry a real "depends on" relation. A doc-link or a
// mention says something references the name, not that it would break.
const DEPENDS_KINDS = new Set(["import", "use", "call"]);

// The traversal-relevant fields of an edge list, captured when a derived view
// is built so a later call can prove the list still describes the same graph.
//
// WHY A SNAPSHOT AND NOT AN IDENTITY CHECK. `Graph.fileEdges` / `moduleEdges`
// are public, MUTABLE arrays. A consumer can retarget an edge IN PLACE, which
// leaves both the array's identity and its length unchanged — so a cache keyed
// on those alone answers with the pre-edit graph, which is the one behaviour a
// cache must never have. Values are copied BY REFERENCE into one flat array (no
// new strings), so checking is a handful of pointer comparisons per edge.
//
// It is not free, though: on a 9 153-edge graph a check costs roughly what
// rebuilding the dependents map costs, which is exactly why reverseClosure
// above does not cache at all and this one does.
const FIELDS = 6;
function snapshot(edges: Edge[]): unknown[] {
  const snap = new Array<unknown>(edges.length * FIELDS);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const o = i * FIELDS;
    snap[o] = e.from;
    snap[o + 1] = e.to;
    snap[o + 2] = e.kind;
    snap[o + 3] = e.weight;
    snap[o + 4] = e.dangling;
    snap[o + 5] = e.confidence;
  }
  return snap;
}
function unchanged(edges: Edge[], snap: unknown[]): boolean {
  if (snap.length !== edges.length * FIELDS) return false;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    const o = i * FIELDS;
    if (
      snap[o] !== e.from ||
      snap[o + 1] !== e.to ||
      snap[o + 2] !== e.kind ||
      snap[o + 3] !== e.weight ||
      snap[o + 4] !== e.dangling ||
      snap[o + 5] !== e.confidence
    ) {
      return false;
    }
  }
  return true;
}


interface Adjacency {
  out: Map<string, Edge[]>; // from → edges, sorted by `to`
  inn: Map<string, Edge[]>; // to → edges, sorted by `from`
  degree: Map<string, number>;
  threshold: number; // hubThreshold over this view's degree distribution
}
// Adjacency, built ONCE per edge list and kept as long as the list itself, then
// re-validated against the snapshot above on every hit. bfs() otherwise rebuilt
// two maps, re-sorted every neighbour list and recomputed the degree
// distribution on each call, while an MCP session answers many neighbors calls
// over one graph: 200 calls over a 9 153-edge graph, 189 ms → 38 ms. Lists are
// pre-sorted with the comparator the per-call sort used, on the same insertion
// order, so the traversal visits exactly the same sequence.
const adjacencyMemo = new WeakMap<Edge[], { snap: unknown[]; views: Map<string, Adjacency> }>();
function adjacencyOf(edges: Edge[], kinds?: Set<string>): Adjacency {
  const viewKey = kinds ? [...kinds].sort(byStr).join(",") : "*";
  let entry = adjacencyMemo.get(edges);
  // One snapshot per edge list covers every kind-filtered view built from it.
  if (!entry || !unchanged(edges, entry.snap)) {
    adjacencyMemo.set(edges, (entry = { snap: snapshot(edges), views: new Map() }));
  }
  const cached = entry.views.get(viewKey);
  if (cached) return cached;
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
  for (const arr of out.values()) arr.sort((a, b) => byStr(a.to, b.to));
  for (const arr of inn.values()) arr.sort((a, b) => byStr(a.from, b.from));
  const adj = { out, inn, degree, threshold: hubThreshold([...degree.values()]) };
  entry.views.set(viewKey, adj);
  return adj;
}

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
  // How many more dependents a call edge inferred from a name alone would add
  // (impactOf's `includeInferred`); present only when they are left out and
  // there are some.
  inferredDependents?: number;
}

export interface ClosureOptions {
  /** Leave out `call` edges inferred from a name alone (Edge.confidence "inferred"). */
  skipInferred?: boolean;
  /**
   * Read a Go import as an import of the whole package. Go imports a
   * directory, and the resolver lands it on ONE representative file of it, so
   * without this the other files of a package have no importers at all: gin's
   * render/render.go (the Render interface) showed no dependents while
   * `render` had 61.
   */
  goPackages?: boolean;
}

const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const isGoSource = (rel: string): boolean => rel.endsWith(".go") && !rel.endsWith("_test.go");

// Reverse dependency closure: every file that transitively IMPORTS, USES, or
// CALLS one of `seeds`, out to `depth` hops (default: the full closure).
// Deliberately UNCACHED, and sorting only the buckets the walk actually visits.
// Both matter: an impact closure usually reaches a handful of nodes, so sorting
// every bucket up front costs more than the walk itself (200 impactOf calls
// over a 9 153-edge graph: 78 ms this way, 132 ms sorting eagerly), and proving
// a cached map still matches its edge list costs about as much as rebuilding
// it. adjacencyOf below is the opposite trade — two maps, two sorts and a
// degree distribution per call — and does earn its cache.
export function reverseClosure(edges: Edge[], seeds: string[], depth = Infinity, opts: ClosureOptions = {}): Map<string, number> {
  const dependents = new Map<string, Edge[]>(); // target file → incoming depends-on edges
  const packageImports = new Map<string, Edge[]>(); // Go package dir → imports of it (goPackages)
  const push = (m: Map<string, Edge[]>, key: string, e: Edge): void => {
    const arr = m.get(key);
    if (arr) arr.push(e);
    else m.set(key, [e]);
  };
  for (const e of edges) {
    if (e.dangling || !DEPENDS_KINDS.has(e.kind)) continue;
    if (opts.skipInferred && e.confidence === "inferred") continue;
    push(dependents, e.to, e);
    if (opts.goPackages && e.kind === "import" && e.to.endsWith(".go")) push(packageImports, dirOf(e.to), e);
  }
  const depthOf = new Map<string, number>();
  const seen = new Set<string>(seeds);
  let frontier = [...seeds];
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      let incoming = dependents.get(node) ?? [];
      // A package's importers depend on each of its non-test files.
      if (opts.goPackages && isGoSource(node)) incoming = incoming.concat(packageImports.get(dirOf(node)) ?? []);
      for (const e of incoming.slice().sort((a, b) => byStr(a.from, b.from))) {
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

export interface ImpactOptions {
  /** Also follow `call` edges inferred from a name alone (default false: they are counted, not walked). */
  includeInferred?: boolean;
}

// "What breaks if I change this." Accepts a module slug or a file rel. A call
// edge inferred from a name alone is a guess, not a dependency, so by default
// it is only counted (inferredDependents); a Go import reaches every file of
// the package it names.
export function impactOf(graph: Graph, target: string, depth = Infinity, opts: ImpactOptions = {}): ImpactResult | undefined {
  const moduleOf = new Map(graph.files.map((f) => [f.rel, f.module]));
  const mod = graph.modules.find((m) => m.slug === target);
  const file = mod ? undefined : graph.files.find((f) => f.rel === target);
  if (!mod && !file) return undefined;

  const seeds = mod ? mod.members : [file!.rel];
  const includeInferred = opts.includeInferred === true;
  const depthOf = reverseClosure(graph.fileEdges, seeds, depth, { skipInferred: !includeInferred, goPackages: true });
  const files: ImpactedFile[] = [...depthOf.entries()]
    .map(([rel, d]) => ({ rel, module: moduleOf.get(rel) ?? "root", depth: d }))
    .sort((a, b) => a.depth - b.depth || byStr(a.rel, b.rel));
  const modules = [...new Set(files.map((f) => f.module).filter((m) => m !== target))].sort(byStr);

  const result: ImpactResult = { target, scope: mod ? "module" : "file", seeds, files, modules };
  if (!includeInferred) {
    // With more edges the closure only grows, so the difference is exactly
    // the files inference alone would add.
    const extra = reverseClosure(graph.fileEdges, seeds, depth, { goPackages: true }).size - depthOf.size;
    if (extra > 0) result.inferredDependents = extra;
  }
  return result;
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

// Every edge kind a link-graph can carry: what `neighbors --kind` accepts. A
// misspelt kind used to filter the walk down to nothing and answer an empty
// list with exit 0, indistinguishable from "no neighbours".
export const EDGE_KINDS: readonly EdgeKind[] = ["import", "call", "use", "extends", "implements", "doc-link", "mention", "contains"];

// How much a link says about the dependency, strongest first: what a file
// states (import, inheritance, an import-corroborated call), then name-based
// evidence, then a call inferred from a unique name alone.
function linkRank(l: NeighborLink): number {
  if (l.kind === "call") return l.confidence === "inferred" ? 4 : 1;
  if (l.kind === "import" || l.kind === "extends" || l.kind === "implements") return 0;
  if (l.kind === "use") return 2;
  return 3;
}

// Breadth-first walk from `start`, out to `depth` hops, in BOTH directions.
// With `kinds` set, only those edge kinds are traversed — and the degree
// distribution feeding the hub gate is measured over that same filtered
// subgraph, so the gate reflects the view the caller asked for.
//
// EVERY edge between the frontier and a node first reached at this depth is a
// link, one per (node, direction, kind), not just the first edge found. The
// walk used to keep only that first one, and out-edges come first, so gin's
// `render` showed `root` as an (inferred, and wrong) outgoing call and hid the
// real incoming import behind it. A node's links are listed together, in the
// order its node was reached, strongest evidence first — a consumer reading
// only a node's first link gets the relation that matters.
function bfs(edges: Edge[], start: string, depth: number, kinds?: Set<string>): NeighborLink[] {
  // A non-start node at or above the threshold is EMITTED as a link but never
  // expanded THROUGH. Only bites at depth ≥ 2 — depth-1 links all come from
  // `start`, which always expands.
  const { out, inn, degree, threshold } = adjacencyOf(edges, kinds);
  const seen = new Set<string>([start]);
  const links: NeighborLink[] = [];
  let frontier = [start];
  for (let d = 1; d <= depth; d++) {
    // node → its links at this depth. Map order is the order nodes were first
    // reached: deterministic, since the adjacency lists are pre-sorted.
    const reached = new Map<string, NeighborLink[]>();
    const link = (node: string, direction: "out" | "in", e: Edge): void => {
      let own = reached.get(node);
      if (!own) {
        if (seen.has(node)) return; // reached at an earlier depth (or the start)
        seen.add(node);
        reached.set(node, (own = []));
      }
      // Several frontier nodes may reach one node the same way: the first wins.
      if (own.some((l) => l.direction === direction && l.kind === e.kind)) return;
      own.push({ node, direction, kind: e.kind, weight: e.weight, depth: d, confidence: e.confidence });
    };
    for (const node of frontier) {
      if (node !== start && (degree.get(node) ?? 0) >= threshold) continue;
      for (const e of out.get(node) ?? []) link(e.to, "out", e);
      for (const e of inn.get(node) ?? []) link(e.from, "in", e);
    }
    for (const own of reached.values()) {
      own.sort(
        (a, b) => linkRank(a) - linkRank(b) || Number(a.direction === "in") - Number(b.direction === "in") || byStr(a.kind, b.kind),
      );
      links.push(...own);
    }
    frontier = [...reached.keys()];
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
