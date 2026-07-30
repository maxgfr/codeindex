import { join } from "node:path";
import { ENGINE_VERSION, SCHEMA_VERSION } from "./types.js";
import type { Edge, FileNode, Graph, ModuleNode } from "./types.js";
import type { RepoScan } from "./scan.js";
import type { ModuleInfo } from "./modules.js";
import { resolveDocLink, resolveImport, type ResolveContext } from "./resolve.js";
import { resolveCallEdges } from "./calls.js";
import { resolveRelationEdges } from "./relations.js";
import { publishImportPairs, uniqueDefsFor } from "./derived.js";
import { readText } from "./walk.js";
import { byStr } from "./sort.js";

// A symbol name distinctive enough to anchor a doc→code "mention" edge without
// noise: long, and either mixed-case or snake_case (i.e. not a plain English
// word). Conservative on purpose — a wrong mention is worse than a missing one.
function isDistinctive(name: string): boolean {
  if (name.length < 5) return false;
  // Require an INTERNAL camelCase boundary, consecutive caps, an underscore, or a
  // digit — so a plain capitalized word like "Exemple"/"Result" does NOT qualify
  // (a leading capital alone is just a sentence-start, not an identifier).
  const internalUpper = /[a-z][A-Z]/.test(name) || /[A-Z]{2}/.test(name);
  return internalUpper || name.includes("_") || /\d/.test(name);
}

// Names that are exported AND defined in exactly one file AND distinctive — the
// only ones eligible for mention edges.
// Symbol kinds that are references to a definition elsewhere (a barrel re-export
// or `export default Foo`) — they must NOT count as a "definition" for mentions,
// which should resolve to where a symbol is actually declared.
const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

export function uniqueSymbolDefs(scan: RepoScan): Map<string, string> {
  const byName = new Map<string, Set<string>>();
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (!s.exported || REFERENCE_KINDS.has(s.kind) || !isDistinctive(s.name)) continue;
      let set = byName.get(s.name);
      if (!set) byName.set(s.name, (set = new Set()));
      set.add(f.rel);
    }
  }
  const unique = new Map<string, string>();
  for (const [name, files] of byName) if (files.size === 1) unique.set(name, [...files][0]!);
  return unique;
}

type EdgeKey = string;
// EdgeKey is a purely internal Map key (fileEdgeMap / modEdgeMap) and never
// reaches an artifact, so the separator only has to be a character that cannot
// appear in a path or an edge kind. It used to be a LITERAL NUL byte in this
// source file, which made git, grep and file(1) treat graph.ts as binary — and
// made codeindex drop its own module from its own index, since readText's
// whole-buffer NUL sniff correctly reads a NUL as "binary". "\u0000" is the
// same character at runtime, written so the file stays text.
const SEP = "\u0000";
const keyOf = (from: string, to: string, kind: string): EdgeKey => `${from}${SEP}${to}${SEP}${kind}`;

// Merge duplicate edges (same from/to/kind), summing weight; keep dangling flag.
function collect(edges: Map<EdgeKey, Edge>, e: Edge): void {
  const k = keyOf(e.from, e.to, e.kind);
  const prev = edges.get(k);
  if (prev) {
    prev.weight += e.weight;
    return;
  }
  edges.set(k, { ...e });
}

