import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Lua. `function name(…)`, `local function name(…)`, `Table.method(…)` /
// `Table:method(…)`, and `name = function(…)`.
const RULES: Rule[] = [
  { re: /^\s*local\s+function\s+(?<name>[\w.:]+)\s*\(/, kind: "function", exported: false },
  { re: /^\s*function\s+(?<name>[\w.:]+)\s*\(/, kind: "function", exported: true },
  { re: /^\s*(?:local\s+)?(?<name>[\w.]+)\s*=\s*function\s*\(/, kind: "function", exported: true },
];

export const lua = {
  lang: "lua",
  exts: [".lua"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "lua", RULES);
  },
};
