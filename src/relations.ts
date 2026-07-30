// Resolving the inheritance a file STATES into edges between files, and into a
// repo-wide type hierarchy.
//
// Extraction (ast/specs.ts relationsFrom) yields `{kind, from, to}` with both
// ends as bare type NAMES, because a single file cannot know where `BaseWorker`
// lives. This module is the second pass that does: it binds each target name to
// a definition site with the SAME rules the call graph uses (language family
// gating, import corroboration, proximity tie-break — `familyOf`/`pickCandidate`
// from calls.ts), so inheritance and calls can never disagree about which
// `Scheduler` is meant.
//
// It also CORRECTS the syntactic guess. C# writes `class S : BaseWorker,
// IRunnable` with no syntax distinguishing the base class from the interfaces,
// and Python's `class S(Protocol)` looks like plain subclassing. Extraction
// reports its best reading; here, where every symbol's kind is known, a target
// that resolves to an interface/trait becomes `implements` whatever the source
// looked like.
import type { Edge, RawRelation } from "./types.js";
import type { RepoScan } from "./scan.js";
import { familyOf, pickCandidate, type Cand } from "./calls.js";
import { byStr } from "./sort.js";

// Internal Map-key separator. Written as an ESCAPE, never as a literal NUL: a
// literal one makes git, grep and file(1) treat this source as binary, and makes
// codeindex drop the file from its own index (readText sniffs a NUL as "binary").
// Same character at runtime; see src/graph.ts, which learned this the hard way.
// Only has to be a character no path or relation kind can contain.
const SEP = "\u0000";

// Kinds that are a CONTRACT rather than an implementation. A relation whose
// target is one of these is `implements`, however the source spelled it.
const CONTRACT_KINDS = new Set(["interface", "trait", "protocol"]);

// Symbol kinds that can be the endpoint of an inheritance relation. Filtering to
// these keeps a same-named function or constant from capturing a base-type name.
const TYPE_KINDS = new Set([
  "class",
  "interface",
  "trait",
  "struct",
  "type",
  "enum",
  "record",
  "object",
  "protocol",
  "module",
  "mod",
  "union",
  "annotation",
]);

/** One inheritance link with both ends bound to a declaration site. */
export interface ResolvedRelation {
  kind: "extends" | "implements";
  from: string; // subtype name
  fromFile: string;
  fromLine: number;
  to: string; // supertype name
  toFile: string;
  toKind: string;
}

interface TypeDef {
  name: string;
  file: string;
  kind: string;
  lang: string;
  line: number;
}

