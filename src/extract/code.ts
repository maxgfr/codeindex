import type { CodeLiteral, CodeSymbol, RawRef, RawRelation } from "../types.js";
import { LiteralCollector } from "./literals.js";
import { extractSymbols } from "../lang/registry.js";
import { capCallSites, extractAst } from "../ast/extract.js";
import { extractReexports, extToLang, MAX_REEXPORTS } from "../lang/common.js";
import { extractImports, extractPackage } from "./imports.js";
import { sfcParts } from "./sfc.js";
import { generatedKind, type GeneratedKind } from "./generated.js";
import { fileSummary, stripCommentMarkers } from "./doc-text.js";
import { subtokens } from "../util.js";

// Per-file symbol ceiling. Raised from 400: a real 3000-line generated client or
// a large `.d.ts` has more than 400 declarations, and dropping the tail silently
// meant the index claimed completeness it did not have. The cap still exists as a
// runaway guard, but crossing it now sets `truncated`.
const MAX_FILE_SYMBOLS = 2000;

export interface CodeInfo {
  symbols: CodeSymbol[];
  summary?: string;
  // A cap truncated `symbols` — propagated onto the FileRecord.
  truncated?: true;
  // Build output (minified code, a bundle): only the summary and imports were
  // extracted (see extract/generated.ts) — propagated onto the FileRecord.
  generated?: GeneratedKind;
  refs: RawRef[]; // import refs (raw specifiers, unresolved)
  pkg?: string; // the file's own package/namespace (Java, Kotlin, Scala, C#) — anchors import resolution
  idents?: string[]; // distinctive identifiers referenced (AST path) — feeds `use` edges
  // Call-site callee names (+ immediate receiver for qualified calls) — feeds
  // call edges and receiver-gated sink catalogs.
  calls?: { name: string; line: number; receiver?: string }[];
  importedNames?: string[]; // JS/TS named-import bindings (AST path) — feeds the call gate
  // Prose vocabulary — comment and short-string-literal words, subtokenized,
  // deduped, capped and sorted. Feeds search's `body` field.
  terms?: string[];
  // Literal values kept verbatim with their line — feeds duplication analysis.
  literals?: CodeLiteral[];
  // Inheritance stated by this file's declarations (AST path) — feeds the
  // extends/implements edges and the type hierarchy.
  relations?: RawRelation[];
}

// Control-flow and declaration keywords that syntactically precede `(` but are
// never call targets — the union across supported languages. Deliberately does
// NOT list real builtins (python's `print`, go's `make`…): a false call to a
// name with no repo-wide def resolves to nothing downstream, while excluding a
// real function name would silently drop true edges.
const CALL_KEYWORDS = new Set([
  "if", "else", "elif", "for", "while", "do", "switch", "case", "match", "when", "unless", "until",
  "catch", "except", "return", "throw", "raise", "yield", "await", "typeof", "instanceof", "sizeof",
  "delete", "void", "in", "of", "not", "and", "or", "assert", "defer", "select", "with", "loop",
]);

// Introducers whose FOLLOWING identifier is a definition, not a call:
// `function foo(`, `def foo(`, `func foo(`, `fn foo(`, `class Foo(`, `sub foo(`.
const DEF_INTRODUCERS = /(?:\bfunction|\bdef|\bfunc|\bfun|\bfn|\bclass|\bsub|\bmacro|\bproc)\s*[*]?\s*$/;

