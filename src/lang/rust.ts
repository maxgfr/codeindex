import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Rust. `pub` marks the public surface. Covers fn / struct / enum / trait /
// type declarations.
const isPub = (_m: RegExpExecArray, l: string) => /^\s*pub\b/.test(l);

const RULES: Rule[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+(?<name>[\w]+)/, kind: "function", exported: isPub },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(?<name>[\w]+)/, kind: "struct", exported: isPub },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(?<name>[\w]+)/, kind: "enum", exported: isPub },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(?<name>[\w]+)/, kind: "trait", exported: isPub },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(?<name>[\w]+)/, kind: "type", exported: isPub },
];

export const rust = {
  lang: "rust",
  exts: [".rs"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "rust", RULES);
  },
};
