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
  // top-level const arrow function (not exported)
  { re: /^\s*(?:const|let)\s+(?<name>[\w$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/, kind: "const", exported: false },
  // `export default Foo;` — a class/const declared above and exported by reference.
  { re: /^\s*export\s+default\s+(?<name>[A-Za-z_$][\w$]*)\s*;?\s*$/, kind: "default", exported: true },
];

export const jsTs = {
  lang: "javascript/typescript",
  exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  extract(rel: string, content: string): CodeSymbol[] {
    const lang = rel.match(/\.(ts|tsx|mts|cts)$/) ? "typescript" : "javascript";
    return scan(rel, content, lang, RULES);
  },
};
