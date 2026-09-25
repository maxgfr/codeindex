import type { CodeSymbol } from "../types.js";
import { scan, type Lexis, type Rule } from "./common.js";

// Ruby. `def` (instance/class methods), `class`, and `module` declarations.
const RULES: Rule[] = [
  { re: /^\s*def\s+(?:self\.)?(?<name>[\w?!=]+)/, kind: "method", exported: true },
  { re: /^\s*class\s+(?<name>[\w:]+)/, kind: "class", exported: true },
  { re: /^\s*module\s+(?<name>[\w:]+)/, kind: "module", exported: true },
];

export const ruby = {
  lang: "ruby",
  exts: [".rb", ".rake"],
  lexis: {
    comment: /^\s*#(?![!{])/,
  } satisfies Lexis,
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "ruby", RULES);
  },
};
