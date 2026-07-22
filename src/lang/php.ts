import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// PHP. Classes/interfaces/traits/enums and functions/methods. Methods marked
// `private`/`protected` are treated as non-exported.
const RULES: Rule[] = [
  { re: /^\s*(?:abstract\s+|final\s+)*class\s+(?<name>\w+)/, kind: "class", exported: true },
  { re: /^\s*interface\s+(?<name>\w+)/, kind: "interface", exported: true },
  { re: /^\s*trait\s+(?<name>\w+)/, kind: "trait", exported: true },
  { re: /^\s*enum\s+(?<name>\w+)/, kind: "enum", exported: true },
  {
    re: /^\s*(?:public\s+|protected\s+|private\s+|static\s+|abstract\s+|final\s+)*function\s+(?<name>\w+)\s*\(/,
    kind: "function",
    exported: (_m, l) => !/\b(private|protected)\b/.test(l),
  },
];

export const php = {
  lang: "php",
  exts: [".php"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "php", RULES);
  },
};