// Regex-tier call-site collection for files with no AST grammar — a
// conservative `identifier(` scan so call data exists wasm-free (the AST tier
// stays authoritative when available). Same contract as ast/extract's
// collector: deduped by name+line, capped at 512 by the same capCallSites
// (so the file is scanned to its end), sorted by name then line. An
// immediate `receiver.` prefix is captured too (`axios.get(` → receiver
// "axios"; `a.b.c(` → receiver "b" — the group anchors to the segment right
// before the called name); bare calls carry no receiver.
//
// `symbols` is the file's OWN regex-extracted symbols (name + definition
// line). DEF_INTRODUCERS already excludes definitions that read `function
// foo(`/`def foo(`/etc. (per OCCURRENCE, wherever on the line it sits), but
// C/C++ function definitions have no such introducer (`void load(void) {`) —
// the bare name reads exactly like a call to itself on its own definition
// line. For those, a call candidate whose (name, line) exactly matches one of
// `symbols` is excluded too — but ONLY its first (leftmost) occurrence on that
// line, never every same-named occurrence: dense/minified one-liners can pack
// a genuine call to the same name on the same physical line as its own
// definition (`function aa(){}function bb(){return aa()+cc()}function cc(){}`
// — bb's calls to aa() and cc() must survive), and even a bodyless
// single-line recursive definition (`function foo(){foo();}`) has a real self
// -call to keep. Two-tier: if ANY occurrence of a def'd name on this line is
// already caught by DEF_INTRODUCERS (JS/Python/…), that occurrence alone is
// excluded (existing per-occurrence check below) and no further exclusion is
// applied — every OTHER occurrence is a genuine call. Only when NO occurrence
// carries an introducer (C/C++) does this fall back to excluding just the
// first occurrence: C/C++'s own definition regex requires column 0, so on a
// line where it matches at all, the first occurrence IS that definition.
// Exported for direct testing (extraction-v8.test.ts): once a wasm sidecar/
// grammar is loaded, extractCode never reaches this path for C/C++, so tests
// exercise it directly rather than through extractCode.
export function collectCallsRegex(
  content: string,
  symbols: Pick<CodeSymbol, "name" | "line">[] = [],
  maxCalls: number = 512,
): { name: string; line: number; receiver?: string }[] {
  const out = new Map<string, { name: string; line: number; receiver?: string }>();
  const ownDefLines = new Set(symbols.map((s) => `${s.name} ${s.line}`));
  const lines = content.split("\n");
  const CALL_RE = /(?:\bnew\s+)?(?:([A-Za-z_$][\w$]*)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Cheap comment guard: a line-leading comment marker means no calls here
    // (block-comment interiors and strings stay best-effort, like the symbol
    // regexes — noise resolves to nothing in the global call pass).
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;

    // Pass 1: which own-def keys on this line have at least one occurrence
    // DEF_INTRODUCERS already catches? Those are fully handled per-occurrence
    // below — no fallback exclusion needed (or wanted) for them.
    CALL_RE.lastIndex = 0;
    let probe: RegExpExecArray | null;
    const introducerCaught = new Set<string>();
    while ((probe = CALL_RE.exec(line)) !== null) {
      const name = probe[2]!;
      const key = `${name} ${i + 1}`;
      if (ownDefLines.has(key) && DEF_INTRODUCERS.test(line.slice(0, probe.index))) introducerCaught.add(key);
    }

    // Pass 2: the real collection. Own-def keys with no introducer occurrence
    // fall back to excluding just their first occurrence on the line.
    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const fallbackExcluded = new Set<string>();
    while ((m = CALL_RE.exec(line)) !== null) {
      const receiver = m[1];
      const name = m[2]!;
      if (name.length < 2 || CALL_KEYWORDS.has(name)) continue;
      if (DEF_INTRODUCERS.test(line.slice(0, m.index))) continue;
      const key = `${name} ${i + 1}`;
      if (ownDefLines.has(key) && !introducerCaught.has(key)) {
        if (!fallbackExcluded.has(key)) {
          fallbackExcluded.add(key);
          continue;
        }
      }
      if (!out.has(key)) out.set(key, receiver ? { name, line: i + 1, receiver } : { name, line: i + 1 });
    }
  }
  return capCallSites([...out.values()], maxCalls);
}

const MAX_TERMS = 512;
const MAX_LITERAL_LEN = 80;

