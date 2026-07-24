// Per-symbol caller index (ultrasec parity): which call sites reach each
// defined symbol, at (file, line) granularity — the data taint analysis and
// impact tooling need. Mirrors resolveCallEdges' binding rules (family gating,
// import corroboration for JS/TS, proximity tie-breaking) but keeps individual
// call sites instead of aggregating to file→file edges, and binds same-file
// calls to the local def (shadowing wins over a cross-file match).
//
// ONE deliberate difference from resolveCallEdges: a barrel's re-export
// (`export { greet } from "./lib.js"`) does NOT count as a local def here, so
// a call in the barrel binds through to the real declaration — the caller
// index answers "who calls greet", and the barrel does. resolveCallEdges
// keeps its 5.1.0-lineage behavior (any own symbol suppresses the edge) so
// graph.json stays byte-compatible with ultraindex.
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { familyOf, pickCandidate, type Cand } from "./calls.js";
import { importPairsFor } from "./derived.js";
import { byStr } from "./sort.js";

const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

export interface CallerSite {
  file: string;
  line: number; // 1-based line of the call site
  // Present only in recall mode (issue #7): how the site was bound.
  // "corroborated" = an import between the files backs the binding (or the def
  // is in the caller's own file); "unique-name" = bound by name evidence alone
  // (the JS/TS unique-repo-wide relaxation, or a non-JS/TS inference without an
  // import). Default (precision) mode never sets it — output is byte-unchanged.
  confidence?: "corroborated" | "unique-name";
}

export interface CallerIndexOptions {
  // Recall-oriented mode (issue #7, ultrasec taint walks): relax the JS/TS
  // import gate so a call ALSO binds when the callee name is defined in exactly
  // one other file of the language family repo-wide, and label every recorded
  // site with a `confidence`. Prefers false positives over missed sinks.
  recall?: boolean;
}

export interface CallerEntry {
  def: CodeSymbol; // where the symbol is declared
  callers: CallerSite[]; // sorted by (file, line)
}

// name → entry, in sorted name order (Map preserves insertion order, so
// serializing the index is deterministic without re-sorting).
export type CallerIndex = Map<string, CallerEntry>;

// `${from}|${to}` pairs of resolved imports — the same corroboration set the
// graph builder feeds resolveCallEdges. Computed (and memoized) per scan in
// src/derived.ts; callers that already ran the graph can pass their own set
// instead. Returns a FRESH Set — the public contract is that the caller owns
// the result, so a consumer mutation must never reach the cached set.
export function computeImportPairs(scan: RepoScan): Set<string> {
  return new Set(importPairsFor(scan));
}

export function buildCallerIndex(
  scan: RepoScan,
  importPairs?: Set<string>,
  opts: CallerIndexOptions = {},
): CallerIndex {
  // Read-only use of the memoized pair set (no copy needed: only .has below).
  // The INDEX built here is always fresh — the public path never memoizes it;
  // the default-opts cache lives in derived.ts's callerIndexFor.
  const pairs = importPairs ?? importPairsFor(scan);
  const recall = opts.recall === true;

  // name → def sites (first symbol per (name, file) wins, like resolveCallEdges).
  const defs = new Map<string, CodeSymbol[]>();
  for (const f of scan.files) {
    const seen = new Set<string>();
    for (const s of f.symbols) {
      if (!s.exported || REFERENCE_KINDS.has(s.kind)) continue;
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      let arr = defs.get(s.name);
      if (!arr) defs.set(s.name, (arr = []));
      arr.push(s);
    }
  }
  // Same-file binding also needs non-exported defs (a private helper shadows
  // an exported symbol of the same name elsewhere).
  const localDefs = new Map<string, Map<string, CodeSymbol>>();
  for (const f of scan.files) {
    const byName = new Map<string, CodeSymbol>();
    for (const s of f.symbols) {
      if (!REFERENCE_KINDS.has(s.kind) && !byName.has(s.name)) byName.set(s.name, s);
    }
    localDefs.set(f.rel, byName);
  }

  const sites = new Map<string, { def: CodeSymbol; callers: CallerSite[] }>();
  const record = (def: CodeSymbol, caller: CallerSite): void => {
    let entry = sites.get(def.name + "\0" + def.file);
    if (!entry) sites.set(def.name + "\0" + def.file, (entry = { def, callers: [] }));
    entry.callers.push(caller);
  };

  for (const f of scan.files) {
    if (!f.calls?.length) continue;
    const family = familyOf(f.lang);
    const own = localDefs.get(f.rel)!;
    for (const c of f.calls) {
      const local = own.get(c.name);
      if (local) {
        // Shadowing: a same-file def wins. Skip the def line itself — a regex
        // collector may re-match the declaration.
        if (local.line !== c.line)
          record(local, recall ? { file: f.rel, line: c.line, confidence: "corroborated" } : { file: f.rel, line: c.line });
        continue;
      }
      const cands: Cand[] = (defs.get(c.name) ?? [])
        .filter((d) => familyOf(d.lang) === family && d.file !== f.rel)
        .map((d) => ({ file: d.file, lang: d.lang }));
      if (!cands.length) continue;
      const imported = cands.filter((d) => pairs.has(`${f.rel}|${d.file}`));
      const chosen =
        family === "js"
          ? imported.length
            ? pickCandidate(f.rel, imported)
            : // JS/TS gate: no corroborating import → no binding. Recall mode
              // relaxes this to a unique-repo-wide name match (issue #7).
              recall && cands.length === 1
              ? cands[0]
              : undefined
          : imported.length
            ? pickCandidate(f.rel, imported)
            : pickCandidate(f.rel, cands);
      if (!chosen) continue;
      const def = defs.get(c.name)!.find((d) => d.file === chosen.file)!;
      record(
        def,
        recall
          ? { file: f.rel, line: c.line, confidence: imported.length ? "corroborated" : "unique-name" }
          : { file: f.rel, line: c.line },
      );
    }
  }

  // Deterministic assembly: names sorted, then def file; caller sites sorted.
  const index: CallerIndex = new Map();
  const keys = [...sites.keys()].sort(byStr);
  for (const key of keys) {
    const { def, callers } = sites.get(key)!;
    callers.sort((a, b) => byStr(a.file, b.file) || a.line - b.line);
    // One entry per name: when the same name has entries for several def files
    // (rare — family-disjoint homonyms), the first sorted key wins and later
    // ones merge their callers under a qualified "name@file" key.
    if (!index.has(def.name)) index.set(def.name, { def, callers });
    else index.set(`${def.name}@${def.file}`, { def, callers });
  }
  return index;
}

