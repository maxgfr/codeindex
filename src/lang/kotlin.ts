import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Kotlin. `private`/`internal` are not exported; the default (public) is.
const vis = (_m: RegExpExecArray, l: string) => !/\b(private|internal)\b/.test(l);

const RULES: Rule[] = [
  { re: /^\s*(?:public\s+|internal\s+|private\s+|abstract\s+|sealed\s+|open\s+|final\s+|data\s+)*class\s+(?<name>\w+)/, kind: "class", exported: vis },
  { re: /^\s*(?:public\s+|internal\s+|private\s+|fun\s+)?interface\s+(?<name>\w+)/, kind: "interface", exported: vis },
  { re: /^\s*(?:public\s+|internal\s+|private\s+|companion\s+)?object\s+(?<name>\w+)/, kind: "object", exported: vis },
  { re: /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|override\s+|open\s+|abstract\s+|suspend\s+|inline\s+|operator\s+)*fun\s+(?:<[^>]*>\s+)?(?<name>\w+)\s*\(/, kind: "function", exported: vis },
];

export const kotlin = {
  lang: "kotlin",
  exts: [".kt", ".kts"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "kotlin", RULES);
  },
};
