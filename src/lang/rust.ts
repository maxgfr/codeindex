import type { CodeSymbol } from "../types.js";
import { maskBraced } from "../extract/imports.js";
import { scan, type Lexis, type Rule } from "./common.js";

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
  lexis: {
    mask: (src: string) => maskBraced(src, { nested: true, squote: "char", multiline: true, raw: "r" }),
    comment: /^\s*\/\/(?!!)/,
    block: true,
    decoration: /^\s*#\[/,
  } satisfies Lexis,
  extract(rel: string, content: string, masked?: string): CodeSymbol[] {
    return scan(rel, content, "rust", RULES, masked);
  },
};
