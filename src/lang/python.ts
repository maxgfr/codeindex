import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Python. A name not prefixed with "_" is treated as part of the public
// surface (the usual convention). Indented `def` → method; column-0 `def` →
// module function.
const pub = (name: string) => !name.startsWith("_") || name.startsWith("__");

const RULES: Rule[] = [
  { re: /^(?:async\s+)?def\s+(?<name>[\w]+)\s*\(/, kind: "function", exported: (m) => pub(m.groups!.name!) },
  { re: /^\s+(?:async\s+)?def\s+(?<name>[\w]+)\s*\(/, kind: "method", exported: (m) => pub(m.groups!.name!) },
  { re: /^class\s+(?<name>[\w]+)/, kind: "class", exported: (m) => pub(m.groups!.name!) },
  { re: /^\s+class\s+(?<name>[\w]+)/, kind: "class", exported: (m) => pub(m.groups!.name!) },
];

export const python = {
  lang: "python",
  exts: [".py", ".pyi"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "python", RULES);
  },
};
