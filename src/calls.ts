import type { Edge } from "./types.js";
import type { RepoScan } from "./scan.js";
import { byStr } from "./sort.js";

// Symbol kinds that are references to a definition elsewhere (a barrel re-export
// or `export default Foo`) — they must NOT count as a call target, which should
// resolve to where a symbol is actually declared. Re-declared here (canonical
// copy lives in graph.ts) so this module has no import cycle with the graph
// builder, which imports resolveCallEdges.
const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

// Collapse TypeScript/JavaScript to one family so a call in a `.ts` file can bind
// to a def in a `.js` file (and vice versa) but never crosses into an unrelated
// language. Every other language is its own family.
function familyOf(lang: string): string {
  return lang === "typescript" || lang === "javascript" ? "js" : lang;
}

// Leading path segments two repo-relative paths share (the filename never counts,
// as it always differs between distinct files). Higher = closer in the tree.
function sharedSegments(a: string, b: string): number {
  const as = a.split("/");
  const bs = b.split("/");
  let n = 0;
  while (n < as.length && n < bs.length && as[n] === bs[n]) n++;
  return n;
}

interface Cand {
  file: string;
  lang: string;
}

// Pick a single candidate for a call: the sole candidate, else the one sharing
// the strictly-most leading path segments with the caller. A tie at the maximum
// (or an empty list) is unresolvable — return undefined so the caller skips it.
function pick(callerRel: string, cands: Cand[]): Cand | undefined {
  if (cands.length === 1) return cands[0];
  if (cands.length === 0) return undefined;
  let best: Cand | undefined;
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

// Resolve every collected call site to a cross-file `call` edge in a global second
// pass. An import between the two files promotes the edge to `extracted`; a unique
// repo-wide name match with no import yields `inferred`. JS/TS is import-gated (no
// import ⇒ no edge) because its bare identifiers are too ambiguous to infer safely;
// other languages fall back to a unique-name inference. Deterministic: the emitted
// array is sorted and never depends on Map iteration order.
export function resolveCallEdges(scan: RepoScan, importPairs: Set<string>): Edge[] {
  // name → distinct def sites (deduped per file; overloads collapse to one file).
  const defs = new Map<string, Cand[]>();
  const seen = new Set<string>();
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!s.exported || REFERENCE_KINDS.has(s.kind)) continue;
      const dedup = `${s.name} ${s.file}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      let arr = defs.get(s.name);
      if (!arr) defs.set(s.name, (arr = []));
      arr.push({ file: s.file, lang: s.lang });
    }
  }

  // (from|to) → aggregated edge. Strongest confidence wins; counts sum.
  const agg = new Map<string, { from: string; to: string; weight: number; confidence: "extracted" | "inferred" }>();
  for (const f of scan.files) {
    if (!f.calls?.length) continue;
    const family = familyOf(f.lang);
    const ownNames = new Set(f.symbols.map((s) => s.name));
    const counts = new Map<string, number>();
    for (const c of f.calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);

    for (const [name, count] of counts) {
      if (ownNames.has(name)) continue; // same-file call — not a cross-file edge
      const cands = (defs.get(name) ?? []).filter((d) => familyOf(d.lang) === family && d.file !== f.rel);
      if (!cands.length) continue;
      const imported = cands.filter((d) => importPairs.has(`${f.rel}|${d.file}`));

      let chosen: Cand | undefined;
      let confidence: "extracted" | "inferred";
      if (family === "js") {
        // JS/TS gate: without an import corroborating the call, drop it entirely.
        // A named-import binding (f.importedNames) corroborates a name but not the
        // file it came from, so it can't narrow `imported` further — pick among
        // the imported candidates by proximity.
        if (!imported.length) continue;
        chosen = pick(f.rel, imported);
        confidence = "extracted";
      } else if (imported.length) {
        chosen = pick(f.rel, imported);
        confidence = "extracted";
      } else {
        chosen = pick(f.rel, cands);
        confidence = "inferred";
      }
      if (!chosen) continue;

      const key = `${f.rel}|${chosen.file}`;
      const prev = agg.get(key);
      if (prev) {
        prev.weight += count;
        if (confidence === "extracted") prev.confidence = "extracted";
      } else {
        agg.set(key, { from: f.rel, to: chosen.file, weight: count, confidence });
      }
    }
  }

  return [...agg.values()]
    .map((e) => ({ from: e.from, to: e.to, kind: "call" as const, weight: Math.min(e.weight, 5), confidence: e.confidence }))
    .sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to));
}
