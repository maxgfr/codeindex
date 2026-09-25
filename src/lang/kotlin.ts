import type { CodeSymbol } from "../types.js";
import { maskBraced } from "../extract/imports.js";
import { ID, scan, type Lexis, type Rule } from "./common.js";

// Kotlin. Only `private` is not exported: the default is public, and `internal`
// is visible to the whole module, which is how the AST tier (ast/specs.ts)
// reads it too. The regex tier is Kotlin's only one until `grammars pull`.
const vis = (_m: RegExpExecArray, l: string) => !/\bprivate\b/.test(l);

// Annotations on the declaration's own line: `@JvmStatic`, `@Deprecated("x")`.
const ANNOT = String.raw`(?:@[\w.:]+(?:\([^)]*\))?\s+)*`;
// Every modifier a declaration can carry, in any order. The class kinds among
// them (`enum`, `annotation`) are told apart by the rules below.
const MODS = String.raw`(?:(?:public|internal|private|protected|abstract|sealed|open|final|data|value|inline|inner|override|suspend|operator|infix|tailrec|external|lateinit|expect|actual|const|companion|enum|annotation)\s+)*`;
const HEAD = String.raw`^\s*${ANNOT}${MODS}`;
// An extension's receiver type: `String.`, `List<T>.`, `Map<K, V>?.`.
const RECEIVER = String.raw`(?:${ID}(?:<[^()=]*>)?\??\.)*`;

const RULES: Rule[] = [
  { re: new RegExp(String.raw`${HEAD}enum\s+class\s+(?<name>${ID})`, "u"), kind: "enum", exported: vis },
  { re: new RegExp(String.raw`${HEAD}annotation\s+class\s+(?<name>${ID})`, "u"), kind: "annotation", exported: vis },
  { re: new RegExp(String.raw`${HEAD}class\s+(?<name>${ID})`, "u"), kind: "class", exported: vis },
  // `interface`, `fun interface` (a SAM type), `sealed interface`.
  { re: new RegExp(String.raw`${HEAD}(?:fun\s+)?interface\s+(?<name>${ID})`, "u"), kind: "interface", exported: vis },
  { re: new RegExp(String.raw`${HEAD}object\s+(?<name>${ID})`, "u"), kind: "object", exported: vis },
  { re: new RegExp(String.raw`${HEAD}typealias\s+(?<name>${ID})`, "u"), kind: "type", exported: vis },
  // A function: type parameters, then an extension receiver, before the name
  // (`suspend fun <T> List<T>.firstOrNone()`).
  { re: new RegExp(String.raw`${HEAD}fun\s+(?:<[^>]*(?:>[^>]*)?>\s*)?${RECEIVER}(?<name>${ID})\s*\(`, "u"), kind: "function", exported: vis },
  // A property, at the top level or in a type's body (not a function's local),
  // extension properties included (`val String.lastChar: Char`).
  { re: new RegExp(String.raw`${HEAD}(?:val|var)\s+(?:<[^>]*>\s*)?${RECEIVER}(?<name>${ID})\s*(?:[:=]|by\b)`, "u"), kind: "property", exported: vis, scope: "member" },
];

export const kotlin = {
  lang: "kotlin",
  exts: [".kt", ".kts"],
  lexis: {
    mask: (src: string) => maskBraced(src, { nested: true, triple: true, squote: "char" }),
    comment: /^\s*\/\//,
    block: true,
    decoration: /^\s*@/,
  } satisfies Lexis,
  extract(rel: string, content: string, masked?: string): CodeSymbol[] {
    return scan(rel, content, "kotlin", RULES, masked);
  },
};
