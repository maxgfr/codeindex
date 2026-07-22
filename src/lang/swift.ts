import type { CodeSymbol } from "../types.js";
import { scan, type Rule } from "./common.js";

// Swift. Types and funcs. `private`/`fileprivate` are not exported; everything
// else (internal/public/open, the default) is treated as public surface.
const vis = (_m: RegExpExecArray, l: string) => !/\b(private|fileprivate)\b/.test(l);
const MODS = "(?:public\\s+|open\\s+|internal\\s+|private\\s+|fileprivate\\s+)?(?:final\\s+)?";

const RULES: Rule[] = [
  { re: new RegExp(`^\\s*${MODS}class\\s+(?<name>\\w+)`), kind: "class", exported: vis },
  { re: new RegExp(`^\\s*${MODS}struct\\s+(?<name>\\w+)`), kind: "struct", exported: vis },
  { re: new RegExp(`^\\s*${MODS}enum\\s+(?<name>\\w+)`), kind: "enum", exported: vis },
  { re: new RegExp(`^\\s*${MODS}protocol\\s+(?<name>\\w+)`), kind: "protocol", exported: vis },
  { re: /^\s*(?:public\s+|open\s+|internal\s+|private\s+|fileprivate\s+)?(?:static\s+|class\s+|final\s+|override\s+|mutating\s+|@\w+\s+)*func\s+(?<name>\w+)/, kind: "function", exported: vis },
];

export const swift = {
  lang: "swift",
  exts: [".swift"],
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "swift", RULES);
  },
};
