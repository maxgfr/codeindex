import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Shell (bash/zsh/sh). Both function syntaxes: `function name { … }` and
// `name() { … }`.
const RULES: Rule[] = [
  { re: /^\s*function\s+(?<name>[\w:-]+)\s*(?:\(\))?\s*\{?/, kind: "function", exported: true },
  { re: /^\s*(?<name>[A-Za-z_][\w:-]*)\s*\(\)\s*\{?/, kind: "function", exported: true },
];

export const shell = {
  lang: "shell",
  exts: [".sh", ".bash", ".zsh", ".ksh"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "shell", RULES);
  },
};
