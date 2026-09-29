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
import { join } from "node:path";
import type { CodeSymbol, Edge, RawRelation } from "./types.js";
import type { RepoScan } from "./scan.js";
import type { ResolveContext } from "./resolve.js";
import { addDef, familyOf, pickCandidate, type DefTable } from "./calls.js";
import { createBindScope } from "./bind.js";
import { byStr } from "./sort.js";
import { refMatches, symbolRefReadings } from "./symref.js";
import { readText } from "./walk.js";

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

// name → family → every type-ish definition of it, deduped per file.
function typeDefs(scan: RepoScan): DefTable<TypeDef> {
  const defs: DefTable<TypeDef> = new Map();
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!TYPE_KINDS.has(s.kind)) continue;
      addDef(defs, s.name, { name: s.name, file: s.file, kind: s.kind, lang: s.lang, line: s.line });
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
export function resolveRelations(scan: RepoScan, importPairs: Set<string>, ctx?: ResolveContext): ResolvedRelation[] {
  return resolveAll(scan, importPairs, ctx).map((r) => r.rel);
}

// resolveRelations, keeping the base name each relation was WRITTEN with: an
// import may rename it (`from .sansio.blueprints import Blueprint as
// SansioBlueprint; class Blueprint(SansioBlueprint)`), and the hierarchy's
// unresolved pass matches the file's raw relations by that name.
function resolveAll(scan: RepoScan, importPairs: Set<string>, ctx?: ResolveContext): { rel: ResolvedRelation; written: string }[] {
  const defs = typeDefs(scan);
  // The call binder's view of imports: re-export hops, package mates and
  // import renames, so a base class and a call can never disagree about which
  // `Scheduler` a file means.
  const scope = createBindScope(scan, importPairs, ctx);
  const out: { rel: ResolvedRelation; written: string }[] = [];
  for (const f of scan.files) {
    if (!f.relations?.length) continue;
    const family = familyOf(f.lang);
    const aliases = scope.aliases(f);
    for (const r of f.relations) {
      const renamed = aliases.names.get(r.to);
      const name = renamed?.name ?? r.to;
      const group = defs.get(name)?.get(family);
      if (!group) continue;
      let target: TypeDef | undefined;
      if (renamed) {
        // The import says where the base comes from; outside the repo, nowhere.
        if (!renamed.files) continue;
        target = pickCandidate(f.rel, scope.within(group, renamed.files, name));
      } else {
        // Prefer a candidate the file actually imports (or declares itself);
        // fall back to proximity.
        const imported = scope.reached(group, f, name);
        const local = group.byFile.get(f.rel);
        if (local) imported.push(local);
        target = pickCandidate(f.rel, imported.length ? imported : group.list);
      }
      if (!target) continue;
      out.push({
        written: r.to,
        rel: {
          kind: CONTRACT_KINDS.has(target.kind) ? "implements" : r.kind,
          from: r.from,
          fromFile: f.rel,
          fromLine: r.line,
          to: target.name,
          toFile: target.file,
          toKind: target.kind,
        },
      });
    }
  }
  return out.sort(
    (x, y) =>
      byStr(x.rel.fromFile, y.rel.fromFile) || byStr(x.rel.from, y.rel.from) || byStr(x.rel.kind, y.rel.kind) || byStr(x.rel.to, y.rel.to),
  );
}

/**
 * File-level `extends`/`implements` edges, aggregated per (from, to, kind) pair.
 * Self-edges are dropped: a type extending another in the same file is a real
 * relation (the hierarchy reports it) but not a dependency between files.
 */
