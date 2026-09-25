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

// Metadata on the declaration's own line: `@override`, `@Deprecated('x')`.
const ANNOT = String.raw`(?:@[\w$.]+(?:\([^)]*\))?\s+)*`;
// A type as written before a declared name: `void`, `int?`, `Future<void>`,
// `Map<String, List<int>>`, `p.Context`. It must not be a statement keyword, or
// `return foo(x);` and `await bar();` read as a function `foo` returning
// `return`. `const`/`final`/`var` are refused too: `return const Text('x')`
// backtracks to exactly that shape, and `factory Point(…)` is a constructor.
const TYPE = String.raw`(?!(?:return|await|throw|new|else|if|for|while|do|switch|yield|case|const|final|var|late|factory|get|set|is|as|in)\b)[\w$.]+(?:<[^;{}()=]*>)?\??`;
// Words that take a parenthesis like a call but never name a declaration.
const NOT_NAME = String.raw`(?!(?:if|for|while|switch|catch|return|assert|super|this|Function)\b)`;
// The parameter list, then a body or a terminator. A list may nest one level of
// parentheses (`void on(void Function() cb) {`) or run past the line end — a
// formatter wraps any long signature (`String absolute(String part1,`), and the
// mandatory return type is what keeps that from matching a wrapped call.
const PARAMS = String.raw`\((?:[^()]|\([^()]*\))*(?:\)\s*(?:async\s*\*?|sync\s*\*)?\s*(?:=>|\{|;)|$)`;

const RULES: Rule[] = [
  {
    re: /^\s*(?:(?:abstract|base|final|sealed|interface|mixin)\s+)*class\s+(?<name>[\w$]+)/,
    kind: "class",
    exported: vis,
  },
  { re: /^\s*(?:base\s+)?mixin\s+(?<name>[\w$]+)/, kind: "mixin", exported: vis },
  // `extension on String {}` has no name; `extension type Id(int _)` (Dart 3)
  // declares a type named Id, not one named "type".
  { re: /^\s*extension\s+(?:type\s+(?:const\s+)?)?(?!on\b)(?<name>[\w$]+)/, kind: "extension", exported: vis },
  { re: /^\s*enum\s+(?<name>[\w$]+)/, kind: "enum", exported: vis },
  { re: /^\s*typedef\s+(?<name>[\w$]+)/, kind: "type", exported: vis },
  // Accessors come before functions: `set x(int v)` would otherwise read as a
  // function `x` whose return type is `set`.
  {
    re: new RegExp(String.raw`^\s*${ANNOT}(?:(?:static|external)\s+)*(?:${TYPE}\s+)?get\s+(?<name>[\w$]+)\s*(?:=>|\{|;|async\b|sync\b)`),
    kind: "getter",
    exported: vis,
  },
  {
    re: new RegExp(String.raw`^\s*${ANNOT}(?:(?:static|external)\s+)*(?:void\s+)?set\s+(?<name>[\w$]+)\s*\(`),
    kind: "setter",
    exported: vis,
  },
  // A function or method needs its return type. Without one, every call
  // statement (`print(x);`, `setState(() {`) and every `if (…) {` was a
  // declaration, and a Dart package indexed more call sites than functions.
  {
    re: new RegExp(String.raw`^\s*${ANNOT}(?:(?:static|external)\s+)*${TYPE}\s+${NOT_NAME}(?<name>[\w$]+)\s*(?:<[^()]*>)?\s*${PARAMS}`),
    kind: "function",
    exported: vis,
  },
  // Column 0 is the top level, where Dart allows declarations only, so a
  // type-less `main() {` there can be nothing else (a dynamic return type).
  {
    re: new RegExp(String.raw`^${NOT_NAME}(?<name>[\w$]+)\s*(?:<[^()]*>)?\s*${PARAMS}`),
    kind: "function",
    exported: vis,
  },
  // A top-level binding. Column 0 again: indented, the same line is a local.
  // A `const` or `final` one is a constant (what the literal analysis counts
  // as a value's holder); a `var` or `late` one is not.
  {
    re: new RegExp(String.raw`^(?:const|final)\s+(?:${TYPE}\s+)?(?<name>[\w$]+)\s*[=;]`),
    kind: "const",
    exported: vis,
  },
  {
    re: new RegExp(String.raw`^(?:late\s+final|late|var)\s+(?:${TYPE}\s+)?(?<name>[\w$]+)\s*[=;]`),
    kind: "var",
    exported: vis,
  },
];

// The declarations a constructor can belong to. Dart does not nest them, so the
// most recent one is the enclosing type of every line until its body closes,
// which `dart format` always does with a `}` in column 0.
const TYPE_DECL =
  /^(?<indent>\s*)(?:(?:abstract|base|final|sealed|interface|mixin)\s+)*(?:class|enum|mixin|extension(?:\s+type(?:\s+const)?)?)\s+(?<name>[\w$]+)/;
// `Point(this.x);`, `const Point.origin()`, `factory Point.fromJson(…)`,
// `Point._();`. The shape is a call statement's, so it counts only when the
// name before the dot is the enclosing type's own, at the indentation of the
// type's members: one level deeper, `Point.helper(1);` is a statement in a
// method body.
const CTOR = new RegExp(
  String.raw`^(?<indent>\s*)${ANNOT}(?:(?:const|factory|external)\s+)*(?<type>[\w$]+)(?:\.(?<name>[\w$]+))?\s*\(`,
);

function constructors(rel: string, content: string, taken: Set<number>): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = content.split(/\r?\n/);
  let owner: string | undefined;
  let ownerIndent = 0;
  // Indentation of the owner's members: that of the first line of its body.
  let memberIndent: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const decl = TYPE_DECL.exec(line);
    if (decl) {
      owner = decl.groups!.name!;
      ownerIndent = decl.groups!.indent!.length;
      memberIndent = undefined;
      continue;
    }
    if (line.startsWith("}")) owner = undefined;
    if (!owner || !line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (memberIndent === undefined) memberIndent = indent > ownerIndent ? indent : -1;
    if (indent !== memberIndent || taken.has(i + 1)) continue;
    const m = CTOR.exec(line);
    if (!m || m.groups!.type !== owner) continue;
    // A named constructor is called as `Point.origin()`: the call site records
    // `origin`, so that is the name a caller lookup needs.
    const name = m.groups!.name ?? owner;
    out.push({
      name,
      kind: "constructor",
      file: rel,
      line: i + 1,
      signature: line.trim().slice(0, 200),
      exported: !name.startsWith("_") && !owner.startsWith("_"),
      lang: "dart",
    });
  }
  return out;
}

export const dart = {
  lang: "dart",
  exts: [".dart"],
  extract(rel: string, content: string): CodeSymbol[] {
    const symbols = scan(rel, content, "dart", RULES);
    const ctors = constructors(rel, content, new Set(symbols.map((s) => s.line)));
    if (!ctors.length) return symbols;
    // Merged back into line order, the order `scan` emits and every consumer
    // of a regex-tier file sees.
    return [...symbols, ...ctors].sort((a, b) => a.line - b.line);
  },
};
