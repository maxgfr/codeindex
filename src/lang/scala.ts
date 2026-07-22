import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Scala. class/trait/object (incl. `case class`) and `def`. `private`/
// `protected` defs are not exported.
const RULES: Rule[] = [
  { re: /^\s*(?:final\s+|sealed\s+|abstract\s+|implicit\s+)*(?:case\s+)?class\s+(?<name>\w+)/, kind: "class", exported: true },
  { re: /^\s*(?:sealed\s+)?trait\s+(?<name>\w+)/, kind: "trait", exported: true },
  { re: /^\s*(?:case\s+)?object\s+(?<name>\w+)/, kind: "object", exported: true },
  { re: /^\s*(?:override\s+|final\s+|private\s+|protected\s+|implicit\s+)*def\s+(?<name>\w+)/, kind: "def", exported: (_m, l) => !/\b(private|protected)\b/.test(l) },
];

export const scala = {
  lang: "scala",
  exts: [".scala", ".sc"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "scala", RULES);
  },
};
