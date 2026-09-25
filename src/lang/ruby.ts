import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Ruby. `def` (instance/class methods), `class`, and `module` declarations.
const RULES: Rule[] = [
  { re: /^\s*def\s+(?:self\.)?(?<name>[\w?!=]+)/, kind: "method", exported: true },
  // `private def helper` — a definition wrapped in the visibility call that
  // applies to it alone.
  {
    re: /^\s*(?<vis>public|private|protected|module_function|(?:public|private)_class_method)\s+def\s+(?:self\.)?(?<name>[\w?!=]+)/,
    kind: "method",
    exported: (m) => /^(public|module_function|public_class_method)$/.test(m.groups!.vis!),
  },
  { re: /^\s*class\s+(?<name>[\w:]+)/, kind: "class", exported: true },
  { re: /^\s*module\s+(?<name>[\w:]+)/, kind: "module", exported: true },
];

export const ruby = {
  lang: "ruby",
  exts: [".rb", ".rake"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "ruby", RULES);
  },
};
