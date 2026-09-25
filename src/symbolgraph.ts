// The graph at SYMBOL granularity, and bounded neighborhoods of it.
//
// WHY THIS EXISTS. `graph.json` links files, and `callers` answers one inbound
// hop for one symbol. Neither answers the question an agent actually asks before
// changing something: "what does this reach, and what reaches it, a couple of
// hops out?" Answering it from the file graph is far too coarse (one file's
// twenty symbols become one node), and answering it from `callers` means the
// agent issuing a fan of calls and stitching the result together itself.
//
// So this derives symbol→symbol edges from data that already exists — call sites
// with their enclosing declaration (callers.ts) and resolved inheritance
// (relations.ts) — and walks a bounded neighborhood. Nothing new is persisted:
// the graph is built on demand from the scan, so no artifact or schema grows.
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { createCallBinder } from "./bind.js";
import { enclosingAmong } from "./callers.js";
import { familyOf } from "./calls.js";
import { goImplementations, resolveRelations } from "./relations.js";
import { byStr } from "./sort.js";
import { shortestPaths, type PathHop } from "./paths.js";
import { symbolRefReadings } from "./symref.js";

// Internal Map-key separator. Written as an ESCAPE, never as a literal NUL: a
// literal one makes git, grep and file(1) treat this source as binary, and makes
// codeindex drop the file from its own index (readText sniffs a NUL as "binary").
// Same character at runtime; see src/graph.ts, which learned this the hard way.
// Only has to be a character no path or edge kind can contain.
const SEP = "\u0000";

// Symbol kinds that only POINT at a definition elsewhere; they must never be an
// edge endpoint, or a barrel would absorb the neighborhood of everything it
// re-exports. Same set the caller index and the graph builder use.
const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

// `overrides`: a method to the supertype method of the same name it replaces
// (or implements). A call site binds to the method its receiver's DECLARED
// type names — `x.area()` on a `Shape` reaches `Shape/area` — while at run
// time any override may answer; the walk below follows these edges so a
// neighborhood shows what dispatch can reach.
export type SymbolEdgeKind = "calls" | "extends" | "implements" | "overrides";

export interface SymbolNode {
  /** Stable id: `file#Parent/name` for a member, `file#name` otherwise. */
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine?: number;
  exported: boolean;
  doc?: string;
  signature?: string;
}

export interface SymbolEdge {
  from: string; // node id
  to: string; // node id
  kind: SymbolEdgeKind;
  /** How many distinct call sites back a `calls` edge. Always 1 for inheritance and overrides. */
  weight: number;
}

export interface SymbolGraph {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
  /** id → outgoing edges, and id → incoming; both sorted. */
  out: Map<string, SymbolEdge[]>;
  in: Map<string, SymbolEdge[]>;
  /** name → every node id declaring it, for looking a symbol up by bare name. */
  byName: Map<string, string[]>;
}

export function symbolId(s: Pick<CodeSymbol, "file" | "name" | "parent">): string {
  return s.parent ? `${s.file}#${s.parent}/${s.name}` : `${s.file}#${s.name}`;
}

function toNode(s: CodeSymbol): SymbolNode {
  return {
    id: symbolId(s),
    name: s.name,
    kind: s.kind,
    file: s.file,
    line: s.line,
    ...(s.endLine !== undefined ? { endLine: s.endLine } : {}),
    exported: s.exported,
    ...(s.doc ? { doc: s.doc } : {}),
    ...(s.signature ? { signature: s.signature } : {}),
  };
}

/**
 * Build the symbol graph. `importPairs` is the resolved-import pair set the call
 * binder uses for corroboration — pass the memoised one (derived.ts) so this
 * shares work with the rest of a session.
 *
 * Deterministic: edges are aggregated into a Map keyed by (from, to, kind) and
 * sorted before return, so two builds of one scan agree exactly.
 */
