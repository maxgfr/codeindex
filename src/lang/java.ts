import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Java. Types and methods, with `public` driving the exported flag. The method
// rule is conservative: a visibility modifier, a return type, then `name(`.
const RULES: Rule[] = [
  { re: /^\s*(?:public|protected|private)?\s*(?:abstract\s+|final\s+)?class\s+(?<name>[\w]+)/, kind: "class", exported: (_m, l) => /\bpublic\b/.test(l) },
  { re: /^\s*(?:public|protected|private)?\s*interface\s+(?<name>[\w]+)/, kind: "interface", exported: (_m, l) => /\bpublic\b/.test(l) },
  { re: /^\s*(?:public|protected|private)?\s*enum\s+(?<name>[\w]+)/, kind: "enum", exported: (_m, l) => /\bpublic\b/.test(l) },
  { re: /^\s*(?:public|protected|private)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+)*[\w<>\[\],.?\s]+\s+(?<name>[\w]+)\s*\(/, kind: "method", exported: (_m, l) => /\bpublic\b/.test(l) },
];

export const java = {
  lang: "java",
  exts: [".java"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "java", RULES);
  },
};