// Prose vocabulary for files the AST tier cannot parse: comment text and short
// string literals, line by line. Deliberately cruder than the AST collector (a
// `//` inside a string will contribute its tail) — a stray word costs a little
// precision on one field, while having NO prose vocabulary costs the ability to
// answer "where is X handled" at all for that language.
//
// Collected in SOURCE order and truncated at the tail, then sorted: truncating a
// sorted list would cut every large file's vocabulary off mid-alphabet.
export function collectTermsRegex(content: string): string[] {
  const found = new Set<string>();
  const add = (text: string): void => {
    if (found.size >= MAX_TERMS) return;
    for (const t of subtokens(text)) {
      if (found.size >= MAX_TERMS) return;
      found.add(t);
    }
  };
  let inBlock = false;
  for (const raw of content.split("\n")) {
    if (found.size >= MAX_TERMS) break;
    let line = raw;
    if (inBlock) {
      const close = line.indexOf("*/");
      add(stripCommentMarkers(close === -1 ? line : line.slice(0, close)));
      if (close === -1) continue;
      inBlock = false;
      line = line.slice(close + 2);
    }
    const open = line.indexOf("/*");
    if (open !== -1) {
      const close = line.indexOf("*/", open + 2);
      add(stripCommentMarkers(line.slice(open, close === -1 ? undefined : close)));
      if (close === -1) {
        inBlock = true;
        line = line.slice(0, open);
      } else line = line.slice(0, open) + line.slice(close + 2);
    }
    const lineComment = /(^|\s)(\/\/|#|--)(.*)$/.exec(line);
    if (lineComment) {
      add(stripCommentMarkers(lineComment[2]! + lineComment[3]!));
      line = line.slice(0, lineComment.index);
    }
    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      const body = m[2]!;
      if (body.length && body.length <= MAX_LITERAL_LEN) add(body);
    }
  }
  return [...found].sort();
}

// Literal VALUES for files the AST tier cannot parse. Same line-by-line,
// comment-stripping scan as collectTermsRegex — deliberately sharing its
// crudeness rather than inventing a second, differently-wrong scanner — but it
// keeps the value and the line instead of subtokenizing them away.
export function collectLiteralsRegex(content: string): CodeLiteral[] | undefined {
  const literals = new LiteralCollector();
  let inBlock = false;
  let lineNo = 0;
  for (const raw of content.split("\n")) {
    lineNo++;
    if (literals.full) break;
    let line = raw;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close === -1) continue;
      inBlock = false;
      line = line.slice(close + 2);
    }
    const open = line.indexOf("/*");
    if (open !== -1) {
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        inBlock = true;
        line = line.slice(0, open);
      } else line = line.slice(0, open) + line.slice(close + 2);
    }
    const lineComment = /(^|\s)(\/\/|#|--)(.*)$/.exec(line);
    if (lineComment) line = line.slice(0, lineComment.index);

    for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      literals.add("string", m[2]!, lineNo);
    }
    // Numbers not glued to an identifier (so `utf8` and `base64` do not yield
    // 8 and 64) and not inside a quoted run already consumed above.
    for (const m of line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, " ").matchAll(/(?<![\w.])-?\d[\d_]*(?:\.\d+)?(?![\w.])/g)) {
      literals.add("number", m[0].replace(/_/g, ""), lineNo);
    }
  }
  return literals.result();
}

// Two call lists as one: deduped by name+line, cut to the per-file cap by the
// same capCallSites both collectors use (the script's sites first, then the
// markup's), and sorted by name then line.
function mergeCalls(
  a: { name: string; line: number; receiver?: string }[],
  b: { name: string; line: number; receiver?: string }[],
  maxCalls = 512,
): { name: string; line: number; receiver?: string }[] {
  if (!b.length) return a;
  const seen = new Set(a.map((c) => `${c.name} ${c.line}`));
  const out = [...a];
  for (const c of b) if (!seen.has(`${c.name} ${c.line}`)) out.push(c);
  return capCallSites(out, maxCalls);
}

