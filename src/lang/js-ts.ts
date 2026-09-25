import type { CodeSymbol } from "../types.js";
import { maskJs } from "../extract/imports.js";
import { ID, scan, type Lexis, type Rule } from "./common.js";

// JavaScript / TypeScript. Heuristic, line-based: catches top-level
// declarations and their `export` status, which is what drives ranking and
// "where is X defined" navigation.
// `N` is a name: any Unicode identifier (common.ts ID), so every rule carries
// the `u` flag. `FN` is the `function` keyword with a generator's optional `*`,
// and `DECLARE` the ambient prefix of a .d.ts declaration
// (`export declare function f(): void;`): without it a declaration file
// yielded no symbols at all.
const N = `(?<name>${ID})`;
const FN = String.raw`function(?:\s*\*\s*|\s+)`;
const DECLARE = String.raw`(?:declare\s+)?`;
const rx = (src: string) => new RegExp(src, "u");

const RULES: Rule[] = [
  { re: rx(String.raw`^\s*export\s+${DECLARE}(?:async\s+)?${FN}${N}`), kind: "function", exported: true },
  { re: rx(String.raw`^\s*export\s+default\s+(?:async\s+)?${FN}${N}`), kind: "function", exported: true },
  { re: rx(String.raw`^\s*export\s+default\s+(?:abstract\s+)?class\s+(?!extends\b)${N}`), kind: "class", exported: true },
  { re: rx(String.raw`^\s*${DECLARE}(?:async\s+)?${FN}${N}`), kind: "function", exported: false },
  { re: rx(String.raw`^\s*export\s+${DECLARE}(?:abstract\s+)?class\s+${N}`), kind: "class", exported: true },
  { re: rx(String.raw`^\s*${DECLARE}(?:abstract\s+)?class\s+${N}`), kind: "class", exported: false },
  { re: rx(String.raw`^\s*export\s+${DECLARE}interface\s+${N}`), kind: "interface", exported: true },
  { re: rx(String.raw`^\s*${DECLARE}interface\s+${N}`), kind: "interface", exported: false },
  { re: rx(String.raw`^\s*export\s+${DECLARE}type\s+${N}`), kind: "type", exported: true },
  { re: rx(String.raw`^\s*${DECLARE}type\s+${N}\s*[=<]`), kind: "type", exported: false },
  { re: rx(String.raw`^\s*export\s+${DECLARE}(?:const\s+)?enum\s+${N}`), kind: "enum", exported: true },
  // `export namespace NS {`, `declare namespace NS`, `namespace A.B.C {`. The
  // AST tier calls these namespaces too. `declare module "x"` names a module
  // by string and declares nothing here; `module.exports` is not matched,
  // `module` needs a space after it.
  { re: rx(String.raw`^\s*export\s+${DECLARE}(?:namespace|module)\s+(?<name>${ID}(?:\.${ID})*)`), kind: "namespace", exported: true },
  { re: rx(String.raw`^\s*${DECLARE}(?:namespace|module)\s+(?<name>${ID}(?:\.${ID})*)\s*\{`), kind: "namespace", exported: false },
  // exported const/let bound to an arrow fn or value
  { re: rx(String.raw`^\s*export\s+${DECLARE}(?:const|let|var)\s+${N}\s*[:=;]`), kind: "const", exported: true },
  // CommonJS named exports: `exports.foo = …`, `module.exports.foo = …`
  { re: rx(String.raw`^\s*exports\.${N}\s*=`), kind: "const", exported: true },
  { re: rx(String.raw`^\s*module\.exports\.${N}\s*=`), kind: "const", exported: true },
  // top-level const arrow function (not exported)
  { re: rx(String.raw`^\s*(?:const|let)\s+${N}\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>`), kind: "const", exported: false },
  // A module constant bound to a VALUE, not exported: `const RE = /href=/g`.
  // The AST tier indexes these (a top-level binding is a declaration, only an
  // in-function one is a local), and a fallback tier that answers "no such
  // symbol" for every module constant diverges from the engine it stands in for.
  //
  // Anchored at column 0, unlike every rule above it: a line scanner cannot see
  // scope, so `^\s*` here would sweep in each `const x = 1` inside every function
  // body — the locals-flood the AST tier's inFunctionBody filter exists to
  // prevent, and the surplus this project criticises in a flat tags file. Column
  // 0 is the one module-scope proxy a line can carry. Must stay AFTER the arrow
  // and export rules: `scan()` keeps the first rule that matches a line.
  { re: rx(String.raw`^${DECLARE}(?:const|let|var)\s+${N}\s*[:=]`), kind: "const", exported: false },
  // `export default Foo;` — a class/const declared above and exported by reference.
  { re: rx(String.raw`^\s*export\s+default\s+${N}\s*;?\s*$`), kind: "default", exported: true },
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
//   above keeps emitting the `default` reference symbol for byte-compat), and
//   so does a declaration file's `export = Foo;`.
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}\s*(from\b)?/g;
const CJS_OBJECT_RE = /module\.exports\s*=\s*\{([^}]*)\}/g;
const DEFAULT_ID_RE = /(^|\n)\s*export(?:\s+default\s+|\s*=\s*)([A-Za-z_$][\w$]*)\s*;?\s*(?=\n|$)/g;

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
  // Masked like the import scan (comments, strings, template-literal text and
  // regex bodies blanked): a code generator's template literal holding
  // `export function notARealFunction() {}` declares nothing.
  lexis: {
    mask: maskJs,
    comment: /^\s*\/\//,
    block: true,
    decoration: /^\s*@/,
  } satisfies Lexis,
  extract(rel: string, content: string, masked = content): CodeSymbol[] {
    const lang = rel.match(/\.(ts|tsx|mts|cts)$/) ? "typescript" : "javascript";
    const symbols = scan(rel, content, lang, RULES, masked);
    const lines = masked.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (ANON_DEFAULT_RE.test(line) && !NAMED_DEFAULT_RE.test(line)) {
        symbols.push({
          name: stemOf(rel), kind: "default", file: rel, line: i + 1,
          signature: content.split(/\r?\n/)[i]!.trim().slice(0, 200), exported: true, lang,
        });
        break;
      }
    }
    applyExportLists(masked, symbols);
    return symbols;
  },
};
