import type { Edge } from "./types.js";
import type { RepoScan } from "./scan.js";
import type { ResolveContext } from "./resolve.js";
import { createCallBinder } from "./bind.js";
import { byStr } from "./sort.js";

// Collapse TypeScript/JavaScript to one family so a call in a `.ts` file can bind
// to a def in a `.js` file (and vice versa) but never crosses into an unrelated
// language. Every other language is its own family. Shared by every binder
// (src/bind.ts, relations.ts) and by the SCIP renderer.
export function familyOf(lang: string): string {
  if (lang === "typescript" || lang === "javascript") return "js";
  // C and C++ interoperate through headers (.h files classify as "c" while
  // their consumers are often .cpp) — one family, like the JS/TS pair.
  if (lang === "c" || lang === "cpp") return "c";
  return lang;
}

// Leading path segments two repo-relative paths share (the filename never counts,
// as it always differs between distinct files). Higher = closer in the tree.
//
// Walks the characters instead of splitting both paths: pickCandidate scores
// EVERY candidate of an ambiguous name, and splitting allocated two arrays per
// candidate. Same count as comparing `a.split("/")` with `b.split("/")`
// pairwise: each "/" passed while the strings agree closes an equal segment,
// and the segment in progress where they stop is equal only if both end there.
function sharedSegments(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let n = 0;
  let i = 0;
  for (; i < len; i++) {
    const c = a.charCodeAt(i);
    if (c !== b.charCodeAt(i)) break;
    if (c === 47 /* "/" */) n++;
  }
  const endA = i === a.length || a.charCodeAt(i) === 47;
  const endB = i === b.length || b.charCodeAt(i) === 47;
  return endA && endB ? n + 1 : n;
}

export interface Cand {
  file: string;
  lang: string;
}