// `opts.maxCallsPerFile` overrides the per-file call-site cap (default 512) on
// BOTH extraction tiers — AST and regex — so recall-oriented consumers can raise
// it. Dedup/sort semantics are unchanged; absent, output is byte-identical.
export function extractCode(rel: string, ext: string, content: string, opts: { maxCallsPerFile?: number } = {}): CodeInfo {
  // Build output keeps its place in the index, its summary and its imports
  // (real edges, whoever wrote them) — and nothing else: a minified file's
  // symbols and call sites are one-letter noise, a bundle's are copies of its
  // sources' (see extract/generated.ts). The flag says which.
  const generated = generatedKind(ext, content);
  if (generated) {
    return { symbols: [], generated, summary: fileSummary(ext, content), refs: extractImports(ext, content) };
  }
  // A single-file component (.vue/.svelte/.astro) is extracted as its script:
  // the JS/TS tier runs over a copy with the markup blanked, lines unchanged
  // (see extract/sfc.ts). Its symbols keep the component's own language, which
  // calls.ts folds into the JS family.
  const sfc = sfcParts(ext, content);
  const code = sfc ? sfc.script : content;
  const codeExt = sfc ? sfc.ext : ext;
  // Symbols come from tree-sitter when a grammar is loaded for this extension
  // (AST-exact: real nesting, precise kinds, structural export), else the regex
  // extractors. Imports/pkg come from extract/imports.ts on both tiers.
  // `imports: false` because extractAst would only compute the same refs/pkg
  // again, for this function to discard.
  const ast = extractAst(rel, codeExt, code, { maxCalls: opts.maxCallsPerFile, imports: false });
  const raw = ast ? ast.symbols : extractSymbols(rel, codeExt, code);
  const kept = raw.slice(0, MAX_FILE_SYMBOLS);
  const symbols = sfc
    ? kept.map((s) => ({
        ...s,
        lang: extToLang(ext),
        exported: s.exported && !sfc.notExported.some(([from, to]) => s.line >= from && s.line <= to),
      }))
    : kept;
  // Add barrel re-exports the local def didn't already cover.
  const known = new Set(symbols.map((s) => s.name));
  const reexports = extractReexports(rel, code, symbols).filter((s) => !known.has(s.name));
  const refs = extractImports(codeExt, code);
  // An import specifier is a literal, but it is already modelled — as `refs`,
  // and resolved into real import edges. Leaving it in `literals` would make
  // every shared dependency look like an un-centralized value and bury the
  // findings that are actually about values. A soft ref is a derived module
  // path, not text the file contains, so it never hides a literal.
  const importSpecs = new Set(refs.filter((r) => !r.soft).map((r) => r.spec));
  // A component's vocabulary and literals still come from the WHOLE file, on
  // both tiers: the markup's attribute strings are as much its text as the
  // script's, and the line scanners read both parts the same way.
  const literals = (
    ast && !sfc ? (ast.literals.length ? ast.literals : undefined) : collectLiteralsRegex(content)
  )?.filter((l) => !(l.kind === "string" && importSpecs.has(l.value)));
  // AST call sites when a grammar parsed the file; the conservative regex
  // collector otherwise, so caller indexes exist without the wasm sidecar.
  // `symbols` (this file's own regex-extracted defs) lets the collector
  // exclude a definition's own name+line from its call candidates.
  let calls = ast ? ast.calls : collectCallsRegex(code, symbols, opts.maxCallsPerFile);
  // A template calls what its script imports (`{{ formatDate(d) }}`,
  // `on:click={() => save(item)}`): those sites are read by the regex
  // collector from the markup and merged in, under the same cap and order.
  if (sfc) calls = mergeCalls(calls, collectCallsRegex(sfc.markup, [], opts.maxCallsPerFile), opts.maxCallsPerFile);
  return {
    symbols: [...symbols, ...reexports],
    // A re-export list that hit its own ceiling is truncated too — a barrel that
    // looks complete while hiding names is the failure the walk's `capped` flag
    // exists to prevent.
    ...(ast?.truncated || raw.length > symbols.length || reexports.length >= MAX_REEXPORTS
      ? { truncated: true as const }
      : {}),
    summary: fileSummary(ext, content),
    refs,
    pkg: extractPackage(ext, content),
    idents: ast?.idents,
    calls,
    importedNames: ast?.importedNames,
    relations: ast?.relations?.length ? ast.relations : undefined,
    // The AST tier reads comments and literals structurally; without a grammar
    // the line scanner above still supplies a vocabulary, so search quality does
    // not silently collapse for a language with no wasm.
    terms: ast && !sfc ? ast.terms : collectTermsRegex(content),
    literals: literals?.length ? literals : undefined,
  };
}
