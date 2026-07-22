import type { CodeSymbol, RawRef } from "../types.js";
import { extractSymbols } from "../lang/registry.js";
import { extractAst } from "../ast/extract.js";

export interface CodeInfo {
  symbols: CodeSymbol[];
  summary?: string;
  refs: RawRef[]; // import refs (raw specifiers, unresolved)
  pkg?: string; // Java: the file's own `package x.y.z;` — used to derive source roots
  idents?: string[]; // distinctive identifiers referenced (AST path) — feeds `use` edges
  calls?: { name: string; line: number }[]; // call-site callee names (AST path) — feeds call edges
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

// Barrel re-exports (`export { A, B as C } from './x'`, `export * from './y'`).
// The line-based lang extractor can't capture multi-name lists, but these ARE
// the public facade of a module — so list them as exported symbols here.
function extractReexports(rel: string, content: string): CodeSymbol[] {
  if (!JS_TS.has(rel.slice(rel.lastIndexOf(".")))) return [];
  const lang = /\.(ts|tsx|mts|cts)$/.test(rel) ? "typescript" : "javascript";
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  const lineAt = (idx: number): number => content.slice(0, idx).split(/\r?\n/).length;

  const named = /export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(content)) && out.length < 60) {
    const from = m[2];
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      const as = /^(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
      const name = as ? as[2]! : p;
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === "default" || seen.has(name)) continue;
      seen.add(name);
      out.push({
        name, kind: "reexport", file: rel, line: lineAt(m.index),
        signature: from ? `export { ${name} } from "${from}"` : `export { ${name} }`,
        exported: true, lang,
      });
    }
  }

  const star = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g;
  while ((m = star.exec(content)) && out.length < 60) {
    const ns = m[1];
    const from = m[2]!;
    const key = "*" + (ns ?? from);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: ns ?? `* (${from})`, kind: ns ? "reexport" : "reexport-all", file: rel,
      line: lineAt(m.index), signature: `export * ${ns ? `as ${ns} ` : ""}from "${from}"`,
      exported: true, lang,
    });
  }
  return out;
}

export function extractCode(rel: string, ext: string, content: string): CodeInfo {
  // Symbols come from tree-sitter when a grammar is loaded for this extension
  // (AST-exact: real nesting, precise kinds, structural export), else the regex
  // extractors. Imports/pkg stay on the battle-tested regex path here — their
  // resolution is covered by resolve tests and the e2e ratchet; the new-language
  // AST importers land with their resolvers.
  const ast = extractAst(rel, ext, content);
  const symbols = (ast ? ast.symbols : extractSymbols(rel, ext, content)).slice(0, 400);
  // Add barrel re-exports the local def didn't already cover.
  const known = new Set(symbols.map((s) => s.name));
  const reexports = extractReexports(rel, content).filter((s) => !known.has(s.name));
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
    calls: ast?.calls,
    importedNames: ast?.importedNames,
  };
}