// name → every type-ish definition of it, deduped per file.
function typeDefs(scan: RepoScan): Map<string, TypeDef[]> {
  const defs = new Map<string, TypeDef[]>();
  const seen = new Set<string>();
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!TYPE_KINDS.has(s.kind)) continue;
      const dedup = `${s.name} ${s.file}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let arr = defs.get(s.name);
      if (!arr) defs.set(s.name, (arr = []));
      arr.push({ name: s.name, file: s.file, kind: s.kind, lang: s.lang, line: s.line });
    }
  }
  return defs;
}

/**
 * Every inheritance relation in the repo whose target resolves to a declaration
 * here. Targets that do not (a framework base class, `std::exception`) are
 * omitted — they are reported per-type as `unresolved` by the hierarchy below,
 * so the information is available without inventing an edge to nothing.
 *
 * Deterministic: sorted, and never dependent on Map iteration order.
 */
export function resolveRelations(scan: RepoScan, importPairs: Set<string>): ResolvedRelation[] {
  const defs = typeDefs(scan);
  const out: ResolvedRelation[] = [];
  for (const f of scan.files) {
    if (!f.relations?.length) continue;
    const family = familyOf(f.lang);
    for (const r of f.relations) {
      const cands = (defs.get(r.to) ?? []).filter((d) => familyOf(d.lang) === family);
      if (!cands.length) continue;
      // Prefer a candidate the file actually imports; fall back to proximity.
      const imported = cands.filter((d) => importPairs.has(`${f.rel}|${d.file}`) || d.file === f.rel);
      const pool = imported.length ? imported : cands;
      const chosen = pickCandidate(f.rel, pool.map((d): Cand => ({ file: d.file, lang: d.lang })));
      if (!chosen) continue;
      const target = pool.find((d) => d.file === chosen.file)!;
      out.push({
        kind: CONTRACT_KINDS.has(target.kind) ? "implements" : r.kind,
        from: r.from,
        fromFile: f.rel,
        fromLine: r.line,
        to: target.name,
        toFile: target.file,
        toKind: target.kind,
      });
    }
  }
  return out.sort(
    (a, b) => byStr(a.fromFile, b.fromFile) || byStr(a.from, b.from) || byStr(a.kind, b.kind) || byStr(a.to, b.to),
  );
}

/**
 * File-level `extends`/`implements` edges, aggregated per (from, to, kind) pair.
 * Self-edges are dropped: a type extending another in the same file is a real
 * relation (the hierarchy reports it) but not a dependency between files.
 */
export function resolveRelationEdges(scan: RepoScan, importPairs: Set<string>): Edge[] {
  const agg = new Map<string, Edge>();
  for (const r of resolveRelations(scan, importPairs)) {
    if (r.toFile === r.fromFile) continue;
    const key = `${r.fromFile}${SEP}${r.toFile}${SEP}${r.kind}`;
    const prev = agg.get(key);
    if (prev) prev.weight = Math.min(prev.weight + 1, 5);
    else agg.set(key, { from: r.fromFile, to: r.toFile, kind: r.kind, weight: 1 });
  }
  return [...agg.values()].sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to) || byStr(a.kind, b.kind));
}

/** One end of a relation, as reported by the hierarchy. */
export interface HierarchyRef {
  name: string;
  file: string;
  line: number;
  kind: string;
}

export interface TypeHierarchyEntry {
  name: string;
  file: string;
  line: number;
  kind: string;
  /** Base classes/supertraits this type declares, resolved. */
  extends: HierarchyRef[];
  /** Interfaces/traits/mixins this type provides, resolved. */
  implements: HierarchyRef[];
  /** Types that extend THIS one. */
  extendedBy: HierarchyRef[];
  /** Types that implement THIS one — the "who implements this interface" answer. */
  implementedBy: HierarchyRef[];
  /** Declared supertypes with no definition in this repo (a framework base class). */
  unresolved: { kind: "extends" | "implements"; to: string }[];
}

/**
 * The full type hierarchy, keyed by `name` (and by `name@file` for a homonym
 * declared in more than one file, mirroring how the caller index disambiguates).
 * Insertion order is sorted, so serializing the map is deterministic.
 */
export function buildTypeHierarchy(scan: RepoScan, importPairs: Set<string>): Map<string, TypeHierarchyEntry> {
  const defs = typeDefs(scan);
  const resolved = resolveRelations(scan, importPairs);

  // Which declaration a (name, file) pair refers to.
  const entries = new Map<string, TypeHierarchyEntry>();
  const keyOf = (name: string, file: string): string => `${name}${SEP}${file}`;
  for (const arr of defs.values()) {
    for (const d of arr) {
      entries.set(keyOf(d.name, d.file), {
        name: d.name,
        file: d.file,
        line: d.line,
        kind: d.kind,
        extends: [],
        implements: [],
        extendedBy: [],
        implementedBy: [],
        unresolved: [],
      });
    }
  }

  const refTo = (e: TypeHierarchyEntry): HierarchyRef => ({ name: e.name, file: e.file, line: e.line, kind: e.kind });

  for (const r of resolved) {
    const sub = entries.get(keyOf(r.from, r.fromFile));
    const sup = entries.get(keyOf(r.to, r.toFile));
    if (!sup) continue;
    if (sub) {
      (r.kind === "extends" ? sub.extends : sub.implements).push(refTo(sup));
      (r.kind === "extends" ? sup.extendedBy : sup.implementedBy).push(refTo(sub));
    } else {
      // The subtype itself is not a type-kinded symbol (a Ruby `include` inside
      // a module, say) — still record the reverse direction, which is the
      // question consumers ask.
      (r.kind === "extends" ? sup.extendedBy : sup.implementedBy).push({
        name: r.from,
        file: r.fromFile,
        line: r.fromLine,
        kind: "unknown",
      });
    }
  }

  // Declared-but-unresolvable supertypes, per declaring type.
  const resolvedKeys = new Set(resolved.map((r) => `${r.fromFile}${SEP}${r.from}${SEP}${r.kind}${SEP}${r.to}`));
  for (const f of scan.files) {
    for (const r of f.relations ?? []) {
      if (resolvedKeys.has(`${f.rel}${SEP}${r.from}${SEP}${r.kind}${SEP}${r.to}`)) continue;
      // A corrected kind (extends → implements) means it DID resolve.
      const other: RawRelation["kind"] = r.kind === "extends" ? "implements" : "extends";
      if (resolvedKeys.has(`${f.rel}${SEP}${r.from}${SEP}${other}${SEP}${r.to}`)) continue;
      entries.get(keyOf(r.from, f.rel))?.unresolved.push({ kind: r.kind, to: r.to });
    }
  }

  const sortRefs = (a: HierarchyRef, b: HierarchyRef): number => byStr(a.name, b.name) || byStr(a.file, b.file);
  const out = new Map<string, TypeHierarchyEntry>();
  const sortedKeys = [...entries.keys()].sort(byStr);
  for (const k of sortedKeys) {
    const e = entries.get(k)!;
    e.extends.sort(sortRefs);
    e.implements.sort(sortRefs);
    e.extendedBy.sort(sortRefs);
    e.implementedBy.sort(sortRefs);
    e.unresolved.sort((a, b) => byStr(a.kind, b.kind) || byStr(a.to, b.to));
    // One entry per name; a homonym in another file gets the qualified key.
    if (!out.has(e.name)) out.set(e.name, e);
    else out.set(`${e.name}@${e.file}`, e);
  }
  return out;
}

/**
 * Everything that implements or extends `name`, TRANSITIVELY — the practical
 * form of "who implements this interface": a class implementing a sub-interface
 * of the one asked about is an implementation too, and a caller should not have
 * to walk the chain itself. Breadth-first, cycle-safe, deterministic.
 */
export function implementationsOf(
  hierarchy: Map<string, TypeHierarchyEntry>,
  name: string,
): HierarchyRef[] {
  const root = hierarchy.get(name);
  if (!root) return [];
  const seen = new Set<string>([`${root.name}${SEP}${root.file}`]);
  const out: HierarchyRef[] = [];
  let frontier: TypeHierarchyEntry[] = [root];
  while (frontier.length) {
    const next: TypeHierarchyEntry[] = [];
    for (const e of frontier) {
      for (const child of [...e.implementedBy, ...e.extendedBy]) {
        const key = `${child.name}${SEP}${child.file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(child);
        const entry = hierarchy.get(child.name) ?? hierarchy.get(`${child.name}@${child.file}`);
        if (entry && entry.file === child.file) next.push(entry);
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => byStr(a.name, b.name) || byStr(a.file, b.file));
}

/** The declaration `name` refers to, for callers that only have a name. */
export function typeEntry(
  hierarchy: Map<string, TypeHierarchyEntry>,
  name: string,
): TypeHierarchyEntry | undefined {
  return hierarchy.get(name);
}