// Build the full link-graph (file-level + module-level) from the scan, the
// resolution context and the module grouping. Pure + deterministic.
// `meta` lets a consumer stamp its own version/schema into the graph it
// persists (ultraindex passes its VERSION so graph.json stays byte-compatible
// across the engine extraction); defaults identify this engine.
export function buildGraph(
  scan: RepoScan,
  ctx: ResolveContext,
  modules: ModuleInfo[],
  moduleOf: Map<string, string>,
  meta?: { version?: string; schemaVersion?: number },
): Graph {
  const fileEdgeMap = new Map<EdgeKey, Edge>();
  const importPairs = new Set<string>(); // `${from}|${to}` — suppress a `use` edge the import already covers

  // doc-link and import edges from each file's raw refs.
  for (const f of scan.files) {
    for (const ref of f.refs) {
      if (ref.kind === "doc-link") {
        const r = resolveDocLink(f.rel, ref.spec, ctx);
        if (r.kind === "external") continue;
        if (r.kind === "dangling") {
          collect(fileEdgeMap, { from: f.rel, to: ref.spec, kind: "doc-link", weight: 1, dangling: true, reason: r.reason });
        } else if (r.target !== f.rel) {
          collect(fileEdgeMap, { from: f.rel, to: r.target, kind: "doc-link", weight: 1 });
        }
      } else {
        const r = resolveImport(f.rel, f.ext, ref.spec, ctx);
        if (r.kind === "external") continue;
        if (r.kind === "dangling") {
          collect(fileEdgeMap, { from: f.rel, to: ref.spec, kind: "import", weight: 1, dangling: true, reason: r.reason });
        } else if (r.target !== f.rel) {
          collect(fileEdgeMap, { from: f.rel, to: r.target, kind: "import", weight: 1 });
          importPairs.add(`${f.rel}|${r.target}`);
        }
      }
    }
  }

  // Cross-file call edges: a global second pass over every file's collected call
  // sites, promoted to `extracted` when an import corroborates the call and
  // `inferred` on a unique repo-wide name match. Recorded as a pair set because a
  // `call` is stronger evidence than a `use` for the same directed pair.
  const callPairs = new Set<string>();
  for (const e of resolveCallEdges(scan, importPairs)) {
    collect(fileEdgeMap, e);
    callPairs.add(`${e.from}|${e.to}`);
  }

  // Inheritance edges: `class S extends BaseWorker` is a dependency no import
  // list distinguishes from any other, and the strongest structural link a repo
  // has after the import itself. Recorded as a pair set for the same reason
  // calls are — a subtype relation outranks a bare `use` for the same pair.
  for (const e of resolveRelationEdges(scan, importPairs)) {
    collect(fileEdgeMap, e);
    callPairs.add(`${e.from}|${e.to}`);
  }

  // Every import in the repo is now resolved; hand the pair set to the derived
  // cache so the caller index / references / dead code do not resolve them all
  // over again (no-op when a consumer passed its own resolve context).
  publishImportPairs(scan, ctx, importPairs);

  // Conservative mention edges: a doc naming a unique, distinctive exported
  // symbol. Memoized: computeSymbolRefs needs the same map right after.
  const unique = uniqueDefsFor(scan);

  // Conservative `use` edges: a code file REFERENCING another file's unique
  // distinctive exported symbol (AST-derived identifiers). Suppressed when an
  // import OR call edge already links the same pair, so a resolved dependency is
  // never double-counted. Same eligibility as mentions (unique + distinctive),
  // applied code→code — a weaker signal than imports/calls but it connects
  // languages/patterns the resolver can't (dynamic wiring, DI containers,
  // string-keyed registries).
  if (unique.size) {
    for (const f of scan.files) {
      if (f.kind !== "code" || !f.idents?.length) continue;
      const perTarget = new Map<string, number>();
      for (const id of f.idents) {
        const target = unique.get(id);
        if (!target || target === f.rel) continue;
        perTarget.set(target, (perTarget.get(target) ?? 0) + 1);
      }
      for (const [target, count] of perTarget) {
        const pair = `${f.rel}|${target}`;
        if (importPairs.has(pair) || callPairs.has(pair)) continue;
        collect(fileEdgeMap, { from: f.rel, to: target, kind: "use", weight: Math.min(count, 5) });
      }
    }
  }
  if (unique.size) {
    for (const f of scan.files) {
      if (f.kind !== "doc") continue;
      // Reuse the content the scan already read (falling back to disk only if a
      // doc somehow was not retained) — no second read of every doc file.
      const content = scan.docText.get(f.rel) ?? readText(join(scan.root, f.rel));
      if (!content) continue;
      const tokens = new Map<string, number>();
      for (const tok of content.split(/[^A-Za-z0-9_]+/)) {
        if (unique.has(tok)) tokens.set(tok, (tokens.get(tok) ?? 0) + 1);
      }
      for (const [name, count] of tokens) {
        const target = unique.get(name)!;
        if (target === f.rel) continue;
        collect(fileEdgeMap, { from: f.rel, to: target, kind: "mention", weight: Math.min(count, 5) });
      }
    }
  }

  const fileEdges = [...fileEdgeMap.values()].sort(
    (a, b) => byStr(a.from, b.from) || byStr(a.to, b.to) || byStr(a.kind, b.kind),
  );

  // File degrees count only resolved edges (dangling targets are not nodes).
  const degIn = new Map<string, number>();
  const degOut = new Map<string, number>();
  const fileSet = new Set(scan.files.map((f) => f.rel));
  for (const e of fileEdges) {
    if (e.dangling || !fileSet.has(e.to)) continue;
    degOut.set(e.from, (degOut.get(e.from) ?? 0) + 1);
    degIn.set(e.to, (degIn.get(e.to) ?? 0) + 1);
  }

  // Lift resolved file edges to module edges (drop self-loops). Kind precedence:
  // import > extends > implements > call > use > doc-link > mention, so a module
  // pair's edge reflects its strongest link. Inheritance sits just under import:
  // a subtype is bound to its base far more tightly than a caller to a callee.
  const KIND_RANK: Record<string, number> = {
    import: 7,
    extends: 6,
    implements: 5,
    call: 4,
    use: 3,
    "doc-link": 2,
    mention: 1,
    contains: 0,
  };
  const modEdgeMap = new Map<EdgeKey, Edge>();
  for (const e of fileEdges) {
    if (e.dangling || !fileSet.has(e.to)) continue;
    const from = moduleOf.get(e.from);
    const to = moduleOf.get(e.to);
    if (!from || !to || from === to) continue;
    const k = `${from}${SEP}${to}`;
    const prev = modEdgeMap.get(k);
    if (prev) {
      prev.weight += e.weight;
      if ((KIND_RANK[e.kind] ?? 0) > (KIND_RANK[prev.kind] ?? 0)) prev.kind = e.kind;
    } else {
      modEdgeMap.set(k, { from, to, kind: e.kind, weight: e.weight });
    }
  }
  const moduleEdges = [...modEdgeMap.values()].sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to));

  const modDegIn = new Map<string, number>();
  const modDegOut = new Map<string, number>();
  for (const e of moduleEdges) {
    modDegOut.set(e.from, (modDegOut.get(e.from) ?? 0) + 1);
    modDegIn.set(e.to, (modDegIn.get(e.to) ?? 0) + 1);
  }

  const files: FileNode[] = scan.files
    .map((f) => ({
      id: f.rel,
      kind: "file" as const,
      rel: f.rel,
      fileKind: f.kind,
      lang: f.lang,
      module: moduleOf.get(f.rel) ?? "root",
      title: f.title,
      summary: f.summary,
      symbols: f.symbols.length,
      lines: f.lines,
      degIn: degIn.get(f.rel) ?? 0,
      degOut: degOut.get(f.rel) ?? 0,
    }))
    .sort((a, b) => byStr(a.rel, b.rel));

  const symbolsByModule = new Map<string, number>();
  for (const f of scan.files) {
    // Every scanned file is grouped by buildModules, so this lookup always hits;
    // fall back to "root" (as the file node above does) rather than assert, so a
    // future refactor can't turn a missing entry into a hard crash.
    const slug = moduleOf.get(f.rel) ?? "root";
    symbolsByModule.set(slug, (symbolsByModule.get(slug) ?? 0) + f.symbols.length);
  }

  const moduleNodes: ModuleNode[] = modules
    .map((m) => ({
      id: m.slug,
      kind: "module" as const,
      slug: m.slug,
      path: m.path,
      title: m.title,
      summary: m.summary,
      tier: m.tier,
      members: m.members,
      symbols: symbolsByModule.get(m.slug) ?? 0,
      degIn: modDegIn.get(m.slug) ?? 0,
      degOut: modDegOut.get(m.slug) ?? 0,
    }))
    .sort((a, b) => byStr(a.slug, b.slug));

  return {
    schemaVersion: meta?.schemaVersion ?? SCHEMA_VERSION,
    version: meta?.version ?? ENGINE_VERSION,
    commit: scan.commit,
    fileCount: scan.files.length,
    languages: scan.languages,
    files,
    modules: moduleNodes,
    fileEdges,
    moduleEdges,
  };
}
