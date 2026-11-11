// The tree-sitter node surface this engine relies on, plus the small readers
// that turn a node into a name / a callee / a receiver.
//
// Typed STRUCTURALLY rather than by importing web-tree-sitter's own types, so
// none of its declarations leak through the bundle's public .d.mts. Only the
// members we actually use appear here.
import { UNNAMED_RECEIVER } from "../types.js";

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
  // Every child under a field a grammar repeats — the several `declarator`s of
  // `int x, y;`, the several `name`s of Go's `var a, b int`.
  childrenForFieldName(name: string): TSNode[];
  children: TSNode[];
  // ONE marshal + ONE wasm call for the whole child list, memoized on the node —
  // versus `namedChildCount` plus a `namedChild(i)` round-trip per index. Every
  // traversal reads children through this, never by index.
  namedChildren: TSNode[];
  // Needed to find the doc comment sitting above a declaration, and to climb
  // out of a transparent wrapper (`export …`, a decorator) when looking for it.
  previousNamedSibling: TSNode | null;
  parent: TSNode | null;
  // The first child INCLUDING anonymous tokens — the only way to tell `#ifdef`
  // from `#ifndef`, which share one node type and differ only in that keyword.
  firstChild: TSNode | null;
}

// True for a leaf node that IS an identifier-ish name (identifier,
// property_identifier, type_identifier, field_identifier, constant, php's
// `name`, or bash's `word` — the leaf inside a command_name). The rightmost
// such leaf of a callee is the called name. End-anchored, so python/ruby
// keyword_* node types (keyword_argument, keyword_pattern, …) never match.
export const IDENT_LEAF = /(^|_)(identifier|name|constant|word)$/;

// A comment node in any grammar: `comment`, `line_comment`, `block_comment`,
// `doc_comment`. Comments are extras, so a grammar hangs them on whichever node
// encloses them — in a parameter list as readily as between statements.
export const COMMENT_NODE = /(^|_)comment$/;

