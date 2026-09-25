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
import { enclosingAmong, rawCallerSitesFor, type CallerIndex, type CallerSite, type RawCallerSite } from "./callers.js";
import { callerIndexFor, fileByRelFor, identSetsFor, symbolsByNameFor, uniqueDefsFor } from "./derived.js";
import { byStr } from "./sort.js";
import { refMatches, symbolRefReadings, type SymbolRef } from "./symref.js";
import { symbolId } from "./symbolgraph.js";

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

export interface SymbolAt {
  file: string;
  line: number;
  // The innermost declaration holding the line, with its symbol id — the form
  // callers, callgraph and call_path read — or null outside every one.
  symbol: (CodeSymbol & { id: string }) | null;
  // The declarations around it, outermost first (ids).
  enclosing: string[];
  // A regex-tier record has no end line, so `symbol` is only the nearest
  // declaration above the line: it may have ended before it.
  approximate?: true;
}

// Which symbol is at file:line? A grep hit, a stack frame or a compiler
// diagnostic names a line; every navigation query wants a symbol. undefined
// when the index holds no such file.
export function symbolAt(scan: RepoScan, rel: string, line: number): SymbolAt | undefined {
  const f = fileByRelFor(scan).get(rel);
  if (!f) return undefined;
  const inner = enclosingAmong(f.symbols, line);
  if (!inner) return { file: rel, line, symbol: null, enclosing: [] };
  // Every other declaration whose span holds both the line and the innermost
  // one. Only AST records bound a span, so a regex-tier answer has no chain.
  const reach = Math.max(line, inner.endLine ?? line);
  const enclosing = f.symbols
    .filter((s) => s !== inner && !REFERENCE_KINDS.has(s.kind) && s.endLine !== undefined && s.line <= inner.line && s.endLine >= reach)
    .sort((a, b) => a.line - b.line || b.endLine! - a.endLine! || byStr(a.name, b.name))
    .map(symbolId);
  const id = symbolId(inner);
  return {
    file: rel,
    line,
    symbol: { ...inner, id },
    // An overload repeats its id; a container is listed once.
    enclosing: [...new Set(enclosing)].filter((e) => e !== id),
    ...(inner.endLine === undefined ? { approximate: true as const } : {}),
  };
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

export interface ResolvedSymbolRef {
  reading: SymbolRef; // the reading of the ref that matched (src/symref.ts)
  defs: CodeSymbol[]; // its declarations, sorted by (file, line)
}

// The declarations a symbol ref names — `name`, `name@file`, `file#name`,
// `file#Parent/name` or `Parent/name` (src/symref.ts) — from the first
// reading that matches anything. undefined when nothing in the index answers.
// Re-exports and `export default X` point at a declaration; they never are one.
export function resolveSymbolRef(scan: RepoScan, ref: string): ResolvedSymbolRef | undefined {
  const byName = symbolsByNameFor(scan);
  for (const reading of symbolRefReadings(ref)) {
    // filter creates an owned array before sorting, so callers cannot change
    // the cached declaration order or contents.
    const defs = (byName.get(reading.name) ?? []).filter((s) => !REFERENCE_KINDS.has(s.kind) && refMatches(reading, s));
    if (defs.length) return { reading, defs: defs.sort((a, b) => byStr(a.file, b.file) || a.line - b.line) };
  }
  return undefined;
}

// `callers --raw <ref>` (MCP raw:true): every call site of a name before any
// binding. Raw sites are keyed by the name as called, so a qualified ref
// (`name@file`, `file#Parent/name`) reads as the name it qualifies.
export function rawCallersOf(scan: RepoScan, ref: string): { name: string; sites: RawCallerSite[] } {
  const sites = rawCallerSitesFor(scan, ref);
  const name = sites.length ? ref : resolveSymbolRef(scan, ref)?.reading.name;
  return name === undefined || name === ref ? { name: ref, sites } : { name, sites: rawCallerSitesFor(scan, name) };
}

// Why `callers <ref>` has no entry to show for a symbol that does exist.
//
// The caller index only keeps a site it could bind to ONE definition, so "no
// tracked callers" used to cover both "nothing calls this" and "74 sites call
// it by name, but two same-named definitions tie on proximity and none was
// kept" (flask's register_blueprint). Counting the raw sites that no entry of
// the name absorbed tells the two apart, and says where to look next.
export interface NoTrackedCallers {
  name: string; // the ref as asked
  error: string;
  defs: { name: string; kind: string; file: string; line: number }[];
  // Call sites naming the symbol that no binding rule attached to any of its
  // definitions: ambiguous homonyms, the JS/TS import gate, another family.
  unresolvedSites: number;
  sample: { file: string; line: number; receiver?: string }[]; // first five, (file, line) order
  hint: string;
}

// undefined when `ref` declares nothing at all — an unknown symbol, which
// callers report as an error rather than as an empty answer. `index` must hold
// every entry of the resolved name: the full index, or callerIndexForNames
// over refNames(ref).
export function explainNoCallers(scan: RepoScan, ref: string, index: CallerIndex): NoTrackedCallers | undefined {
  const resolved = resolveSymbolRef(scan, ref);
  if (!resolved) return undefined;
  const name = resolved.reading.name;
  const key = (file: string, line: number): string => `${line}:${file}`;
  // Sites some homonym's entry already holds are bound, not lost; a site on
  // one of the name's own declaration lines is the regex tier re-matching the
  // declaration, which the binder skips on purpose.
  const accounted = new Set<string>();
  for (const entry of index.values()) {
    if (entry.def.name === name) for (const c of entry.callers) accounted.add(key(c.file, c.line));
  }
  for (const d of symbolsByNameFor(scan).get(name) ?? []) accounted.add(key(d.file, d.line));
  const unresolved = rawCallerSitesFor(scan, name).filter((s) => !accounted.has(key(s.file, s.line)));
  return {
    name: ref,
    error: `no tracked callers for "${ref}"`,
    defs: resolved.defs.map((d) => ({ name: d.name, kind: d.kind, file: d.file, line: d.line })),
    unresolvedSites: unresolved.length,
    sample: unresolved.slice(0, 5).map((s) => (s.receiver !== undefined ? { file: s.file, line: s.line, receiver: s.receiver } : { file: s.file, line: s.line })),
    hint: unresolved.length
      ? `${unresolved.length} call site(s) name "${name}" but none could be bound to a single definition; ` +
        "raw mode (CLI --raw, MCP raw:true) lists every site, recall mode (--recall, recall:true) relaxes the JS/TS import gate"
      : `no call site in the index names "${name}"`,
  };
}

export interface SymbolReferences {
  defs: CodeSymbol[]; // where the name is declared
  // Line-precise call sites bound by the caller index (family-gated, import-
  // corroborated for JS/TS) — the highest-confidence reference tier. When the
  // answer spans homonyms declared in several files, each site names the
  // declaring file it binds to in `def`.
  callSites: (CallerSite & { def?: string })[];
  // Files whose collected identifiers reference the name (AST idents / doc
  // mentions) — file-level, name-based: may include homonym false positives.
  referencingFiles: string[];
}

// Who references this symbol? Merges the caller index (line-precise) with the
// identifier/mention pass (file-level), each tier labeled by its field. `ref`
// takes every form resolveSymbolRef reads; a bare name covers all homonyms.
export function findReferences(scan: RepoScan, ref: string): SymbolReferences {
  const resolved = resolveSymbolRef(scan, ref);
  const defs = resolved?.defs ?? [];
  const name = resolved?.reading.name ?? ref;

  // Every declaring file's entry, not just the one the bare name is keyed by:
  // the index keeps the first homonym under `name` and each other one under
  // `name@file` (the same lookup findDeadCode does).
  const index = callerIndexFor(scan);
  const bare = index.get(name);
  const declaring = [...new Set(defs.map((d) => d.file))];
  const callSites: SymbolReferences["callSites"] = [];
  for (const file of declaring) {
    const entry = bare?.def.file === file ? bare : index.get(`${name}@${file}`);
    if (!entry) continue;
    // COPY, not alias: the caller index is memoized per scan (src/derived.ts),
    // so handing out the cached sites would let a consumer mutation poison
    // every later findReferences on this scan.
    for (const site of entry.callers) callSites.push(declaring.length > 1 ? { ...site, def: file } : { ...site });
  }
  callSites.sort((a, b) => byStr(a.file, b.file) || a.line - b.line);

  const referencingFiles = new Set<string>();
  const unique = uniqueDefsFor(scan);
  const defFile = unique.get(name);
  // Per-file identifier Sets are memoized per scan (src/derived.ts) and the
  // doc pattern is compiled once — the loop used to run Array.includes over
  // every code file's identifiers and build a RegExp per doc, per query.
  const idents = identSetsFor(scan);
  const mention = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  for (const f of scan.files) {
    if (f.rel === defFile) continue;
    if (f.kind === "code" && idents.get(f.rel)?.has(name)) referencingFiles.add(f.rel);
    else if (f.kind === "doc") {
      const content = scan.docText.get(f.rel);
      if (content && mention.test(content)) referencingFiles.add(f.rel);
    }
  }
  for (const site of callSites) referencingFiles.add(site.file);

  return { defs, callSites, referencingFiles: [...referencingFiles].sort(byStr) };
}
