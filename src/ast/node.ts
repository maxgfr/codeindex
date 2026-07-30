// The tree-sitter node surface this engine relies on, plus the small readers
// that turn a node into a name / a callee / a receiver.
//
// Typed STRUCTURALLY rather than by importing web-tree-sitter's own types, so
// none of its declarations leak through the bundle's public .d.mts. Only the
// members we actually use appear here.
export interface TSNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  children: TSNode[];
  // ONE marshal + ONE wasm call for the whole child list, memoized on the node —
  // versus `namedChildCount` plus a `namedChild(i)` round-trip per index. Every
  // traversal reads children through this, never by index.
  namedChildren: TSNode[];
  // Needed to find the doc comment sitting above a declaration, and to climb
  // out of a transparent wrapper (`export …`, a decorator) when looking for it.
  previousNamedSibling: TSNode | null;
  parent: TSNode | null;
}

// True for a leaf node that IS an identifier-ish name (identifier,
// property_identifier, type_identifier, field_identifier, constant, php's
// `name`, or bash's `word` — the leaf inside a command_name). The rightmost
// such leaf of a callee is the called name. End-anchored, so python/ruby
// keyword_* node types (keyword_argument, keyword_pattern, …) never match.
export const IDENT_LEAF = /(^|_)(identifier|name|constant|word)$/;

export function findFirst(node: TSNode, pred: (n: TSNode) => boolean): TSNode | undefined {
  for (const c of node.namedChildren) {
    if (pred(c)) return c;
    const deep = findFirst(c, pred);
    if (deep) return deep;
  }
  return undefined;
}

// The declared name of a node, tried in order of decreasing reliability:
//
//   1. an explicit `name` field — what most grammars expose;
//   2. the declarator chain (C/C++ `function_definition` → declarator →
//      function_declarator → identifier; Java `field_declaration` → declarator →
//      variable_declarator whose own `name` field holds it);
//   3. a `variable_declarator` descendant's `name` (C#, whose field_declaration
//      wraps a variable_declaration one level deeper than the chain reaches);
//   4. the first identifier-like named child.
//
// Step 4 is a genuine last resort and can pick a TYPE name on nodes that lead
// with their type (Java/C# fields) — which is exactly why steps 2 and 3 exist,
// and why a spec can override a specific node type via LangSpec.nameFrom.
export function nameOf(node: TSNode): string | undefined {
  const named = node.childForFieldName("name");
  if (named?.text) return named.text;

  let decl = node.childForFieldName("declarator");
  while (decl) {
    const inner = decl.childForFieldName("name");
    if (inner?.text) return inner.text;
    if (decl.namedChildren.length === 0 && /(^|_)identifier$/.test(decl.type)) return decl.text;
    const next = decl.childForFieldName("declarator");
    if (!next || next === decl) break;
    decl = next;
  }

  const varDecl = findFirst(node, (n) => n.type === "variable_declarator");
  const varName = varDecl?.childForFieldName("name");
  if (varName?.text) return varName.text;

  for (const c of node.namedChildren) {
    if (/(^|_)(identifier|name|constant)$/.test(c.type)) return c.text;
  }
  return undefined;
}

// Read the callee's simple name from a (possibly qualified) callee node: a bare
// identifier returns itself; a member/attribute/selector/scoped access returns its
// final segment via the field name that grammar uses (falling back to the last
// named child). Returns undefined for a computed/complex callee we can't name.
export function readName(node: TSNode | null): string | undefined {
  if (!node) return undefined;
  const kids = node.namedChildren;
  if (kids.length === 0) return IDENT_LEAF.test(node.type) ? node.text : undefined;
  const seg =
    node.childForFieldName("name") ??
    node.childForFieldName("property") ??
    node.childForFieldName("attribute") ??
    node.childForFieldName("field") ??
    // Callee wrappers that point at the real callee via a `function` field:
    // scala's generic_function (`foo[Int](x)`) and a curried/chained
    // call_expression callee (`curried(a)(b)`) — descend to the inner name
    // instead of tripping over type_arguments/arguments as the last child.
    node.childForFieldName("function");
  if (seg) return readName(seg);
  const last = kids[kids.length - 1];
  return last && last !== node ? readName(last) : undefined;
}

// The IMMEDIATE receiver of a qualified call: the rightmost name segment of the
// object the callee is read from (`axios.get(...)` → "axios"; `a.b.c(...)` →
// "b"). Grammars name the object field differently — `object` (JS/TS
// member_expression, python attribute, java method_invocation, php member call),
// go selector_expression's `operand`, rust field_expression's `value` and
// scoped_identifier's `path`, c# member_access_expression's `expression`, c/c++
// field_expression's `argument`, ruby call's `receiver`, lua dot/method_index_
// expression's `table` (scala's field_expression reuses `value`). Undefined for a
// bare callee or a computed/complex receiver (`fetch().then(...)`, `arr[0].map(...)`).
export function readReceiver(node: TSNode | null): string | undefined {
  if (!node || node.namedChildren.length === 0) return undefined;
  const obj =
    node.childForFieldName("object") ??
    node.childForFieldName("operand") ??
    node.childForFieldName("value") ??
    node.childForFieldName("path") ??
    node.childForFieldName("expression") ??
    node.childForFieldName("argument") ??
    node.childForFieldName("receiver") ??
    node.childForFieldName("table");
  const name = obj ? readName(obj) : undefined;
  return name && /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

// A leaf that can NAME a type. Ruby writes one as a `constant`, every other
// grammar here as some `*identifier`. Both branches of readTypeName must agree
// on this set — they disagreed once, and Ruby's `class X < Base` silently
// produced no inheritance at all.
const TYPE_LEAF = /identifier|constant|(^|_)name$/;

// The rightmost segment of a possibly-qualified TYPE reference
// (`fmt::Display` → "Display", `java.util.List` → "List", `Foo<Bar>` → "Foo").
// Used for inheritance targets and for reading a receiver's declared type.
export function readTypeName(node: TSNode | null): string | undefined {
  if (!node) return undefined;
  // A generic application names the CONSTRUCTOR, not its arguments.
  const base = node.childForFieldName("type") ?? node.childForFieldName("name");
  if (base && /generic|qualified|scoped|nested/.test(node.type)) return readTypeName(base);
  if (node.namedChildren.length === 0) return TYPE_LEAF.test(node.type) ? node.text : undefined;
  // Qualified paths: take the LAST identifier-ish leaf.
  let last: string | undefined;
  const visit = (n: TSNode): void => {
    if (n.namedChildren.length === 0) {
      if (TYPE_LEAF.test(n.type)) last = n.text;
      return;
    }
    // Never descend into type ARGUMENTS — `Vec<JobSpec>` is a Vec.
    if (/arguments|parameters/.test(n.type)) return;
    for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return last;
}