export function resolveRelationEdges(scan: RepoScan, importPairs: Set<string>, ctx?: ResolveContext): Edge[] {
  const agg = new Map<string, Edge>();
  for (const r of resolveRelations(scan, importPairs, ctx)) {
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
  /** A Go type whose method set covers the interface's, with no assertion saying so. */
  structural?: true;
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
  const all = resolveAll(scan, importPairs);
  const resolved = all.map((r) => r.rel);

  // Which declaration a (name, file) pair refers to.
  const entries = new Map<string, TypeHierarchyEntry>();
  const keyOf = (name: string, file: string): string => `${name}${SEP}${file}`;
  for (const families of defs.values()) {
    for (const d of [...families.values()].flatMap((g) => g.list)) {
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

  // Go states no implementations: a type implements an interface by having
  // its methods. Without these, `implementations Render` on gin answered []
  // while render.go lists sixteen `var _ Render = (*JSON)(nil)` assertions.
  for (const r of goImplementations(scan)) {
    const sub = entries.get(keyOf(r.from, r.fromFile));
    const sup = entries.get(keyOf(r.to, r.toFile));
    if (!sub || !sup) continue;
    const mark = (ref: HierarchyRef): HierarchyRef => (r.structural ? { ...ref, structural: true } : ref);
    sub.implements.push(mark(refTo(sup)));
    sup.implementedBy.push(mark(refTo(sub)));
  }

  // Declared-but-unresolvable supertypes, per declaring type.
  const resolvedKeys = new Set(all.map(({ rel: r, written }) => `${r.fromFile}${SEP}${r.from}${SEP}${r.kind}${SEP}${written}`));
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

/** A Go type implementing a Go interface, by assertion or by method set. */
export interface GoImplementation {
  from: string; // the type
  fromFile: string;
  to: string; // the interface
  toFile: string;
  /** Matched by method set alone; absent when a `var _ I = (*T)(nil)` assertion states it. */
  structural?: true;
}

// `var _ Render = (*JSON)(nil)`, `= JSON{}`, `= &JSON{}`, `= new(JSON)`: the
// compile-time assertion Go code writes when it wants the relation checked.
const GO_ASSERTION = /^_\s+([\w.]+)\s*=\s*(?:\(\s*\*\s*([\w.]+)\s*\)\s*\(\s*nil\s*\)|&?([\w.]+)\s*\{|new\(\s*([\w.]+)\s*\))/;

// A Go method's parameter count, read from its header: `func (r T) M(a, b
// int)` and the interface spec `M(int, int)` both have two. Commas at the
// top level of the parameter list only, so a `func(x, y int)` parameter is one.
function goParamCount(signature: string, name: string): number | undefined {
  const at = signature.indexOf(`${name}(`);
  if (at === -1) return undefined;
  let depth = 0;
  let count = 0;
  let empty = true;
  for (let i = at + name.length; i < signature.length; i++) {
    const c = signature[i]!;
    if (c === "(" || c === "[" || c === "{") {
      if (depth++ === 0) continue;
    } else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return empty ? 0 : count + 1;
    } else if (depth === 1 && c === ",") count++;
    if (depth >= 1 && !/\s/.test(c)) empty = false;
  }
  return undefined;
}

/**
 * Go interface implementations, which Go never states: a type implements an
 * interface when its methods cover the interface's (name and parameter count
 * here — deterministic and type-free, like the rest of the binder). An
 * interface embedding another resolves the embedded one's methods; one
 * embedding an interface from outside the repo (`io.Reader`) is only matched
 * through an explicit `var _ I = (*T)(nil)` assertion, since its full method
 * set is unknown. An interface with an unexported method is only implemented
 * inside its own package. Sorted.
 */
export function goImplementations(scan: RepoScan): GoImplementation[] {
  const dirOf = (rel: string): string => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
  const types = new Map<string, CodeSymbol>(); // `${dir}\0${name}` → the type declaration
  const typesByName = new Map<string, CodeSymbol[]>();
  const methods = new Map<string, Map<string, number | undefined>>(); // `${dir}\0${type}` → method → arity
  const byMethod = new Map<string, Set<string>>(); // method name → type keys declaring it
  const assertions: { sym: CodeSymbol; iface: string; type: string }[] = [];
  const goFiles = scan.files.filter((f) => f.lang === "go" && !f.rel.endsWith("_test.go"));
  for (const f of goFiles) {
    const dir = dirOf(f.rel);
    for (const s of f.symbols) {
      if (s.kind === "type" && !s.parent) {
        const key = `${dir}${SEP}${s.name}`;
        if (!types.has(key)) types.set(key, s);
        const list = typesByName.get(s.name) ?? [];
        list.push(s);
        typesByName.set(s.name, list);
      } else if (s.kind === "method" && s.parent) {
        const key = `${dir}${SEP}${s.parent}`;
        let set = methods.get(key);
        if (!set) methods.set(key, (set = new Map()));
        set.set(s.name, s.signature ? goParamCount(s.signature, s.name) : undefined);
        let owners = byMethod.get(s.name);
        if (!owners) byMethod.set(s.name, (owners = new Set()));
        owners.add(key);
      } else if (s.name === "_" && s.signature) {
        const m = GO_ASSERTION.exec(s.signature);
        if (m) assertions.push({ sym: s, iface: m[1]!, type: (m[2] ?? m[3] ?? m[4])! });
      }
    }
  }
  // A struct embedding another in its package promotes the embedded type's
  // methods (extraction reads the embedding as `extends`). A few rounds cover
  // an embedding chain; each is sorted so the result never depends on order.
  const embeds: [string, string][] = [];
  for (const f of goFiles) {
    for (const r of f.relations ?? []) {
      if (r.kind === "extends" && /^\w+$/.test(r.to)) embeds.push([`${dirOf(f.rel)}${SEP}${r.from}`, `${dirOf(f.rel)}${SEP}${r.to}`]);
    }
  }
  embeds.sort((a, b) => byStr(a[0], b[0]) || byStr(a[1], b[1]));
  for (let round = 0; round < 3; round++) {
    for (const [sub, sup] of embeds) {
      const promoted = methods.get(sup);
      if (!promoted) continue;
      let own = methods.get(sub);
      if (!own) methods.set(sub, (own = new Map()));
      for (const [m, n] of promoted) {
        if (own.has(m)) continue; // the outer type's own method shadows it
        own.set(m, n);
        byMethod.get(m)!.add(sub);
      }
    }
  }

  // `Render interface {…}`, `Set[T any] interface {…}`.
  const isInterface = (s: CodeSymbol): boolean =>
    !!s.signature?.startsWith(s.name) && /^(\[[^\]]*\])?\s+interface\b/.test(s.signature.slice(s.name.length));

  // An interface's full method set, or undefined when it is not knowable here.
  const setMemo = new Map<string, Map<string, number | undefined> | null>();
  const methodSet = (key: string, iface: CodeSymbol, seen: Set<string>): Map<string, number | undefined> | undefined => {
    const memo = setMemo.get(key);
    if (memo !== undefined) return memo ?? undefined;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const own = new Map(methods.get(key) ?? []);
    let known = true;
    // Embedded interfaces are body lines naming a type (`Reader`, `io.Writer`);
    // a type-set line (`~int | ~string`) makes it a constraint, not a contract.
    const body = readText(join(scan.root, iface.file)).split("\n").slice(iface.line, (iface.endLine ?? iface.line) - 1);
    for (const raw of body) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (/[~|]/.test(line) && !line.includes("(")) known = false;
      if (!/^[\w.]+$/.test(line)) continue; // a method spec, or one line of one
      const dot = line.lastIndexOf(".");
      const embedded = dot === -1 ? types.get(`${dirOf(iface.file)}${SEP}${line}`) : undefined;
      const inner = embedded && isInterface(embedded) ? methodSet(`${dirOf(embedded.file)}${SEP}${embedded.name}`, embedded, seen) : undefined;
      if (!inner) known = false;
      else for (const [m, n] of inner) own.set(m, n);
    }
    const out = known && own.size ? own : undefined;
    setMemo.set(key, out ?? null);
    return out;
  };

  const found = new Map<string, GoImplementation>(); // `${typeKey}\0${ifaceKey}`
  const add = (type: CodeSymbol, iface: CodeSymbol, structural: boolean): void => {
    const k = `${type.file}${SEP}${type.name}${SEP}${iface.file}${SEP}${iface.name}`;
    const prev = found.get(k);
    if (prev) {
      if (!structural) delete prev.structural;
      return;
    }
    found.set(k, { from: type.name, fromFile: type.file, to: iface.name, toFile: iface.file, ...(structural ? { structural: true as const } : {}) });
  };

  for (const [ikey, iface] of [...types].sort((a, b) => byStr(a[0], b[0]))) {
    if (!isInterface(iface)) continue;
    const want = methodSet(ikey, iface, new Set());
    if (!want) continue;
    const names = [...want.keys()].sort(byStr);
    const internal = names.some((m) => !/^[A-Z]/.test(m));
    // Walk the owners of the interface's rarest method only.
    const rarest = names.reduce((a, b) => ((byMethod.get(b)?.size ?? 0) < (byMethod.get(a)?.size ?? 0) ? b : a));
    for (const tkey of [...(byMethod.get(rarest) ?? [])].sort(byStr)) {
      if (tkey === ikey) continue;
      const type = types.get(tkey);
      if (!type || isInterface(type)) continue;
      if (internal && dirOf(type.file) !== dirOf(iface.file)) continue;
      const have = methods.get(tkey)!;
      const covers = names.every((m) => {
        if (!have.has(m)) return false;
        const a = have.get(m);
        const b = want.get(m);
        return a === undefined || b === undefined || a === b;
      });
      if (covers) add(type, iface, true);
    }
  }

  // Assertions: the interface and the type by name, in the asserting file's
  // package first (a qualified `pkg.Name` by its last segment).
  const lookup = (name: string, dir: string): CodeSymbol | undefined => {
    const bare = name.slice(name.lastIndexOf(".") + 1);
    if (!name.includes(".")) {
      const local = types.get(`${dir}${SEP}${bare}`);
      if (local) return local;
    }
    const all = (typesByName.get(bare) ?? []).slice().sort((a, b) => byStr(a.file, b.file));
    return all.length === 1 ? all[0] : undefined;
  };
  for (const a of assertions) {
    const dir = dirOf(a.sym.file);
    const iface = lookup(a.iface, dir);
    const type = lookup(a.type, dir);
    if (iface && type && isInterface(iface) && !isInterface(type)) add(type, iface, false);
  }

  return [...found.values()].sort(
    (x, y) => byStr(x.fromFile, y.fromFile) || byStr(x.from, y.from) || byStr(x.toFile, y.toFile) || byStr(x.to, y.to),
  );
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
  declarations?: readonly { name: string; file: string }[],
): HierarchyRef[] {
  const root = typeEntry(hierarchy, name, declarations);
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
        // Not `get(name) ?? get(name@file)`: for any homonym but the first,
        // the bare key answers with ANOTHER file's type and the walk stopped
        // there, dropping everything below a second same-named subtype.
        const entry = entryAt(hierarchy, child.name, child.file);
        if (entry) next.push(entry);
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => byStr(a.name, b.name) || byStr(a.file, b.file));
}

/**
 * The type a symbol ref names — `Name`, `Name@file`, `file#Name` (see
 * src/symref.ts). A bare name answers with the key the hierarchy stores it
 * under (the first homonym); the qualified forms reach every homonym.
 *
 * Entries do not record where a type is nested, so a ref constraining the
 * PARENT (`Outer/Inner`, `file#Outer/Inner`) is settled by `declarations`:
 * what the ref resolved to against the scan (query.ts resolveSymbolRef).
 */
export function typeEntry(
  hierarchy: Map<string, TypeHierarchyEntry>,
  name: string,
  declarations?: readonly { name: string; file: string }[],
): TypeHierarchyEntry | undefined {
  const direct = hierarchy.get(name);
  if (direct) return direct;
  for (const reading of symbolRefReadings(name).slice(1)) {
    if (reading.parent !== undefined) continue;
    for (const e of hierarchy.values()) if (refMatches(reading, e)) return e;
  }
  for (const d of declarations ?? []) {
    const e = entryAt(hierarchy, d.name, d.file);
    if (e) return e;
  }
  return undefined;
}

// The entry for the type `name` declared in `file`: the bare key holds the
// first homonym, `name@file` every other (buildTypeHierarchy's keying).
function entryAt(hierarchy: Map<string, TypeHierarchyEntry>, name: string, file: string): TypeHierarchyEntry | undefined {
  const bare = hierarchy.get(name);
  return bare?.file === file ? bare : hierarchy.get(`${name}@${file}`);
}