export function buildSymbolGraph(scan: RepoScan, importPairs: Set<string>): SymbolGraph {
  const nodes = new Map<string, SymbolNode>();
  // Per-file symbol lists, filtered once and reused for every call site in that
  // file (the reason enclosingAmong is factored out of enclosingSymbol).
  const perFile = new Map<string, CodeSymbol[]>();

  for (const f of scan.files) {
    const usable: CodeSymbol[] = [];
    for (const s of f.symbols) {
      if (REFERENCE_KINDS.has(s.kind)) continue;
      usable.push(s);
      nodes.set(symbolId(s), toNode(s));
    }
    perFile.set(f.rel, usable);
  }

  const agg = new Map<string, SymbolEdge>();
  const add = (from: string, to: string, kind: SymbolEdgeKind): void => {
    if (from === to) return; // self-recursion is not a navigable hop
    const key = `${from}${SEP}${to}${SEP}${kind}`;
    const prev = agg.get(key);
    if (prev) prev.weight += 1;
    else agg.set(key, { from, to, kind, weight: 1 });
  };

  // --- calls: enclosing declaration → resolved callee declaration -----------
  // Bound by the shared call-site binder (src/bind.ts), so this graph, the
  // caller index and graph.json's call edges agree on every site. The binder
  // gets the enclosing declaration too: it tells `c.Next()` inside a Go
  // method on `c` from `c.Next()` anywhere else.
  const binder = createCallBinder(scan, importPairs);
  for (const f of scan.files) {
    const bind = binder.forFile(f);
    if (!bind) continue;
    const own = perFile.get(f.rel) ?? [];
    for (const c of f.calls!) {
      const caller = enclosingAmong(own, c.line);
      if (!caller) continue; // a call at file scope has no symbol to attribute it to
      const hit = bind(c, caller);
      if (hit) add(symbolId(caller), symbolId(hit.def), "calls");
    }
  }

  // --- inheritance: subtype declaration → supertype declaration -------------
  // Go states no implementations; the type hierarchy's assertion and
  // method-set matches (relations.ts goImplementations) stand in for them.
  const typeIdByNameFile = new Map<string, string>();
  // A top-level declaration wins over a same-named member of the same file:
  // Go's `Render` interface declares a `Render` method.
  for (const node of nodes.values()) {
    const key = `${node.name} ${node.file}`;
    if (!typeIdByNameFile.has(key) || node.id === `${node.file}#${node.name}`) typeIdByNameFile.set(key, node.id);
  }
  const relations: TypeRelation[] = resolveRelations(scan, importPairs);
  for (const r of goImplementations(scan)) relations.push({ ...r, kind: "implements" });
  for (const r of relations) {
    const from = typeIdByNameFile.get(`${r.from} ${r.fromFile}`);
    const to = typeIdByNameFile.get(`${r.to} ${r.toFile}`);
    if (from && to) add(from, to, r.kind);
  }

  // --- overrides: method → the supertype method it replaces -----------------
  for (const { sub, sup } of overridePairs(scan, relations)) add(symbolId(sub), symbolId(sup), "overrides");

  const edges = [...agg.values()].sort(
    (a, b) => byStr(a.from, b.from) || byStr(a.kind, b.kind) || byStr(a.to, b.to),
  );

  const out = new Map<string, SymbolEdge[]>();
  const inc = new Map<string, SymbolEdge[]>();
  for (const e of edges) {
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e);
  }

  const byName = new Map<string, string[]>();
  for (const id of [...nodes.keys()].sort(byStr)) {
    const n = nodes.get(id)!;
    (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(id);
  }

  return { nodes, edges, out, in: inc, byName };
}

/** An inheritance link between two type declarations, by name and file. */
export interface TypeRelation {
  kind: "extends" | "implements";
  from: string;
  fromFile: string;
  to: string;
  toFile: string;
}

// Member kinds that can override: what a subtype redefines under the same name.
const METHOD_KINDS = new Set(["method", "function", "def", "getter", "setter", "operator"]);

/**
 * Every method that overrides (or implements) a supertype's method: for each
 * inheritance relation, each method of the subtype paired with the NEAREST
 * declaration of the same name up the supertype chain — `Square/area` with
 * `Base/area`, and `Base/area` with `Shape/area`, not `Square/area` with
 * both. A Go type's methods may live in any file of its package, so Go types
 * are keyed by directory. Sorted by (sub, sup) id.
 */