export function findFirst(node: TSNode, pred: (n: TSNode) => boolean): TSNode | undefined {
  // Pre-order over an explicit stack (children pushed last-first), the order
  // the recursive search had: recursion overflowed on deep nesting.
  const stack = [...node.namedChildren].reverse();
  while (stack.length) {
    const c = stack.pop()!;
    if (pred(c)) return c;
    const kids = c.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return undefined;
}

// The C++ declarator leaves that name a function with something other than an
// identifier, so the chain walk below never recognised them and every operator
// overload and in-class destructor was dropped (or named after its return
// type). Spacing is formatting, not identity: `operator ==` and `operator==` are
// one name, so whitespace goes except the single space a word operator needs
// (`operator new[]`, `operator bool`). A conversion operator's node runs on
// through its parameter list; the name is the part before it.
function cppSpecialName(n: TSNode): string | undefined {
  switch (n.type) {
    case "operator_name":
      return n.text.replace(/\s+/g, "").replace(/^operator(?=\w)/, "operator ");
    case "operator_cast": {
      const head = n.text.split("(")[0]!.replace(/\s+/g, " ").replace(/\s*([*&])\s*/g, "$1").trim();
      return head.length > "operator".length ? head : undefined;
    }
    case "destructor_name":
      return n.text.replace(/\s+/g, "");
  }
  return undefined;
}

// The next link of a C/C++ declarator chain. Two declarators hold it as an
// UNNAMED child rather than a `declarator` field: C++'s `reference_declarator`
// (`const std::string& name()`) and the `parenthesized_declarator` of every C
// function pointer (`void (*run)(job *)`).
const UNNAMED_CHAIN = new Set(["reference_declarator", "parenthesized_declarator"]);
export function nextDeclarator(decl: TSNode): TSNode | null {
  return decl.childForFieldName("declarator") ?? (UNNAMED_CHAIN.has(decl.type) ? (decl.namedChildren[0] ?? null) : null);
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
    if (inner?.text) {
      // C++ nests one qualified_identifier per scope: `Outer::Inner::deep` is
      // Outer :: (Inner :: deep), and the declared name is the innermost
      // segment, not "Inner::deep".
      if (inner.type === "qualified_identifier") {
        decl = inner;
        continue;
      }
      return cppSpecialName(inner) ?? inner.text;
    }
    if (decl.namedChildren.length === 0 && /(^|_)identifier$/.test(decl.type)) return decl.text;
    const special = cppSpecialName(decl);
    if (special) return special;
    // Following only the `declarator` field stopped at the two unnamed links
    // (see nextDeclarator) and sent the reader to its last resort, which named
    // each reference-returning function after its return type ("std::string",
    // "Widget" for `Widget& operator=`) and dropped function-pointer fields.
    const next = nextDeclarator(decl);
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
  // A generic callee names what it applies: C#'s `x.Get<Widget>()` calls Get,
  // Go's `pkg.Fn[Widget](x)` calls Fn — not their last type argument.
  if (node.type === "generic_name") return readName(kids[0]!);
  if (node.type === "generic_type") return readName(node.childForFieldName("type") ?? kids[0]!);
  // Go's `New[T]()`, `Fn[T](a, b)`: a call on an index whose index is a type
  // calls the generic function. Any other index (`handlers[key]()`) calls a
  // value no name here says — not the index, as the last-child rule read it.
  if (isGoInstantiation(node)) return readName(node.childForFieldName("operand"));
  if (node.type === "index_expression" && node.childForFieldName("operand")) return undefined;
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
// scoped_identifier's `path`, c# member_access_expression's `expression` (and
// conditional_access_expression's `condition`), c/c++ field_expression's
// `argument`, ruby call's `receiver`, lua dot/method_index_expression's `table`
// (scala's field_expression reuses `value`). Undefined for a bare callee;
// "this"/"self" for a call on the enclosing instance.
//
// A receiver that IS there but has no name — a literal, a subscript, a
// parenthesised expression (`'a,b'.split(',')`, `items[0].run()`,
// `', '.join(parts)`) — is UNNAMED_RECEIVER, never undefined: without a
// receiver the site read as the bare call `split()`, and bound to a same-file
// function of that name it never calls. See receiverOf for what has a name.
//
// `onCallNode` is for the second read some grammars need, off the call node
// itself (Java's method_invocation and Ruby's call carry the receiver there).
// Only their `object`/`receiver` fields mean a receiver on such a node: a
// shell command's `argument` is its first argument.
//
// `typeCalls` says where the language's convention makes a capitalised call a
// construction (see calledReceiver).
export function readReceiver(node: TSNode | null, onCallNode = false, typeCalls?: TypeCalls): string | undefined {
  if (!node || node.namedChildren.length === 0) return undefined;
  // A generic callee (Rust's `xs.iter().collect::<Vec<_>>()`, Scala's
  // `xs.map[Int](f)`, Go's `pkg.Fn[T](x)`) holds the access under `function`
  // or `type`: its receiver is that access's. Read off the wrapper, the call
  // had none, and bound by name.
  if (node.type === "generic_function") return readReceiver(node.childForFieldName("function"), onCallNode, typeCalls);
  if (node.type === "generic_type") return readReceiver(node.childForFieldName("type"), onCallNode, typeCalls);
  if (isGoInstantiation(node)) return readReceiver(node.childForFieldName("operand"), onCallNode, typeCalls);
  // Solidity wraps every callee in an `expression` node.
  if (node.type === "expression" && node.namedChildren.length === 1) return readReceiver(node.namedChildren[0]!, onCallNode, typeCalls);
  let obj: TSNode | null = null;
  let field = "";
  // Kotlin's navigation_expression and Elixir's dot name no field for their
  // object; PHP's static call names it `scope`.
  if (node.type === "navigation_expression") [obj, field] = [node.namedChildren[0]!, "object"];
  else if (node.type === "dot") [obj, field] = [node.childForFieldName("left"), "object"];
  else if (node.type === "scoped_call_expression") [obj, field] = [node.childForFieldName("scope"), "object"];
  else {
    for (const candidate of RECEIVER_FIELDS) {
      obj = node.childForFieldName(candidate);
      if (obj) {
        field = candidate;
        break;
      }
    }
  }
  if (!obj) return undefined;
  // PHP's `self::`/`static::` are the class's own scope, `parent::` its base.
  if (obj.type === "relative_scope") return obj.text === "parent" ? "super" : "self";
  if (onCallNode && field !== "object" && field !== "receiver") return undefined;
  // `super` and Rust's `crate` are keywords, leaves readName does not take for
  // a name. Rust's `crate::f()`/`super::f()` name a module the binder resolves
  // to a file; JS/TS/Java's `super.f()` the enclosing class's base, which the
  // binder reads off the file's `extends` relations.
  if (obj.type === "super" || (obj.type === "crate" && node.type === "scoped_identifier")) return obj.type;
  // Rust's `self::f()` is a path into the CURRENT module, not a call on the
  // instance: no receiver, the bare call it has always been.
  if (obj.type === "self" && node.type === "scoped_identifier") return undefined;
  return receiverOf(obj, typeCalls);
}

// The fields a grammar keeps a callee's object under, in the order they are
// tried. `condition` is C#'s `x?.Run()`; `package` Go's qualified type, the
// callee of a generic call (`pkg.Fn[T](x)`).
const RECEIVER_FIELDS = ["object", "operand", "value", "path", "expression", "argument", "receiver", "table", "condition", "package"] as const;

// What a receiver node names. A name is taken from an identifier, from the
// last segment of a member access, through a transparent wrapper, and from
// what a construction builds; anything else is UNNAMED_RECEIVER. It used to be
// the other way round — any node's last name unless the node was on a list of
// nameless shapes — and every shape missing from that list read as some
// variable inside it: `cfg` for `new Thing { X = cfg }.Go()`, `idx` for
// `items[idx].run()`, the block parameter for `xs.map { |user| user }.save`.
function receiverOf(start: TSNode, typeCalls: TypeCalls | undefined): string | undefined {
  let obj = start;
  // Transparent: parentheses, a non-null assertion (TS's `a!`, C#'s `a!`,
  // Kotlin's `a!!`), Rust's `a?`, a dereference or an address (`(*p).f()`,
  // `(&x)->f()`, Go's `(&T{}).M()`): a call on what they wrap.
  for (;;) {
    const only = obj.namedChildren.length === 1 ? obj.namedChildren[0]! : undefined;
    if (only && TRANSPARENT.test(obj.type)) obj = only;
    else if (only && obj.type === "postfix_unary_expression" && obj.text.endsWith("!")) obj = only;
    else if (POINTER.test(obj.type) && /^[*&]|!$/.test(obj.text)) {
      const inner = obj.childForFieldName("operand") ?? obj.childForFieldName("argument") ?? obj.childForFieldName("value") ?? only;
      if (!inner) break;
      obj = inner;
    } else break;
  }
  // tree-sitter-typescript reads `x && y!.f()` as `(x && y)!.f()`: the call
  // is on y.
  if (obj.type === "binary_expression" && start.type === "non_null_expression") obj = obj.childForFieldName("right") ?? obj;
  const kids = obj.namedChildren;
  if (kids.length === 0) {
    // The enclosing instance, written as a keyword node rather than as a
    // name: the receiver the regex tier, Python (`self`) and PHP (`$this`)
    // already record. Without it `this.save()` read as the bare `save()` and
    // bound to a same-file FUNCTION of that name instead of the class's own
    // method. C#'s `base.f()` stays a call in the class's own scope.
    if (obj.type === "this") return thisReceiver(obj);
    const self = SELF_NODE.exec(obj.type);
    if (self) return self[1];
    if (/^super(?:_expression)?$/.test(obj.type)) return "super";
    // Elixir's `__MODULE__.f()` is a call on the enclosing module.
    if (obj.text === "__MODULE__") return "self";
    if (BASE_NODE.test(obj.type)) return undefined;
    // Ruby's `@repo`, `@@registry` and `$stdout` are leaves of their own node
    // types; a literal is a leaf with no name.
    if (IDENT_LEAF.test(obj.type) || RUBY_VARIABLE.test(obj.type)) return receiverName(obj.text) ?? UNNAMED_RECEIVER;
    // An Elixir module (`Repo`, `Repo.Sub`): its last segment.
    if (obj.type === "alias") return receiverName(obj.text.slice(obj.text.lastIndexOf(".") + 1)) ?? UNNAMED_RECEIVER;
    return UNNAMED_RECEIVER;
  }
  if (/^super(?:_expression)?$/.test(obj.type)) return "super";
  if (SELF_NODE.test(obj.type)) return SELF_NODE.exec(obj.type)![1];
  // Rust's `<T as Trait>::f()` calls the trait's f; `<T>::f()` T's.
  if (obj.type === "bracketed_type") {
    const inner = kids[0]!;
    return typeReceiver(readTypeName(inner.type === "qualified_type" ? (inner.childForFieldName("alias") ?? inner.childForFieldName("type")) : inner));
  }
  // PHP's `\App\Models\User::find()`: its last segment.
  if (obj.type === "qualified_name") return receiverOf(kids[kids.length - 1]!, typeCalls);
  // C#'s `s?.repo.Save()`: the access the condition leads to.
  if (obj.type === "conditional_access_expression") return receiverOf(kids[kids.length - 1]!, typeCalls);
  // Kotlin's `a.b.save()`: the last segment of the inner access.
  if (obj.type === "navigation_expression") return receiverOf(kids[kids.length - 1]!, typeCalls);
  // A method called on a composite literal (Go's `addrs.Check{…}.Absolute()`)
  // or on a `new` is called on what it builds; the literal's last child is
  // its body, whose last identifier is any field value at all.
  if (obj.type === "composite_literal" || NEW_NODE.test(obj.type)) {
    const type =
      obj.childForFieldName("type") ??
      obj.childForFieldName("constructor") ??
      kids.find((c) => IDENT_LEAF.test(c.type) || /qualified|scoped/.test(c.type)) ??
      null;
    return typeReceiver(readTypeName(type));
  }
  // A generic type or name (Rust's `Vec::<u8>::new()`) names its constructor.
  if (GENERIC.test(obj.type)) return typeReceiver(readTypeName(obj.childForFieldName("type") ?? kids[0]!));
  // A cast names the type the value is read as: `(obj as Repo).save()`, Go's
  // `w.(Flusher).Flush()`, TS's `(<Repo>r).save()`. Only a type that IS a
  // name: an array, a union or an object type names nothing the call is on
  // (`(rows as Row[]).filter()` is no call on a Row).
  if (CAST.test(obj.type)) {
    const type =
      obj.type === "type_assertion" && kids[0]?.type === "type_arguments"
        ? kids[0].namedChildren[0]
        : (obj.childForFieldName("type") ?? obj.childForFieldName("right") ?? kids[kids.length - 1]);
    return castReceiver(type ?? null);
  }
  if (INDEXED.test(obj.type)) return UNNAMED_RECEIVER;
  // A Ruby call with neither arguments nor a block reads an attribute
  // (`user.profile.save`): its method is the receiver's name.
  // `Service.new.call`: a `new` with no arguments is still a construction.
  const rubyRead = obj.type === "call" && obj.childForFieldName("method") !== null && obj.childForFieldName("arguments") === null && obj.childForFieldName("block") === null;
  if (rubyRead && obj.childForFieldName("method")!.text !== "new") return receiverName(readName(obj.childForFieldName("method"))) ?? UNNAMED_RECEIVER;
  if (CALL_NODE.test(obj.type) || obj.childForFieldName("arguments") !== null) return calledReceiver(obj, typeCalls);
  // A member access: the name of its last segment (Zig names it `member`).
  const seg =
    obj.childForFieldName("name") ??
    obj.childForFieldName("property") ??
    obj.childForFieldName("attribute") ??
    obj.childForFieldName("field") ??
    obj.childForFieldName("member");
  if (seg) return receiverOf(seg, typeCalls) ?? UNNAMED_RECEIVER;
  // A wrapper around one name (PHP's `$x` is a variable_name around a name).
  if (kids.length === 1 && NAME_WRAPPER.test(obj.type)) return receiverOf(kids[0]!, typeCalls);
  return UNNAMED_RECEIVER;
}

// Where a capitalised call constructs what it names, by the language's
// convention: as a bare or a qualified name (`qualified`: Python's
// `pathlib.Path(p)`), or only as a bare one (`plain`: Go's `T(x)`, whose
// capitalised METHODS are any exported method, and C++'s `Thing(c)`).
// Elsewhere a construction is written `new` (Java, C#, JS/TS, PHP), and a
// capitalised call is a method: C#'s `BenchmarkSwitcher.FromAssembly(…)
// .Run(args)` is no call on a FromAssembly.
export type TypeCalls = "plain" | "qualified";

// What a call receiver names: the type a construction call builds, where the
// call says it is one. Python's `Parser(t).parse()`, C++'s `Thing(c).go()`,
// Go's `T(x).M()`: a capitalised callee, where typeCalls allows it. Ruby's
// `User.new(1).save` and Rust's `Thing::new(c).go()`: the type `new` is
// called on. Python's `super().f()` is the base, as the bare keyword is
// elsewhere. Any other call — `make(cfg).go()` — returns something no name
// here says.
function calledReceiver(call: TSNode, typeCalls: TypeCalls | undefined): string {
  const callee =
    call.childForFieldName("function") ??
    call.childForFieldName("method") ??
    call.childForFieldName("name") ??
    call.childForFieldName("callee") ??
    call.namedChildren[0] ??
    null;
  if (callee?.text === "super") return "super";
  let bare = callee;
  while (bare && bare.type === "expression" && bare.namedChildren.length === 1) bare = bare.namedChildren[0]!;
  // C++'s `static_cast<Repo*>(p)->save()`: a cast, written as a call.
  if (bare?.type === "template_function" && /^(?:static|dynamic|reinterpret|const)_cast$/.test(bare.childForFieldName("name")?.text ?? "")) {
    return castReceiver(bare.childForFieldName("arguments")?.namedChildren[0] ?? null);
  }
  const name = readName(bare);
  if (name === "new") {
    const owner = readReceiver(callee) ?? readReceiver(call, true);
    return owner !== undefined && TYPE_LIKE.test(owner) ? owner : UNNAMED_RECEIVER;
  }
  if (typeCalls === undefined || (typeCalls === "plain" && bare!.namedChildren.length > 0)) return UNNAMED_RECEIVER;
  return name !== undefined && TYPE_LIKE.test(name) ? name : UNNAMED_RECEIVER;
}

// A type's name as a receiver, or UNNAMED_RECEIVER where it has none we keep.
function typeReceiver(name: string | undefined): string {
  return name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name) ? name : UNNAMED_RECEIVER;
}

// The type a cast names, when it is a name: through a pointer (`*Named`), a
// generic's constructor, a qualified name's last segment.
function castReceiver(type: TSNode | null): string {
  let t = type;
  // C/C++'s `(Repo*)p` holds its type in a type_descriptor.
  if (t?.type === "type_descriptor") t = t.childForFieldName("type");
  while (t && POINTER_TYPE.test(t.type) && t.namedChildren.length === 1) t = t.namedChildren[0]!;
  return t && NAMED_TYPE.test(t.type) ? typeReceiver(readTypeName(t)) : UNNAMED_RECEIVER;
}

// A `this` is the enclosing instance when what binds it is a class or a
// function: the nearest of them, arrow functions passed through. In a JS
// object literal's method it is the literal, and at the top of a module (an
// arrow there included) nothing the file declares: those calls are on
// something unnamed. Java's `this` always sits in a class, enum or interface
// body; other grammars' roots are not a `program`.
function thisReceiver(node: TSNode): string {
  for (let n = node.parent; n; n = n.parent) {
    // A function that is a property of an object literal is its method.
    if (n.type === "function_expression" && n.parent?.type === "pair" && n.parent.parent?.type === "object") return UNNAMED_RECEIVER;
    if (THIS_OWNER.test(n.type)) return "this";
    if (n.type === "method_definition") return n.parent?.type === "class_body" ? "this" : UNNAMED_RECEIVER;
    if (n.type === "program") return UNNAMED_RECEIVER;
  }
  return "this";
}
const THIS_OWNER =
  /^(?:function_declaration|function_expression|function|generator_function|generator_function_declaration|class_body|enum_body|enum_body_declarations|interface_body|annotation_type_body)$/;

// Go's generic instantiation used as a callee: an index_expression (Go's has
// an `operand` field) whose index reads as a type — a type node, a
// capitalised name or one of Go's predeclared types.
function isGoInstantiation(node: TSNode): boolean {
  if (node.type !== "index_expression" || !node.childForFieldName("operand")) return false;
  const index = node.childForFieldName("index");
  if (!index) return false;
  if (/type/.test(index.type)) return true;
  // `New[*T]()`: a pointer to a type.
  const named = index.type === "unary_expression" && index.text.startsWith("*") ? index.childForFieldName("operand") : index;
  return named?.type === "identifier" && (/^[A-Z]/.test(named.text) || GO_PREDECLARED.has(named.text));
}
const GO_PREDECLARED = new Set(
  "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr".split(" "),
);

const RUBY_VARIABLE = /^(?:instance|class|global)_variable$/;
const TRANSPARENT = /^(?:parenthesized_expression|parenthesized_primary_expression|parenthesized_statements|non_null_expression|try_expression|expression)$/;
// A dereference or an address of (Go/Rust unary, C/C++ pointer, Rust
// reference), or Kotlin's `a!!`: transparent when its operator says so.
const POINTER = /^(?:unary_expression|pointer_expression|reference_expression)$/;
const POINTER_TYPE = /^(?:pointer_type|reference_type)$/;
// A type that is a name: a plain, qualified, nested or generic type name.
const NAMED_TYPE =
  /^(?:type_identifier|identifier|generic_type|generic_name|qualified_type|qualified_name|qualified_identifier|nested_type_identifier|scoped_type_identifier|scoped_identifier|user_type|simple_identifier)$/;
const NAME_WRAPPER = /^variable_name$/;
const GENERIC = /^generic_(?:type|name)$/;
// Constructions, across the grammars: `new T(…)` (JS/TS, Java, C#, PHP).
const NEW_NODE = /^(?:new_expression|object_creation_expression|instance_expression)$/;
const CAST = /^(?:as_expression|satisfies_expression|cast_expression|type_assertion|type_assertion_expression)$/;
// An index into something: no name of its own, whatever names it holds.
const INDEXED =
  /^(?:subscript(?:_expression)?|index_expression|indexing_expression|element_access_expression|element_reference|array_access|bracket_index_expression|slice_expression)$/;
// Calls, across the grammars, whether or not they carry an `arguments` field.
const CALL_NODE =
  /^(?:call|call_expression|function_call|function_call_expression|method_invocation|invocation_expression|member_call_expression|scoped_call_expression|nullsafe_member_call_expression|method_call_expression)$/;
// A name that reads as a type's: capitalised.
const TYPE_LIKE = /^[A-Z][\w$]*$/;
// The enclosing instance as a keyword node: `this` (JS/TS, Java, C#, C++),
// `self` (Ruby, Rust).
const SELF_NODE = /^(this|self)(?:_expression)?$/;
const BASE_NODE = /^base(?:_expression)?$/;

// A receiver's name as the index keeps it. `$` is an identifier character
// (JS/TS `$el`, `clicks$`, a Ruby global), and a sigil that marks a member
// rather than naming it is dropped, as the regex tier reads it: `this.#cache`
// → "cache", Ruby's `@repo` / `@@registry` → "repo" / "registry".
//
// These names used to be refused outright, which left the call with NO
// receiver: `$el.render()`, `this.#cache.get(k)` and `@repo.save` were
// recorded as the bare calls `render()`, `get()` and `save()`, and bound to a
// same-file function of that name — a call edge to something never called.
function receiverName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const bare = name.replace(/^(?:#|@{1,2})/, "");
  return /^[A-Za-z_$][\w$]*$/.test(bare) ? bare : undefined;
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
    // Never descend into type ARGUMENTS — `Vec<JobSpec>` is a Vec. C++ and C#
    // spell the list `template_argument_list` / `type_argument_list`, which the
    // plural test missed: `class B : public Base<Foo>` extended "Foo", and an
    // out-of-line `Box<T>::get` belonged to "T".
    if (/arguments|parameters|argument_list/.test(n.type)) return;
    for (const c of n.namedChildren) visit(c);
  };
  visit(node);
  return last;
}
