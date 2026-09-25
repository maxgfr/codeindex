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
    // A table function (`M.go`, `M:start`) is the table's member, named by its
    // last segment — what a call site (`u.go()`) records — exactly as the AST
    // tier names it (see luaMember in ast/specs.ts).
    return scan(rel, content, "lua", RULES).map((s) => {
      const at = Math.max(s.name.lastIndexOf("."), s.name.lastIndexOf(":"));
      return at > 0 && at < s.name.length - 1 ? { ...s, name: s.name.slice(at + 1), parent: s.name.slice(0, at) } : s;
    });
  },
};
