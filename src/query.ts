// Symbol-level query API (Serena-parity tier, static edition): overview of a
// file's symbols, name-path symbol lookup with optional bodies, and reference
// finding that merges line-precise caller sites with file-level identifier
// references. Everything is computed from the deterministic scan — no language
// server, no daemon; precision is honestly labeled per result so an agent
// knows when it is looking at compiler-grade truth vs a name-based match.
import { join } from "node:path";
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { readText } from "./walk.js";
import type { CallerSite } from "./callers.js";
import { callerIndexFor, fileByRelFor, symbolsByNameFor, uniqueDefsFor } from "./derived.js";
import { byStr } from "./sort.js";

const REFERENCE_KINDS = new Set(["reexport", "reexport-all", "default"]);

function* allSymbols(scan: RepoScan): Generator<CodeSymbol> {
  for (const file of scan.files) yield* file.symbols;
}

// All symbols declared in one file, in declaration order — the fastest way to
// understand a file without reading it.
export function symbolsOverview(scan: RepoScan, rel: string): CodeSymbol[] {
  const f = fileByRelFor(scan).get(rel);
  if (!f) return [];
  return [...f.symbols].filter((s) => !REFERENCE_KINDS.has(s.kind)).sort((a, b) => a.line - b.line || byStr(a.name, b.name));
}

export interface SymbolMatch extends CodeSymbol {
  body?: string; // the declaration's source lines (AST spans; absent without endLine unless the decl is one line)
}

export interface FindSymbolOptions {
  substring?: boolean; // match name segments by inclusion instead of equality
  includeBody?: boolean;
  maxResults?: number; // default 50
  /**
   * Return only what LOCATES a declaration — name, kind, file, line — dropping
   * the signature, line span, visibility and language.
   *
   * The default answer carries the complete signature because "what shape is
   * it" is the question that follows "where is it" almost every time, and one
   * round trip beats two. But it is not free: measured on `Route` in
   * create-t3-turbo, the full answer is 1,561 bytes against 640 for a
   * locate-only one — and when the caller genuinely only wants a path, the
   * signature is context spent on a question nobody asked.
   *
   * So it is the CALLER's choice rather than ours, and the default does not
   * move: an agent that knows it is only resolving a path can say so.
   */
  concise?: boolean;
}

// Look up symbols by name or name path ("Class/method" matches a `method`
// whose enclosing symbol is `Class`). Deterministic ordering: exact name
// matches first, then (file, line).
export function findSymbol(scan: RepoScan, namePath: string, opts: FindSymbolOptions = {}): SymbolMatch[] {
  const segments = namePath.split("/").filter(Boolean);
  if (!segments.length) return [];
  const leaf = segments[segments.length - 1]!;
  const parents = segments.slice(0, -1);
  const matchName = (name: string, wanted: string): boolean =>
    opts.substring ? name.toLowerCase().includes(wanted.toLowerCase()) : name === wanted;

  const out: SymbolMatch[] = [];
  const candidates: Iterable<CodeSymbol> = opts.substring
    ? allSymbols(scan)
    : symbolsByNameFor(scan).get(leaf) ?? [];
  for (const s of candidates) {
    if (REFERENCE_KINDS.has(s.kind)) continue;
    if (!matchName(s.name, leaf)) continue;
    // Walk the parent chain (single level in practice — extractor records the
    // enclosing symbol name) against the requested path suffix. Substring
    // matching applies to the LAST segment only (Serena's contract): parent
    // segments always match exactly.
    if (parents.length) {
      const parent = parents[parents.length - 1]!;
      if (!s.parent || s.parent !== parent) continue;
    }
    out.push({ ...s });
  }
  out.sort(
    (a, b) => Number(b.name === leaf) - Number(a.name === leaf) || byStr(a.file, b.file) || a.line - b.line,
  );
  const capped = out.slice(0, opts.maxResults ?? 50);
  if (opts.includeBody) {
    // Several overloads / methods commonly live in the same file. Read and
    // split each source file once per query rather than once per matching
    // declaration; result ownership and freshness semantics stay unchanged.
    const linesByFile = new Map<string, string[]>();
    const unreadableFiles = new Set<string>();
    for (const m of capped) {
      const end = m.endLine ?? m.line;
      if (unreadableFiles.has(m.file)) continue;
      let lines = linesByFile.get(m.file);
      if (!lines) {
        const content = readText(join(scan.root, m.file));
        if (!content) {
          unreadableFiles.add(m.file);
          continue;
        }
        lines = content.split("\n");
        linesByFile.set(m.file, lines);
      }
      m.body = lines.slice(m.line - 1, end).join("\n");
    }
  }
  // Applied LAST so it composes predictably: `concise` with `includeBody` keeps
  // the body, because a caller that asked for both wants the source without the
  // metadata around it.
  if (opts.concise) {
    return capped.map((m) => ({
      name: m.name,
      kind: m.kind,
      file: m.file,
      line: m.line,
      ...(m.body !== undefined ? { body: m.body } : {}),
    })) as SymbolMatch[];
  }
  return capped;
}

export interface SymbolReferences {
  defs: CodeSymbol[]; // where the name is declared
  // Line-precise call sites bound by the caller index (family-gated, import-
  // corroborated for JS/TS) — the highest-confidence reference tier.
  callSites: CallerSite[];
  // Files whose collected identifiers reference the name (AST idents / doc
  // mentions) — file-level, name-based: may include homonym false positives.
  referencingFiles: string[];
}

// Who references this symbol? Merges the caller index (line-precise) with the
// identifier/mention pass (file-level), each tier labeled by its field.
export function findReferences(scan: RepoScan, name: string): SymbolReferences {
  const defs: CodeSymbol[] = [];
  for (const f of scan.files) {
    for (const s of f.symbols) {
      if (s.name === name && !REFERENCE_KINDS.has(s.kind)) defs.push(s);
    }
  }
  defs.sort((a, b) => byStr(a.file, b.file) || a.line - b.line);

  const index = callerIndexFor(scan);
  const entry = index.get(name);
  // COPY, not alias: the caller index is memoized per scan (src/derived.ts),
  // so handing out the cached array would let a consumer mutation poison
  // every later findReferences on this scan.
  const callSites = entry ? [...entry.callers] : [];

  const referencingFiles = new Set<string>();
  const unique = uniqueDefsFor(scan);
  const defFile = unique.get(name);
  for (const f of scan.files) {
    if (f.rel === defFile) continue;
    if (f.kind === "code" && f.idents?.includes(name)) referencingFiles.add(f.rel);
    else if (f.kind === "doc") {
      const content = scan.docText.get(f.rel);
      if (content && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(content)) {
        referencingFiles.add(f.rel);
      }
    }
  }
  for (const site of callSites) referencingFiles.add(site.file);

  return { defs, callSites, referencingFiles: [...referencingFiles].sort(byStr) };
}
