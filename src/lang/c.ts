import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// C / C++. Regex heuristics: function definitions (a return type then `name(…)`
// with the line ending in an opening brace or nothing — not a `;` prototype or a
// control statement), plus type declarations. Conservative to avoid matching
// calls and macros.
const NOT_KEYWORD = "(?!\\s*(?:if|for|while|switch|return|else|do|sizeof|typedef)\\b)";

const RULES: Rule[] = [
  // C++ types
  { re: /^\s*(?:class|struct)\s+(?<name>[A-Za-z_]\w+)\s*(?:[:{]|$)/, kind: "class", exported: true },
  { re: /^\s*namespace\s+(?<name>[A-Za-z_]\w+)/, kind: "namespace", exported: true },
  // typedef struct/enum/union NAME {
  { re: /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+(?<name>[A-Za-z_]\w+)\s*\{/, kind: "struct", exported: true },
  // function definition: <type ...> name(<args>) [const] {?  at column 0-ish
  { re: new RegExp(`^${NOT_KEYWORD}[A-Za-z_][\\w\\s\\*&<>:,]*?\\b(?<name>[A-Za-z_]\\w+)\\s*\\([^;{]*\\)\\s*(?:const)?\\s*\\{?\\s*$`), kind: "function", exported: true },
];

export const c = {
  lang: "c/cpp",
  exts: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, rel.match(/\.(c|h)$/) ? "c" : "cpp", RULES);
  },
};
