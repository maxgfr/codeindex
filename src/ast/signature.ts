// A declaration's signature: everything from the declaration keyword up to (but
// not including) its body.
//
// WHY NOT THE FIRST LINE. This used to be `src.slice(start, first newline)`,
// which is the whole signature only when the author happened to fit it on one
// line. Every formatter wraps a long parameter list, so the field an agent reads
// in `symbols_overview` / `find_symbol` / `repo_map` degraded to fragments:
//
//     async send(                         ← TypeScript
//     func (s *Scheduler) Dispatch(       ← Go
//     public boolean dispatch(            ← Java
//     @Override                           ← Java, when annotated: pure noise
//
// Cutting at the BODY instead yields the real thing — parameters, defaults and
// return type included — and, because visibility is decided from this same
// text, it also fixes `@Override public void start()` being read as private.
//
// Comments are not signature either: a trailing `# noqa: E501`, a Go
// interface's per-method docs, the doc of a Ruby module's first member used to
// ride along, since a comment is an extra the grammar hangs on whatever node
// encloses it — often the declaration itself, before its body.
import { COMMENT_NODE, IDENT_LEAF, type TSNode } from "./node.js";

// Node types that ARE a declaration body. Cutting the slice here is what keeps a
// class's every member out of its own signature.
const BODY_TYPES = new Set([
  "block",
  "statement_block",
  "class_body",
  "declaration_list",
  "field_declaration_list",
  "template_body",
  "compound_statement",
  "body_statement",
  "enum_body",
  "enum_body_declarations",
  "enum_variant_list",
  "enum_member_declaration_list",
  "enumerator_list",
  "interface_body",
  "object_type",
  "do_block",
  // Zig binds every type to a constant holding a container literal, so the
  // literal IS the body: without these, a struct's signature swallowed every
  // field it declares.
  "struct_declaration",
  "enum_declaration",
  "union_declaration",
  "error_set_declaration",
  "opaque_declaration",
  // Solidity, Kotlin.
  "contract_body",
  "enum_class_body",
]);

// Bodies with no node of their own: the members hang straight off the node that
// declares them, so the body starts at an opening delimiter (or, for a C macro,
// at its replacement text). Each reader returns undefined for "nothing to cut".
const INLINE_BODY = new Map<string, (n: TSNode) => number | undefined>([
  // Go: without this, 14 gin interfaces read "Binding interface { Name() string
  // Bind(*http.Request, any) error }". The methods are indexed as the
  // interface's members; a CONSTRAINT's type set (`interface { ~int | ~float64
  // }`) is indexed nowhere else and is what it declares, so an interface with no
  // method keeps it.
  ["interface_type", (n) => (n.namedChildren.some((c) => c.type === "method_elem") ? openerOf(n) : undefined)],
  // Rust: `macro_rules! m { … }` — the rule set is the body.
  ["macro_definition", (n) => openerOf(n)],
  // C/C++: a function-like macro's replacement text is its body. An object-like
  // `#define MAX 64` keeps its value, which is what it declares.
  ["preproc_function_def", (n) => n.childForFieldName("value")?.startIndex],
]);

function openerOf(n: TSNode): number | undefined {
  for (const c of n.children) if (c.type === "{" || c.type === "(" || c.type === "[") return c.startIndex;
  return undefined;
}

// A function VALUE bound to a name — `const Card = ({ title }) => (…)`, Lua's
// `M.f = function(a) … end`, Java's `Runnable r = () -> { … }`. A block body is
// already a BODY_TYPES node; an EXPRESSION body has no type to key on, so it is
// read from the value's `body` field. Without it a JSX component's signature
// was its markup.
const FUNCTION_VALUES = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
  "function_definition",
  "lambda",
  "lambda_expression",
]);

const MAX_SIGNATURE = 400;

// Past this many source bytes a header is data, not a declaration line: a
// lookup table's initializer, a generated descriptor array. MAX_SIGNATURE
// characters come out of far fewer bytes unless nearly all of them are comments
// and indentation, and stopping here bounds the comment walk, which crosses
// into wasm once per node it visits.
const MAX_HEADER_BYTES = 4096;