// Pick a single candidate for a call: the sole candidate, else the one sharing
// the strictly-most leading path segments with the caller. A tie at the maximum
// (or an empty list) is unresolvable — return undefined so the caller skips it.
// The answer depends on the candidate SET, never its order: a strictly higher
// score clears `tied`, so it ends true exactly when the maximum occurs twice.
// Returns the chosen object itself, so a binder passing richer records (a
// CodeSymbol, a type def) gets its own record back.
export function pickCandidate<T extends Cand>(callerRel: string, cands: readonly T[]): T | undefined {
  if (cands.length === 1) return cands[0];
  if (cands.length === 0) return undefined;
  let best: T | undefined;
  let bestScore = -1;
  let tied = false;
  for (const c of cands) {
    const s = sharedSegments(callerRel, c.file);
    if (s > bestScore) {
      bestScore = s;
      best = c;
      tied = false;
    } else if (s === bestScore) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

// --- Shared binder plumbing -------------------------------------------------
// The call-site binder (src/bind.ts) and resolveRelations (relations.ts) both
// bind a NAME to one of its definitions by asking the same questions: which
// defs share the caller's language family, which of those an import
// corroborates, which is closest. Answering them per site by filtering every
// same-name def and building a `${from}|${to}` key per candidate is quadratic
// in homonyms, and the TypeScript repo's test fixtures declare `C` 5,335 times
// and `A` 2,449 times. These helpers group the defs ONCE and intersect them
// with the caller's (few) import targets instead.

/** One name's definitions within ONE language family. */
export interface DefGroup<T extends Cand> {
  list: T[]; // registration order — the proximity fallback's pool
  byFile: Map<string, T>; // for intersecting with a caller's import targets
}

/** name → language family → definitions. Filled with addDef. */
export type DefTable<T extends Cand> = Map<string, Map<string, DefGroup<T>>>;

// Register `def` as a definition of `name`. The first def per (name, file)
// wins — the dedup each binder applied with its own `${name} ${file}` set — so
// a later one returns false and is dropped, whatever its family.
export function addDef<T extends Cand>(table: DefTable<T>, name: string, def: T): boolean {
  let families = table.get(name);
  if (!families) table.set(name, (families = new Map()));
  for (const group of families.values()) if (group.byFile.has(def.file)) return false;
  const family = familyOf(def.lang);
  let group = families.get(family);
  if (!group) families.set(family, (group = { list: [], byFile: new Map() }));
  group.list.push(def);
  group.byFile.set(def.file, def);
  return true;
}

// `${from}|${to}` import pairs regrouped as from → the files it imports, so a
// binder asks "does this file import that one" without building a string per
// candidate. Self-pairs are dropped: the call binders never weigh a same-file
// def here and relations admit one unconditionally, so neither consulted them.
// A path may itself contain "|"; such a pair is registered under EVERY split
// point, which keeps `targets.get(a)?.has(b)` exactly `pairs.has(`${a}|${b}`)`
// without having to know which split is the real one.
export function importTargets(pairs: Iterable<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const pair of pairs) {
    for (let i = pair.indexOf("|"); i !== -1; i = pair.indexOf("|", i + 1)) {
      const from = pair.slice(0, i);
      const to = pair.slice(i + 1);
      if (from === to) continue;
      let set = out.get(from);
      if (!set) out.set(from, (set = new Set()));
      set.add(to);
    }
  }
  return out;
}

// The defs of `group` an import corroborates: those living in one of the
// caller's import targets. Walks whichever side is smaller — a file imports a
// handful of others, a fixture name can have thousands of definitions. The
// order follows the walked side, which no binder observes (pickCandidate is
// order-independent; everything else only counts). Always a fresh array the
// caller may extend; never the caller's own file (importTargets drops self-pairs).
export function importedDefs<T extends Cand>(group: DefGroup<T>, targets: ReadonlySet<string> | undefined): T[] {
  if (!targets?.size) return [];
  if (targets.size < group.list.length) {
    const out: T[] = [];
    for (const file of targets) {
      const d = group.byFile.get(file);
      if (d) out.push(d);
    }
    return out;
  }
  return group.list.filter((d) => targets.has(d.file));
}

// The group's defs outside `rel`: a call never binds cross-file to its own
// file. Allocates only when `rel` itself declares the name.
export function defsOutside<T extends Cand>(group: DefGroup<T>, rel: string): readonly T[] {
  return group.byFile.has(rel) ? group.list.filter((d) => d.file !== rel) : group.list;
}

// Resolve every collected call site to a cross-file `call` edge in a global second
// pass, through the shared call-site binder (src/bind.ts), so graph.json, the
// caller index and the symbol graph agree on every call. An edge is `extracted`
// when stated evidence backs it — an import between the files, a re-export
// chain, package membership — and `inferred` when a unique or nearest name
// match alone does, which the binder never allows for JS/TS or Go (their
// names cross files only through an import or a package), into a test file,
// or from the product into tail material. A call bound inside its own file is
// not an edge. Deterministic: the emitted array is sorted and never depends on
// Map iteration order.
export function resolveCallEdges(scan: RepoScan, importPairs: Set<string>, ctx?: ResolveContext): Edge[] {
  const binder = createCallBinder(scan, importPairs, { ctx });
  // (from|to) → aggregated edge. Strongest confidence wins; counts sum.
  const agg = new Map<string, { from: string; to: string; weight: number; confidence: "extracted" | "inferred" }>();
  for (const f of scan.files) {
    const bind = binder.forFile(f);
    if (!bind) continue;
    for (const c of f.calls!) {
      const hit = bind(c);
      if (!hit || hit.def.file === f.rel) continue;
      const confidence = hit.corroborated ? "extracted" : "inferred";
      const key = `${f.rel}|${hit.def.file}`;
      const prev = agg.get(key);
      if (prev) {
        prev.weight += 1;
        if (confidence === "extracted") prev.confidence = "extracted";
      } else {
        agg.set(key, { from: f.rel, to: hit.def.file, weight: 1, confidence });
      }
    }
  }

  return [...agg.values()]
    .map((e) => ({ from: e.from, to: e.to, kind: "call" as const, weight: Math.min(e.weight, 5), confidence: e.confidence }))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to));
}
