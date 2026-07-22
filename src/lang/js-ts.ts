import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// JavaScript / TypeScript. Heuristic, line-based: catches top-level
// declarations and their `export` status, which is what drives ranking and
// "where is X defined" navigation.
const RULES: Rule[] = [
  { re: /^\s*export\s+(?:async\s+)?function\s+(?<name>[\w$]+)/, kind: "function", exported: true },
  { re: /^\s*export\s+default\s+(?:async\s+)?function\s+(?<name>[\w$]+)/, kind: "function", exported: true },
  { re: /^\s*export\s+default\s+(?:abstract\s+)?class\s+(?<name>[\w$]+)/, kind: "class", exported: true },
  { re: /^\s*(?:async\s+)?function\s+(?<name>[\w$]+)/, kind: "function", exported: false },
  { re: /^\s*export\s+(?:abstract\s+)?class\s+(?<name>[\w$]+)/, kind: "class", exported: true },
  { re: /^\s*(?:abstract\s+)?class\s+(?<name>[\w$]+)/, kind: "class", exported: false },
  { re: /^\s*export\s+interface\s+(?<name>[\w$]+)/, kind: "interface", exported: true },
  { re: /^\s*interface\s+(?<name>[\w$]+)/, kind: "interface", exported: false },
  { re: /^\s*export\s+type\s+(?<name>[\w$]+)/, kind: "type", exported: true },
  { re: /^\s*type\s+(?<name>[\w$]+)\s*[=<]/, kind: "type", exported: false },
  { re: /^\s*export\s+enum\s+(?<name>[\w$]+)/, kind: "enum", exported: true },
  { re: /^\s*export\s+const\s+enum\s+(?<name>[\w$]+)/, kind: "enum", exported: true },
  // exported const/let bound to an arrow fn or value
  { re: /^\s*export\s+(?:const|let|var)\s+(?<name>[\w$]+)\s*[:=]/, kind: "const", exported: true },
  // CommonJS named exports: `exports.foo = …`, `module.exports.foo = …`
  { re: /^\s*exports\.(?<name>[\w$]+)\s*=/, kind: "const", exported: true },
  { re: /^\s*module\.exports\.(?<name>[\w$]+)\s*=/, kind: "const", exported: true },
  // top-level const arrow function (not exported)
  { re: /^\s*(?:const|let)\s+(?<name>[\w$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/, kind: "const", exported: false },
  // `export default Foo;` — a class/const declared above and exported by reference.
  { re: /^\s*export\s+default\s+(?<name>[A-Za-z_$][\w$]*)\s*;?\s*$/, kind: "default", exported: true },
];

// An anonymous default export (`export default function () {}`, `export default
// class extends Base {}`, `export default () => …`, `export default {…}`) has no
// name to capture — it gets named after the file stem (ultradoc parity), so the
// module's default export is still a real, referencable symbol.
const ANON_DEFAULT_RE = /^\s*export\s+default\s+(?:async\s+)?(?:function|class)?\s*(?:\(|\{|extends\b)/;
const NAMED_DEFAULT_RE = /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+(?!extends\b)[\w$]+/;

function stemOf(rel: string): string {
  return (rel.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
}

// Post-pass flipping local declarations to exported when an export LIST names
// them — forms the one-symbol-per-line rules above cannot see (mirrors
// ultradoc's applyExportLists):
// - `export { a, b as c }` marks locals `a`/`b` (the alias `c` itself is emitted
//   as a `reexport` symbol by extract/code.ts's extractReexports, both tiers);
//   `export { … } from "x"` is a pure re-export and names no locals.
// - `module.exports = { foo, bar: baz }` marks the shorthand names, keys and
//   identifier values (key = the exported surface, value = the local decl).
// - `export default Foo;` marks the ORIGINAL `Foo` declaration (the line rule
//   above keeps emitting the `default` reference symbol for byte-compat).
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}\s*(from\b)?/g;
const CJS_OBJECT_RE = /module\.exports\s*=\s*\{([^}]*)\}/g;
const DEFAULT_ID_RE = /(^|\n)\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*(?=\n|$)/g;

function applyExportLists(content: string, symbols: CodeSymbol[]): void {
  const markExported = (name: string | undefined): void => {
    if (!name || name === "default") return;
    for (const s of symbols) if (s.name === name) s.exported = true;
  };
  const handleList = (inner: string, cjs: boolean): void => {
    for (const raw of inner.split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(part);
      if (asMatch) {
        if (asMatch[2] !== "default") markExported(asMatch[1]);
        continue;
      }
      if (cjs) {
        const kv = /^([\w$]+)\s*:\s*([\w$]+)$/.exec(part);
        if (kv) {
          markExported(kv[1]);
          markExported(kv[2]);
          continue;
        }
      }
      markExported(/^([\w$]+)/.exec(part)?.[1]);
    }
  };
  let m: RegExpExecArray | null;
  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(content))) {
    if (!m[2]) handleList(m[1] ?? "", false);
  }
  CJS_OBJECT_RE.lastIndex = 0;
  while ((m = CJS_OBJECT_RE.exec(content))) handleList(m[1] ?? "", true);
  DEFAULT_ID_RE.lastIndex = 0;
  while ((m = DEFAULT_ID_RE.exec(content))) markExported(m[2]);
}

export const jsTs = {
  lang: "javascript/typescript",
  exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  extract(rel: string, content: string): CodeSymbol[] {
    const lang = rel.match(/\.(ts|tsx|mts|cts)$/) ? "typescript" : "javascript";
    const symbols = scan(rel, content, lang, RULES);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (ANON_DEFAULT_RE.test(line) && !NAMED_DEFAULT_RE.test(line)) {
        symbols.push({
          name: stemOf(rel), kind: "default", file: rel, line: i + 1,
          signature: line.trim().slice(0, 200), exported: true, lang,
        });
        break;
      }
    }
    applyExportLists(content, symbols);
    return symbols;
  },
};