// Where this declaration's body starts, or undefined when it has none (an
// interface method, an abstract declaration, a `;`-terminated field).
//
// Searched two levels deep, not just among direct children: Go wraps the body
// one level down (`type_spec` → `struct_type` → `field_declaration_list`), so a
// direct-children-only probe would find nothing and fall back to the node's
// whole text — dumping every struct field into the struct's signature.
function bodyStart(node: TSNode, src: string): number | undefined {
  let best: number | undefined;
  const take = (at: number | undefined): void => {
    if (at !== undefined && at > node.startIndex && (best === undefined || at < best)) best = at;
  };
  const consider = (n: TSNode): void => {
    if (BODY_TYPES.has(n.type)) take(n.startIndex);
    else take(INLINE_BODY.get(n.type)?.(n));
  };
  take(node.childForFieldName("body")?.startIndex);
  consider(node);
  // Children come in source order, so nothing at or past the best cut so far
  // can improve it — which also spares listing a class body's every member.
  for (const c of node.namedChildren) {
    if (best !== undefined && c.startIndex >= best) break;
    consider(c);
    if (FUNCTION_VALUES.has(c.type)) take(c.childForFieldName("body")?.startIndex);
    // One level down, a function is the declaration's value only as the
    // `value` of its declarator (Lua's expression_list too) or the `right` of
    // Python's assignment. Anywhere else it is an argument or a branch —
    // `cond ? () => a : () => b` keeps its text.
    let value: TSNode | null | undefined;
    for (const g of c.namedChildren) {
      if (best !== undefined && g.startIndex >= best) break;
      consider(g);
      if (!FUNCTION_VALUES.has(g.type)) continue;
      if (value === undefined) value = c.childForFieldName("value") ?? c.childForFieldName("right");
      if (value?.startIndex === g.startIndex) take(g.childForFieldName("body")?.startIndex);
    }
  }
  // An EMPTY keyword-delimited body has no node to cut at: Ruby's
  // `class Error < StandardError; end`, `def run(a) end`. The closing `end` —
  // and the `;` before it — is not part of the header.
  if (best === undefined && src.startsWith("end", node.endIndex - 3)) {
    const kids = node.children;
    let i = kids.length - 1;
    if (kids[i]?.type === "end") {
      while (i > 0 && kids[i - 1]!.type === ";") i--;
      take(kids[i]!.startIndex);
    }
  }
  return best;
}

// Every comment in every supported grammar opens with one of these (Ruby's
// `=begin` included), so a header without any has no comment to find — and
// most headers have none, which spares the walk below its wasm round trips
// (~5% of all extraction CPU on tsgo + flask + gin when it always ran).
const COMMENT_OPENER = /\/[/*]|#|--|=begin/;

// The comment nodes inside [from, to), in source order, at any depth.
function commentsWithin(node: TSNode, from: number, to: number): TSNode[] {
  const out: TSNode[] = [];
  const visit = (n: TSNode): void => {
    for (const c of n.namedChildren) {
      if (c.startIndex >= to) return;
      if (c.endIndex <= from) continue;
      if (COMMENT_NODE.test(c.type)) out.push(c);
      else if (!IDENT_LEAF.test(c.type)) visit(c);
    }
  };
  visit(node);
  return out;
}

// Joins the text on either side of a removed comment, with the comment's own
// spaces already gone: one space where the author would write one, none after
// an opener or before a closer or separator — `int a /* first */, int b` is
// `int a, int b`, `f(/* ctx */ a)` is `f(a)`, and `int/*c*/x` stays two words.
const glue = (a: string, b: string): string =>
  a && b && !/[\s([{]$/.test(a) && !/^[\s,;)\]}]/.test(b) ? `${a} ${b}` : a + b;

// The complete declaration header: comments dropped, whitespace collapsed to
// single spaces so a wrapped parameter list reads as one line, a trailing
// body-opener dropped, and capped. Deterministic — a pure function of the
// node's byte range and `src`.
export function declHeader(node: TSNode, src: string): string {
  const start = node.startIndex;
  const end = Math.min(bodyStart(node, src) ?? node.endIndex, start + MAX_HEADER_BYTES);
  // Each comment goes with the spaces around it, but not with a line break:
  // the wrapped-list cleanup below keys on those.
  const raw = src.slice(start, end);
  let text = "";
  let at = start;
  for (const c of COMMENT_OPENER.test(raw) ? commentsWithin(node, start, end) : []) {
    text = glue(text, src.slice(at, Math.max(at, c.startIndex)).replace(/[ \t]+$/, ""));
    at = Math.min(c.endIndex, end);
    while (at < end && (src[at] === " " || src[at] === "\t")) at++;
  }
  text = glue(text, src.slice(at, end));
  return (
    text
      // A line continuation (C macros, shell) is a line break like any other.
      .replace(/\\(\r?\n)/g, "$1")
      // A list the formatter wrapped reads as the author would write it on one
      // line — `f(\n  a,\n  b,\n)` is `f(a, b)`, not `f( a, b, )`. Only where a
      // line break was: an author's own `f( a )` spacing is theirs.
      .replace(/([([])\s*\n\s*/g, "$1")
      .replace(/,(?=\s*\n\s*[)\]}])/g, "")
      .replace(/\s*\n\s*([)\]])/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s*(?:\{|=>|=)$/, "")
      .trim()
      .slice(0, MAX_SIGNATURE)
  );
}
