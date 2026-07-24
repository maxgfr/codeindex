import type { CodeSymbol, RawRef } from "../types.js";
import { extractSymbols } from "../lang/registry.js";
import { extractAst } from "../ast/extract.js";
import { extractReexports } from "../lang/common.js";

export interface CodeInfo {
  symbols: CodeSymbol[];
  summary?: string;
  refs: RawRef[]; // import refs (raw specifiers, unresolved)
  pkg?: string; // Java: the file's own `package x.y.z;` — used to derive source roots
  idents?: string[]; // distinctive identifiers referenced (AST path) — feeds `use` edges
  // Call-site callee names (+ immediate receiver for qualified calls) — feeds
  // call edges and receiver-gated sink catalogs.
  calls?: { name: string; line: number; receiver?: string }[];
  importedNames?: string[]; // JS/TS named-import bindings (AST path) — feeds the call gate
}

const JS_TS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const PY = new Set([".py", ".pyi"]);
const C_CPP = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);

// Tooling pragmas and boilerplate that are technically the first comment but say
// nothing about what the file does — never use them as a summary.
const DIRECTIVE_RE =
  /^(eslint\b|eslint-|prettier\b|prettier-|tslint\b|jshint\b|jslint\b|globals?\b|istanbul\b|c8\s|v8\s|@ts-|ts-|@flow\b|@jsx\b|@jsxRuntime\b|@jest-environment\b|@vitest-environment\b|@license\b|@preserve\b|@copyright\b|copyright\b|spdx-|<reference\b|use strict|biome-|deno-lint|noqa\b|type:\s*ignore|pylint:|flake8:|mypy:|coding[:=])/i;

function isDirective(line: string): boolean {
  return DIRECTIVE_RE.test(line.trim());
}

// License / banner boilerplate common in minified-library preambles (the `/*!`
// "preserve" banner of Express, jQuery, Bootstrap, Lodash, moment, …): a license
// name or a "released under"/URL line, not a description of what the file does.
// "Copyright" and "@license" are already caught by DIRECTIVE_RE.
const BANNER_RE =
  /^((?:mit|isc|bsd|apache|gnu|gpl|mpl|lgpl|agpl)\s+licen[sc]ed?\b|licen[sc]ed\b|(?:released|distributed)\s+under\b|all rights reserved\b|https?:\/\/|www\.)/i;

function isBanner(line: string): boolean {
  return BANNER_RE.test(line.trim());
}

