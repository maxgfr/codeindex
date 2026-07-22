import { SCHEMA_VERSION } from "../types.js";
import type { SymbolIndex } from "../types.js";
import type { RepoScan } from "../scan.js";
import { byStr } from "../sort.js";
import { uniqueSymbolDefs } from "../graph.js";

// Files that REFERENCE each unique exported symbol — code files via their AST
// identifiers, doc files via naming the symbol. Feeds symbols.json `refs` so
// `symbols <name>` can answer "where is X used?". Mirrors the graph's use/mention
// eligibility (unique + distinctive), so refs and edges stay consistent.
export function computeSymbolRefs(scan: RepoScan): Map<string, Set<string>> {
  const unique = uniqueSymbolDefs(scan);
  const refs = new Map<string, Set<string>>();
  if (!unique.size) return refs;
  const add = (name: string, file: string): void => {
    let set = refs.get(name);
    if (!set) refs.set(name, (set = new Set()));
    set.add(file);
  };
  for (const f of scan.files) {
    if (f.kind === "code" && f.idents) {
      for (const id of f.idents) {
        const target = unique.get(id);
        if (target && target !== f.rel) add(id, f.rel);
      }
    } else if (f.kind === "doc") {
      const content = scan.docText.get(f.rel);
      if (!content) continue;
      for (const tok of content.split(/[^A-Za-z0-9_]+/)) {
        const target = unique.get(tok);
        if (target && target !== f.rel) add(tok, f.rel);
      }
    }
  }
  return refs;
}

// Build the persisted symbol table from the scan. `defs` collects every declared
// symbol by name; `refs` (files that USE a name) is filled by the graph's
// use/mention pass and merged in here. Ordering is fully deterministic so
// symbols.json is byte-stable across rebuilds.
export function buildSymbolIndex(scan: RepoScan, refs: Map<string, Set<string>> = new Map()): SymbolIndex {
  const defsByName = new Map<string, SymbolIndex["defs"][string]>();
  for (const f of scan.files) {
    for (const s of f.symbols) {
      let arr = defsByName.get(s.name);
      if (!arr) defsByName.set(s.name, (arr = []));
      arr.push({
        file: s.file,
        line: s.line,
        ...(s.endLine !== undefined ? { endLine: s.endLine } : {}),
        kind: s.kind,
        exported: s.exported,
        lang: s.lang,
        ...(s.parent ? { parent: s.parent } : {}),
      });
    }
  }

  const defs: SymbolIndex["defs"] = {};
  for (const name of [...defsByName.keys()].sort(byStr)) {
    defs[name] = defsByName
      .get(name)!
      .slice()
      .sort((a, b) => byStr(a.file, b.file) || a.line - b.line || byStr(a.kind, b.kind));
  }

  const refsOut: SymbolIndex["refs"] = {};
  for (const name of [...refs.keys()].sort(byStr)) {
    const files = [...refs.get(name)!].sort(byStr);
    if (files.length) refsOut[name] = files;
  }

  return { schemaVersion: SCHEMA_VERSION, defs, refs: refsOut };
}

export function renderSymbolsJson(index: SymbolIndex): string {
  return JSON.stringify(index, null, 2) + "\n";
}
