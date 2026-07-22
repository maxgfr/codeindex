import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// C#. `public`/`internal` mark the public surface. Covers types and methods.
const pub = (_m: RegExpExecArray, l: string) => /\b(public|internal)\b/.test(l);

const RULES: Rule[] = [
  { re: /^\s*(?:public|internal|protected|private)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|record)\s+(?<name>\w+)/, kind: "class", exported: pub },
  { re: /^\s*(?:public|internal|protected|private)?\s*(?:partial\s+)?interface\s+(?<name>\w+)/, kind: "interface", exported: pub },
  { re: /^\s*(?:public|internal|protected|private)?\s*(?:readonly\s+)?(?:ref\s+)?struct\s+(?<name>\w+)/, kind: "struct", exported: pub },
  { re: /^\s*(?:public|internal|protected|private)?\s*enum\s+(?<name>\w+)/, kind: "enum", exported: pub },
  // method: a visibility modifier, a return type, then `name(`
  { re: /^\s*(?:public|internal|protected|private)\s+(?:static\s+|virtual\s+|override\s+|async\s+|sealed\s+|abstract\s+|new\s+)*[\w<>\[\],.?]+\s+(?<name>\w+)\s*(?:<[^>]*>)?\s*\(/, kind: "method", exported: pub },
];

export const csharp = {
  lang: "csharp",
  exts: [".cs"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "csharp", RULES);
  },
};