// The leading comment block of a file, turned into one summary line. Handles
// `//`, `#`, and `/* … */` / `""" … """` openers. Stops at the first code line.
function topDocComment(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const collected: string[] = [];
  let inBlock: "c" | "py" | null = null;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (inBlock === "c") {
      // Strip the closing `*/` BEFORE the leading `*`s, so a lone `*/` (or a line
      // ending in `*/`) doesn't leave a stray "/" once the leading star is gone.
      collected.push(line.replace(/\*+\/\s*$/, "").replace(/^\*+/, "").trim());
      if (line.includes("*/")) inBlock = null;
      continue;
    }
    if (inBlock === "py") {
      if (line.includes('"""') || line.includes("'''")) {
        collected.push(line.replace(/['"]{3}.*$/, "").trim());
        inBlock = null;
      } else collected.push(line);
      continue;
    }
    if (line === "" && collected.length === 0) continue; // skip leading blanks
    if (line.startsWith("#!")) continue; // shebang
    if (line.startsWith("//")) {
      collected.push(line.replace(/^\/+/, "").trim());
      continue;
    }
    if (line.startsWith("#")) {
      collected.push(line.replace(/^#+/, "").trim());
      continue;
    }
    if (line.startsWith("/*")) {
      // Drop the opener, INCLUDING the `!` of a `/*!` "preserve" banner — else the
      // stripped text is just "!", which the first-sentence regex then treats as a
      // whole sentence, yielding the garbage summary "!".
      collected.push(line.replace(/^\/\*+!?/, "").replace(/\*+\/\s*$/, "").trim());
      if (!line.includes("*/")) inBlock = "c";
      continue;
    }
    if (line.startsWith('"""') || line.startsWith("'''")) {
      const rest = line.slice(3);
      if (rest.includes('"""') || rest.includes("'''")) collected.push(rest.replace(/['"]{3}.*$/, "").trim());
      else {
        collected.push(rest.trim());
        inBlock = "py";
      }
      continue;
    }
    break; // first real code line
  }
  const text = collected
    .filter((l) => l && !isDirective(l) && !isBanner(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 8) return undefined;
  // First sentence, capped.
  const sentence = /^(.*?[.!?])(\s|$)/.exec(text);
  return (sentence ? sentence[1]! : text).slice(0, 200);
}

// Rust `use` paths may end in a brace group (`use crate::a::{b, c::d};`, nested
// allowed). Expand each leaf into a full path, capped — a giant prelude group
// shouldn't explode into hundreds of refs.
const MAX_USE_EXPANSION = 16;
function expandUseGroups(path: string, out: string[] = []): string[] {
  if (out.length >= MAX_USE_EXPANSION) return out;
  const brace = path.indexOf("{");
  if (brace === -1) {
    const cleaned = path.replace(/\s+as\s+\w+\s*$/, "").replace(/::\s*\*\s*$/, "").replace(/^::/, "").trim();
    if (cleaned) out.push(cleaned);
    return out;
  }
  const prefix = path.slice(0, brace);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < path.length; i++) {
    if (path[i] === "{") depth++;
    else if (path[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return out; // unbalanced — drop rather than guess
  const parts: string[] = [];
  let cur = "";
  depth = 0;
  for (const ch of path.slice(brace + 1, end)) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t === "self") expandUseGroups(prefix.replace(/::\s*$/, ""), out);
    else expandUseGroups(prefix + t, out);
  }
  return out;
}

// Extract import specifiers as written (no resolution). Resolution needs
// repo-wide context (tsconfig paths, go.mod, python roots) and happens later.
function extractImports(ext: string, content: string): RawRef[] {
  const specs = new Set<string>();
  const lines = content.split(/\r?\n/);

  if (JS_TS.has(ext)) {
    // Run over the WHOLE content, not line-by-line: a long `import { … } from "x"`
    // (or `export { … } from "x"`) is routinely wrapped across several lines by
    // formatters, and a per-line scan never sees the `from` clause — silently
    // dropping the edge. `[^'"]*?` already excludes quotes, so it can't run past
    // the statement's own specifier; the `g` flag also catches >1 per line.
    let m: RegExpExecArray | null;
    const from = /(?:^|[^\w$.])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
    while ((m = from.exec(content))) specs.add(m[1]!);
    const bare = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
    while ((m = bare.exec(content))) specs.add(m[1]!);
    const req = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = req.exec(content))) specs.add(m[1]!);
    const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dyn.exec(content))) specs.add(m[1]!);
  } else if (PY.has(ext)) {
    for (const line of lines) {
      const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line);
      if (from) {
        specs.add(from[1]!);
        continue;
      }
      const imp = /^\s*import\s+(.+)$/.exec(line);
      if (imp) {
        for (const part of imp[1]!.split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0]!.trim();
          if (name && /^[\w.]+$/.test(name)) specs.add(name);
        }
      }
    }
  } else if (ext === ".go") {
    let inBlock = false;
    for (const line of lines) {
      const t = line.trim();
      if (inBlock) {
        if (t === ")") {
          inBlock = false;
          continue;
        }
        const b = /"([^"]+)"/.exec(t);
        if (b) specs.add(b[1]!);
        continue;
      }
      if (/^import\s*\($/.test(t)) {
        inBlock = true;
        continue;
      }
      const single = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(t);
      if (single) specs.add(single[1]!);
    }
  } else if (ext === ".rs") {
    let m: RegExpExecArray | null;
    // `mod foo;` declares a child module that MUST exist as a file (an inline
    // `mod foo { … }` body has no `;` and is skipped).
    const modRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
    while ((m = modRe.exec(content))) specs.add(`mod ${m[1]}`);
    // `use` paths, brace groups expanded. External crates (std, serde, …) are
    // filtered at resolve time, where the in-repo crate list lives.
    const useRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;
    while ((m = useRe.exec(content))) {
      for (const p of expandUseGroups(m[1]!.trim())) specs.add(p);
    }
  } else if (ext === ".java") {
    // `import com.a.b.C;` / `import static com.a.b.C.method;` — wildcards kept
    // as written; the resolver maps packages onto source roots.
    let m: RegExpExecArray | null;
    const imp = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
    while ((m = imp.exec(content))) specs.add(m[1]!);
  } else if (ext === ".rb" || ext === ".rake") {
    // `require_relative "x"` is relative to the file — emit it as a relative path
    // (leading "./") so the resolver resolves it against the file's dir. `require
    // "x"` is resolved against lib roots or is external (a gem).
    let m: RegExpExecArray | null;
    const rel = /^\s*require_relative\s+['"]([^'"]+)['"]/gm;
    while ((m = rel.exec(content))) specs.add(/^\.\.?\//.test(m[1]!) ? m[1]! : "./" + m[1]!);
    const req = /^\s*require\s+['"]([^'"]+)['"]/gm;
    while ((m = req.exec(content))) specs.add(m[1]!);
  } else if (C_CPP.has(ext)) {
    // Local `#include "foo.h"` — a real in-repo dependency. `<...>` is a system/
    // third-party header (external) and is deliberately not captured.
    let m: RegExpExecArray | null;
    const inc = /^\s*#\s*include\s*"([^"]+)"/gm;
    while ((m = inc.exec(content))) specs.add(m[1]!);
  } else if (ext === ".php") {
    // `use Foo\Bar\Baz;` (namespace, resolved via composer PSR-4) and
    // `require/include 'file.php'` (relative path, emitted with a leading "./").
    let m: RegExpExecArray | null;
    const use = /^\s*use\s+(?:function\s+|const\s+)?\\?([A-Za-z_][\w\\]*)\s*(?:as\s+\w+)?\s*;/gm;
    while ((m = use.exec(content))) specs.add(m[1]!);
    const inc = /\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g;
    while ((m = inc.exec(content))) specs.add(/^\.\.?\//.test(m[1]!) ? m[1]! : "./" + m[1]!);
  } else if (ext === ".cs") {
    // `using Foo.Bar;` — a namespace import, resolved to files declaring that
    // namespace. Skip alias (`using X = ...`) and resource (`using (...)`) forms.
    let m: RegExpExecArray | null;
    const using = /^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm;
    while ((m = using.exec(content))) specs.add(m[1]!);
  }

  return [...specs].map((spec) => ({ kind: "import" as const, spec }));
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
// collector: cap 512, deduped by name+line, sorted by name then line. An
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
  for (let i = 0; i < lines.length && out.size < maxCalls; i++) {
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
    while ((m = CALL_RE.exec(line)) !== null && out.size < maxCalls) {
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
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.line - b.line));
}

// `opts.maxCallsPerFile` overrides the per-file call-site cap (default 512) on
// BOTH extraction tiers — AST and regex — so recall-oriented consumers can raise
// it. Dedup/sort semantics are unchanged; absent, output is byte-identical.
export function extractCode(rel: string, ext: string, content: string, opts: { maxCallsPerFile?: number } = {}): CodeInfo {
  // Symbols come from tree-sitter when a grammar is loaded for this extension
  // (AST-exact: real nesting, precise kinds, structural export), else the regex
  // extractors. Imports/pkg stay on the battle-tested regex path here — their
  // resolution is covered by resolve tests and the e2e ratchet; the new-language
  // AST importers land with their resolvers.
  const ast = extractAst(rel, ext, content, { maxCalls: opts.maxCallsPerFile });
  const symbols = (ast ? ast.symbols : extractSymbols(rel, ext, content)).slice(0, 400);
  // Add barrel re-exports the local def didn't already cover.
  const known = new Set(symbols.map((s) => s.name));
  const reexports = extractReexports(rel, content, symbols).filter((s) => !known.has(s.name));
  return {
    symbols: [...symbols, ...reexports],
    summary: topDocComment(content),
    refs: extractImports(ext, content),
    // pkg anchors namespace→source-root resolution: Java's `package`, C#'s
    // `namespace` (block or file-scoped). Both feed the same resolver pattern.
    pkg:
      ext === ".java"
        ? /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1]
        : ext === ".cs"
          ? /^\s*(?:file-scoped\s+)?namespace\s+([\w.]+)/m.exec(content)?.[1]
          : undefined,
    idents: ast?.idents,
    // AST call sites when a grammar parsed the file; the conservative regex
    // collector otherwise, so caller indexes exist without the wasm sidecar.
    // `symbols` (this file's own regex-extracted defs) lets the collector
    // exclude a definition's own name+line from its call candidates.
    calls: ast ? ast.calls : collectCallsRegex(content, symbols, opts.maxCallsPerFile),
    importedNames: ast?.importedNames,
  };
}
