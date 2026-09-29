import type { CodeSymbol } from "../types.js";
import { maskBraced } from "../extract/imports.js";
import { ID, scan, type Lexis, type Rule } from "./common.js";

// Go. Exported identifiers start with an uppercase letter (any script's) —
// that drives the `exported` flag. Methods carry a receiver:
// `func (r T) Name(...)`. A generic declaration puts its type parameters in
// brackets right after the name (`func Map[T, U any](`, `type Box[T any]
// struct`), with no space: `type Bytes [4]byte` is an array type instead.
const upper = (name: string) => /^\p{Lu}/u.test(name);
const exp = (m: RegExpExecArray) => upper(m.groups!.name!);
const TPARAMS = String.raw`(?:\[[^\]]*\])?`;

const RULES: Rule[] = [
  { re: new RegExp(String.raw`^func\s+\([^)]*\)\s+(?<name>${ID})\s*\(`, "u"), kind: "method", exported: exp },
  { re: new RegExp(String.raw`^func\s+(?<name>${ID})${TPARAMS}\s*\(`, "u"), kind: "function", exported: exp },
  ...typeRules("^type\\s+"),
  { re: new RegExp(String.raw`^const\s+(?<name>(?!_\b)${ID})`, "u"), kind: "const", exported: exp },
  { re: new RegExp(String.raw`^var\s+(?<name>(?!_\b)${ID})`, "u"), kind: "var", exported: exp },
];

function typeRules(prefix: string): Rule[] {
  return [
    { re: new RegExp(String.raw`${prefix}(?<name>${ID})${TPARAMS}\s+struct\b`, "u"), kind: "struct", exported: exp },
    { re: new RegExp(String.raw`${prefix}(?<name>${ID})${TPARAMS}\s+interface\b`, "u"), kind: "interface", exported: exp },
    { re: new RegExp(String.raw`${prefix}(?<name>${ID})${TPARAMS}\s+`, "u"), kind: "type", exported: exp },
  ];
}

// The specs of a grouped declaration, one per line at the group's indentation:
// `const ( A Kind = iota; B )`, `var ( … )`, `type ( … )`. gin declares most
// of its exported constants this way.
const GROUP_OPEN = /^(const|var|type)\s*\(\s*$/;
const GROUPED: Record<string, Rule[]> = {
  const: [{ re: new RegExp(String.raw`^\s+(?<name>(?!_\b)${ID})\b`, "u"), kind: "const", exported: exp }],
  var: [{ re: new RegExp(String.raw`^\s+(?<name>(?!_\b)${ID})\b`, "u"), kind: "var", exported: exp }],
  type: typeRules("^\\s+"),
};

function grouped(rel: string, content: string, masked: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = content.split(/\r?\n/);
  const code = masked.split(/\r?\n/);
  for (let i = 0; i < code.length; i++) {
    const open = GROUP_OPEN.exec(code[i]!);
    if (!open) continue;
    const rules = GROUPED[open[1]!]!;
    let indent: string | undefined;
    for (i++; i < code.length && !/^\)/.test(code[i]!); i++) {
      const line = code[i]!;
      if (!line.trim()) continue;
      // Only the group's own specs: a deeper line is a spec's continuation (a
      // struct's fields, a wrapped value).
      const lead = /^\s*/.exec(line)![0];
      indent ??= lead;
      if (lead !== indent) continue;
      const spec = scan(rel, lines[i]!, "go", rules, line)[0];
      if (spec) out.push({ ...spec, line: i + 1 });
    }
  }
  return out;
}

export const go = {
  lang: "go",
  exts: [".go"],
  lexis: {
    mask: (src: string) => maskBraced(src, { squote: "char", backtick: true }),
    comment: /^\s*\/\//,
    block: true,
  } satisfies Lexis,
  extract(rel: string, content: string, masked?: string): CodeSymbol[] {
    const symbols = scan(rel, content, "go", RULES, masked);
    const specs = masked === undefined ? [] : grouped(rel, content, masked);
    return specs.length ? [...symbols, ...specs].sort((a, b) => a.line - b.line) : symbols;
  },
};