export function overridePairs(scan: RepoScan, relations: readonly TypeRelation[]): { sub: CodeSymbol; sup: CodeSymbol }[] {
  const langOf = new Map(scan.files.map((f) => [f.rel, f.lang]));
  const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
  const typeKey = (name: string, file: string): string =>
    familyOf(langOf.get(file) ?? "") === "go" ? `go${SEP}${dirOf(file)}${SEP}${name}` : `${file}${SEP}${name}`;

  const members = new Map<string, Map<string, CodeSymbol>>();
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!s.parent || !METHOD_KINDS.has(s.kind)) continue;
      const key = typeKey(s.parent, s.file);
      let own = members.get(key);
      if (!own) members.set(key, (own = new Map()));
      if (!own.has(s.name)) own.set(s.name, s);
    }
  }
  const supers = new Map<string, string[]>();
  for (const r of relations) {
    const k = typeKey(r.from, r.fromFile);
    const list = supers.get(k) ?? [];
    const sup = typeKey(r.to, r.toFile);
    if (sup !== k && !list.includes(sup)) list.push(sup);
    supers.set(k, list);
  }
  for (const list of supers.values()) list.sort(byStr);

  // The nearest declarations of `name` above type `key`, one per branch.
  const nearest = (key: string, name: string, seen: Set<string>, out: CodeSymbol[]): void => {
    for (const sup of supers.get(key) ?? []) {
      if (seen.has(sup)) continue;
      seen.add(sup);
      const decl = members.get(sup)?.get(name);
      if (decl) out.push(decl);
      else nearest(sup, name, seen, out);
    }
  };

  const out: { sub: CodeSymbol; sup: CodeSymbol }[] = [];
  for (const key of [...supers.keys()].sort(byStr)) {
    const own = members.get(key);
    if (!own) continue;
    for (const name of [...own.keys()].sort(byStr)) {
      const found: CodeSymbol[] = [];
      nearest(key, name, new Set([key]), found);
      for (const sup of found) out.push({ sub: own.get(name)!, sup });
    }
  }
  return out.sort((a, b) => byStr(symbolId(a.sub), symbolId(b.sub)) || byStr(symbolId(a.sup), symbolId(b.sup)));
}

export type Direction = "out" | "in" | "both";

export interface Neighborhood {
  /** Every declaration matching the requested name — the walk starts from all of them. */
  root: SymbolNode[];
  /** Reached nodes with the hop count at which each was first seen (root = 0). */
  nodes: (SymbolNode & { depth: number })[];
  edges: SymbolEdge[];
  /** True when the node cap stopped the walk short. */
  truncated?: true;
  /** The hop limit actually walked, present when a deeper walk was asked for. */
  depthClamped?: number;
}

const MAX_DEPTH = 5;
const MAX_NODES = 400;

// The nodes a symbol ref names (src/symref.ts): an exact id, else the first
// reading that matches any node. Ids carry the IMMEDIATE parent only
// (`file#Parent/name`), so a longer `Outer/Parent/name` path is checked on its
// last segment.
function rootIdsFor(graph: SymbolGraph, ref: string): string[] {
  if (graph.nodes.has(ref)) return [ref];
  for (const reading of symbolRefReadings(ref)) {
    const parent = reading.parent?.slice(reading.parent.lastIndexOf("/") + 1);
    const ids = (graph.byName.get(reading.name) ?? []).filter((id) => {
      const n = graph.nodes.get(id)!;
      if (reading.file !== undefined && n.file !== reading.file) return false;
      return parent === undefined || id === `${n.file}#${parent}/${n.name}`;
    });
    if (ids.length) return ids;
  }
  return [];
}

/**
 * The bounded neighborhood of a symbol. Breadth-first, so `depth` is the true
 * hop distance; cycle-safe; capped at MAX_NODES with `truncated` set rather than
 * quietly returning a partial answer.
 */
export function neighborhood(
  graph: SymbolGraph,
  name: string,
  opts: { depth?: number; direction?: Direction } = {},
): Neighborhood {
  const requested = opts.depth ?? 2;
  const depthLimit = Math.max(1, Math.min(requested, MAX_DEPTH));
  const direction = opts.direction ?? "both";

  // A bare name, `name@file`, a `Parent/name` path, or a `file#Parent/name` id.
  const rootIds = rootIdsFor(graph, name);
  const root = rootIds.map((id) => graph.nodes.get(id)!);
  if (!root.length) return { root: [], nodes: [], edges: [] };

  const depthOf = new Map<string, number>();
  for (const id of rootIds) depthOf.set(id, 0);
  const picked = new Map<string, SymbolEdge>();
  let frontier = [...rootIds];
  let truncated = false;

  for (let d = 1; d <= depthLimit && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      const step = (edges: SymbolEdge[] | undefined, other: (e: SymbolEdge) => string): void => {
        for (const e of edges ?? []) {
          picked.set(`${e.from}${SEP}${e.to}${SEP}${e.kind}`, e);
          const o = other(e);
          if (depthOf.has(o)) continue;
          if (depthOf.size >= MAX_NODES) {
            truncated = true;
            continue;
          }
          depthOf.set(o, d);
          next.push(o);
        }
      };
      // Dispatch runs against the edge: walking out through a method reaches
      // the methods overriding it (a call to `Shape/area` may run
      // `Square/area`), and walking in to an override reaches the callers of
      // the method it overrides. An override never reaches its base the other
      // way round, so a one-way walk takes `overrides` edges backwards only.
      const outs = graph.out.get(id);
      const ins = graph.in.get(id);
      if (direction === "both") {
        step(outs, (e) => e.to);
        step(ins, (e) => e.from);
      } else if (direction === "out") {
        step(outs?.filter((e) => e.kind !== "overrides"), (e) => e.to);
        step(ins?.filter((e) => e.kind === "overrides"), (e) => e.from);
      } else {
        step(ins?.filter((e) => e.kind !== "overrides"), (e) => e.from);
        step(outs?.filter((e) => e.kind === "overrides"), (e) => e.to);
      }
    }
    frontier = next;
  }

  const nodes = [...depthOf.entries()]
    .map(([id, depth]) => ({ ...graph.nodes.get(id)!, depth }))
    .sort((a, b) => a.depth - b.depth || byStr(a.file, b.file) || byStr(a.name, b.name));
  // Keep only edges whose BOTH ends are inside the returned set, so the result
  // is a self-contained subgraph rather than one with dangling references.
  const edges = [...picked.values()]
    .filter((e) => depthOf.has(e.from) && depthOf.has(e.to))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.kind, b.kind) || byStr(a.to, b.to));

  return {
    root,
    nodes,
    edges,
    ...(truncated ? { truncated: true as const } : {}),
    // Said out loud: `--depth 9` used to walk five hops without a word.
    ...(requested > MAX_DEPTH ? { depthClamped: MAX_DEPTH } : {}),
  };
}