// The innermost symbol whose declaration encloses (file, line). With AST
// records `endLine` bounds the answer exactly; regex records have no endLine,
// so the nearest preceding declaration is returned — a documented
// approximation. Returns undefined outside any known symbol.
export function enclosingSymbol(scan: RepoScan, file: string, line: number): CodeSymbol | undefined {
  const f = scan.files.find((x) => x.rel === file);
  if (!f?.symbols.length) return undefined;
  return enclosingAmong(f.symbols, line);
}

// Shared innermost-declaration search, factored out of enclosingSymbol() so
// buildRawCallerIndex can pre-filter/sort a file's symbols ONCE per file and
// reuse this scan per call site, instead of paying enclosingSymbol()'s
// `scan.files.find` (O(files)) on every single call site.
function enclosingAmong(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const s of symbols) {
    if (REFERENCE_KINDS.has(s.kind)) continue;
    if (s.line > line) continue;
    if (s.endLine !== undefined && line > s.endLine) continue;
    // Prefer the innermost: the latest starting declaration that still covers
    // the line (ties broken toward the one with the tighter end bound).
    if (!best || s.line > best.line || (s.line === best.line && (s.endLine ?? Infinity) <= (best.endLine ?? Infinity))) {
      best = s;
    }
  }
  return best;
}

// Raw-recall caller index (issue #8): every NAME-MATCHED call site, keyed by
// the callee's raw name as written (`FileRecord.calls[].name`) — no
// definition resolution and NO gating of any kind (no language-family filter,
// no JS/TS import-corroboration gate, no confidence labeling, no same-file
// exclusion, not even the "call at the same line as its own declaration"
// self-reference skip buildCallerIndex applies). The downstream consumer
// (ultrasec's taint-BFS) walks call sites outward from a source toward a
// sink; a site dropped here is a path the walk can never traverse, so recall
// is the entire contract — every candidate beats a missed vuln. Where
// buildCallerIndex answers "who calls this DEFINED, RESOLVED symbol",
// buildRawCallerIndex answers "where does this NAME get called", full stop.
//
// Bounded by the per-file call cap: FileRecord.calls truncates at 512
// call-sites per file, name+line deduped (src/types.ts, FileRecord.calls doc).
// A single generated/vendored file with more raw call sites than that loses
// sites silently upstream of this function, in extraction — not something
// buildRawCallerIndex can see or recover.
export interface RawCallerSite {
  file: string;
  line: number; // 1-based line of the call site
  receiver?: string; // copied from FileRecord.calls[].receiver when present
  // Innermost same-file declaration covering `line` — same semantics as the
  // standalone enclosingSymbol() helper above (AST endLine bounds when
  // present, else nearest-preceding). Absent when no symbol covers the line.
  enclosingSymbol?: CodeSymbol;
}

// name (raw, unqualified) → sites, sorted by (file, line). Map preserves
// insertion order and keys are inserted in sorted order below, so serializing
// the index is deterministic without re-sorting at the call site.
export type RawCallerIndex = Map<string, RawCallerSite[]>;

export function buildRawCallerIndex(scan: RepoScan): RawCallerIndex {
  const byName = new Map<string, RawCallerSite[]>();
  for (const f of scan.files) {
    if (!f.calls?.length) continue;
    // Pre-filter this file's symbols ONCE, then reuse the small per-file list
    // for every call site's enclosingSymbol lookup below (see enclosingAmong).
    const symbols = f.symbols.filter((s) => !REFERENCE_KINDS.has(s.kind));
    for (const c of f.calls) {
      const site: RawCallerSite = { file: f.rel, line: c.line };
      if (c.receiver !== undefined) site.receiver = c.receiver;
      const enc = enclosingAmong(symbols, c.line);
      if (enc) site.enclosingSymbol = enc;
      let arr = byName.get(c.name);
      if (!arr) byName.set(c.name, (arr = []));
      arr.push(site);
    }
  }

  // Deterministic assembly: names sorted, then sites sorted by (file, line) —
  // mirrors buildCallerIndex's assembly above.
  const index: RawCallerIndex = new Map();
  for (const name of [...byName.keys()].sort(byStr)) {
    const sites = byName.get(name)!;
    sites.sort((a, b) => byStr(a.file, b.file) || a.line - b.line);
    index.set(name, sites);
  }
  return index;
}
