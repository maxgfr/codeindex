import type { CodeSymbol } from "../types.js";
import { maskBraced } from "../extract/imports.js";
import { ID, scan, type Lexis, type Rule } from "./common.js";

// Swift. `private`/`fileprivate` are not exported; everything else
// (internal/public/open, the default) is treated as public surface. A setter
// restriction (`public private(set) var`) keeps the property public. The regex
// tier is Swift's only one: no grammar ships for it.
const vis = (_m: RegExpExecArray, l: string) => !/\b(?:private|fileprivate)\b(?!\s*\(\s*set\s*\))/.test(l);

// Attributes come first and may take arguments (`@objc`, `@MainActor`,
// `@available(iOS 13, *)`); modifiers follow in any order, some with an
// argument of their own (`private(set)`, `unowned(safe)`). `class` is a
// modifier too (`class func`), which the type rule below must not read as a
// class named "func".
const ANNOT = String.raw`(?:@${ID}(?:\([^)]*\))?\s+)*`;
const MODS = String.raw`(?:(?:public|open|internal|private|fileprivate|package|final|static|class|override|mutating|nonmutating|convenience|required|dynamic|lazy|weak|unowned|indirect|nonisolated|isolated|distributed|optional|prefix|postfix|infix|async)(?:\([^)]*\))?\s+)*`;
const HEAD = String.raw`^\s*${ANNOT}${MODS}`;
const rule = (kw: string, kind: string, extra: Partial<Rule> = {}): Rule => ({
  re: new RegExp(String.raw`${HEAD}${kw}\s+(?!(?:func|var|let|subscript|init)\b)(?<name>${ID})`, "u"),
  kind,
  exported: vis,
  ...extra,
});

const RULES: Rule[] = [
  rule("class", "class"),
  rule("struct", "struct"),
  rule("enum", "enum"),
  rule("protocol", "protocol"),
  rule("actor", "actor"),
  // `extension Worker: Codable` is named after the type it extends, which is
  // what a lookup of the members it adds needs.
  { re: new RegExp(String.raw`${HEAD}extension\s+(?<name>${ID}(?:\.${ID})*)`, "u"), kind: "extension", exported: vis },
  rule("typealias", "type"),
  rule("func", "function"),
  // Initializers are called by the type's name, but their declarations are all
  // named `init`; the kind tells them apart from a method of that name.
  { re: new RegExp(String.raw`${HEAD}(?<name>init)[?!]?\s*[<(]`, "u"), kind: "constructor", exported: vis },
  { re: new RegExp(String.raw`${HEAD}(?<name>deinit)\s*\{`, "u"), kind: "destructor", exported: vis },
  { re: new RegExp(String.raw`${HEAD}(?<name>subscript)\s*[<(]`, "u"), kind: "method", exported: vis },
  // A stored or computed property, at the top level or in a type's body; the
  // same `let` in a function body is a local.
  { re: new RegExp(String.raw`${HEAD}(?:let|var)\s+(?<name>${ID})\s*[:={]`, "u"), kind: "property", exported: vis, scope: "member" },
];

export const swift = {
  lang: "swift",
  exts: [".swift"],
  lexis: {
    mask: (src: string) => maskBraced(src, { nested: true, triple: true, squote: "none", raw: "#" }),
    comment: /^\s*\/\//,
    block: true,
    decoration: /^\s*@/,
  } satisfies Lexis,
  extract(rel: string, content: string, masked?: string): CodeSymbol[] {
    return scan(rel, content, "swift", RULES, masked);
  },
};
