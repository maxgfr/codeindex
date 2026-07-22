import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Go. Exported identifiers start with an uppercase letter — that drives the
// `exported` flag. Methods carry a receiver: `func (r T) Name(...)`.
const upper = (name: string) => /^[A-Z]/.test(name);

const RULES: Rule[] = [
  { re: /^func\s+\([^)]*\)\s+(?<name>[\w]+)\s*\(/, kind: "method", exported: (m) => upper(m.groups!.name!) },
  { re: /^func\s+(?<name>[\w]+)\s*\(/, kind: "function", exported: (m) => upper(m.groups!.name!) },
  { re: /^type\s+(?<name>[\w]+)\s+struct\b/, kind: "struct", exported: (m) => upper(m.groups!.name!) },
  { re: /^type\s+(?<name>[\w]+)\s+interface\b/, kind: "interface", exported: (m) => upper(m.groups!.name!) },
  { re: /^type\s+(?<name>[\w]+)\s+/, kind: "type", exported: (m) => upper(m.groups!.name!) },
];

export const go = {
  lang: "go",
  exts: [".go"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "go", RULES);
  },
};