export interface CallPathStep {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  // How the previous step reaches this one: it calls it, or it is a method
  // this one overrides, so a call to it may run this one. Absent on the first.
  via?: "calls" | "dispatch";
}

export interface CallPath {
  from: SymbolNode[]; // every declaration the `from` ref names
  to: SymbolNode[];
  hops: number | null; // null when no path within the hop limit
  paths: CallPathStep[][]; // shortest paths, lexicographic by id, at most maxPaths
  pathCount: number; // every shortest path, listed or not
  truncated?: true; // paths lists fewer than pathCount
  depthClamped?: number; // the hop limit walked, when more was asked for
  // No path from → to, but `to` reaches `from` in this many hops: the question
  // was probably asked the wrong way round.
  reverseHops?: number;
}

const PATH_DEFAULT_DEPTH = 8;
const PATH_MAX_DEPTH = 16;

/**
 * How does `from` reach `to`? The shortest chains of calls between them,
 * following dispatch the way a `direction: out` neighborhood does: a call to a
 * method may run any method overriding it. Inheritance edges are not steps — a
 * class extending another does not "reach" it at run time.
 *
 * Both refs take every symbol-ref form (src/symref.ts); a bare name starts
 * from, or ends at, every homonym. An unknown ref answers an empty `from` or
 * `to`, which callers report as an error.
 */
export function callPath(
  graph: SymbolGraph,
  fromRef: string,
  toRef: string,
  opts: { depth?: number; maxPaths?: number } = {},
): CallPath {
  const requested = opts.depth ?? PATH_DEFAULT_DEPTH;
  const maxHops = Math.max(1, Math.min(requested, PATH_MAX_DEPTH));
  const maxPaths = Math.max(1, opts.maxPaths ?? 5);
  const fromIds = rootIdsFor(graph, fromRef);
  const toIds = rootIdsFor(graph, toRef);
  const from = fromIds.map((id) => graph.nodes.get(id)!);
  const to = toIds.map((id) => graph.nodes.get(id)!);
  const clamped = requested > PATH_MAX_DEPTH ? { depthClamped: PATH_MAX_DEPTH } : {};
  if (!from.length || !to.length) return { from, to, hops: null, paths: [], pathCount: 0, ...clamped };

  const next = function* (id: string): Generator<readonly [string, string]> {
    for (const e of graph.out.get(id) ?? []) if (e.kind === "calls") yield [e.to, "calls"];
    for (const e of graph.in.get(id) ?? []) if (e.kind === "overrides") yield [e.from, "dispatch"];
  };
  const found = shortestPaths(fromIds, new Set(toIds), next, maxHops, maxPaths);
  const step = (hop: PathHop): CallPathStep => {
    const n = graph.nodes.get(hop.node)!;
    return { id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line, ...(hop.via ? { via: hop.via as CallPathStep["via"] } : {}) };
  };
  const result: CallPath = {
    from,
    to,
    hops: found.hops,
    paths: found.paths.map((p) => p.map(step)),
    pathCount: found.pathCount,
    ...(found.paths.length < found.pathCount ? { truncated: true as const } : {}),
    ...clamped,
  };
  if (found.hops === null) {
    const back = shortestPaths(toIds, new Set(fromIds), next, maxHops, 0);
    if (back.hops !== null) result.reverseHops = back.hops;
  }
  return result;
}
