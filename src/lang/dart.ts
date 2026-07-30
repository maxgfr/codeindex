import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Dart. Regex-only, deliberately: `tree-sitter-dart` publishes a wasm, but
// web-tree-sitter 0.26 cannot load it (an ABI mismatch), so shipping it would put
// dead bytes in the grammars asset and advertise AST precision that silently
// degrades. Until the grammar republishes, this is what keeps a Flutter codebase
// from indexing to nothing.
//
// Dart has no visibility keywords: a leading underscore IS the private marker,
// for top-level declarations and members alike.
const vis = (m: RegExpExecArray) => !(m.groups?.name ?? "").startsWith("_");

const RULES: Rule[] = [
  {
    re: /^\s*(?:abstract\s+|base\s+|final\s+|sealed\s+|interface\s+)*class\s+(?<name>\w+)/,
    kind: "class",
    exported: vis,
  },
  { re: /^\s*mixin\s+(?<name>\w+)/, kind: "mixin", exported: vis },
  { re: /^\s*extension\s+(?<name>\w+)/, kind: "extension", exported: vis },
  { re: /^\s*enum\s+(?<name>\w+)/, kind: "enum", exported: vis },
  { re: /^\s*typedef\s+(?<name>\w+)/, kind: "type", exported: vis },
  // A method or function: a return type (or `void`/`Future<…>`) then a name and
  // an argument list. `get`/`set` accessors are matched by their own rule below
  // so the accessor keyword does not read as the name.
  {
    re: /^\s*(?:@\w+\s+)*(?:static\s+|final\s+|const\s+|external\s+|abstract\s+)*(?:[\w<>,?\[\]. ]+\s+)?(?<name>\w+)\s*\([^)]*\)\s*(?:async\s*\*?\s*)?(?:=>|\{|;)/,
    kind: "function",
    exported: vis,
  },
  { re: /^\s*(?:static\s+)?[\w<>,?\[\]. ]+\s+get\s+(?<name>\w+)/, kind: "getter", exported: vis },
  { re: /^\s*(?:static\s+)?set\s+(?<name>\w+)\s*\(/, kind: "setter", exported: vis },
];

export const dart = {
  lang: "dart",
  exts: [".dart"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "dart", RULES);
  },
};
