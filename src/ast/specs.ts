// How each grammar's declarations map onto symbols — the data half of AST
// extraction, split out of extract.ts so the walk that consumes it stays
// readable and so adding a language is an edit to a table, not to an algorithm.
//
// `defs` maps a node type to a symbol kind; `containers` are nodes whose
// children we keep walking (bodies, declaration groups, `export …` wrappers);
// `exported` decides visibility from the declaration's HEADER (its full
// signature — see ast/signature.ts) and its name.
//
// Everything after `assignments` is an escape hatch for a grammar shape the two
// tables cannot express. Each one exists because a real language needs it, and
// each is documented with which.
import type { RawRelation } from "../types.js";
import type { TSNode } from "./node.js";
import { findFirst, readTypeName } from "./node.js";

/** Type names an inheritance clause lists, skipping type-argument noise. */
function heritageTargets(clause: TSNode | null | undefined): string[] {
  if (!clause) return [];
  const out: string[] = [];
  for (const c of clause.namedChildren) {
    // `class A extends B<C>` inherits from B, not from C.
    if (/arguments|parameters/.test(c.type)) continue;
    const n = readTypeName(c);
    if (n) out.push(n);
  }
  return out;
}

const childOfType = (node: TSNode, type: string): TSNode | undefined => node.namedChildren.find((c) => c.type === type);

const rel = (kind: RawRelation["kind"], from: string, to: string, node: TSNode): RawRelation => ({
  kind,
  from,
  to,
  line: node.startPosition.row + 1,
});

// JS/TS state both relations inside one `class_heritage` node.
function tsHeritage(node: TSNode, ctx: { self?: string }): RawRelation[] {
  if (!ctx.self) return [];
  const heritage = childOfType(node, "class_heritage");
  if (!heritage) return [];
  const out: RawRelation[] = [];
  for (const to of heritageTargets(childOfType(heritage, "extends_clause"))) out.push(rel("extends", ctx.self, to, node));
  for (const to of heritageTargets(childOfType(heritage, "implements_clause"))) out.push(rel("implements", ctx.self, to, node));
  return out;
}

// A base list the syntax does not split into "class" and "interfaces" (C#).
// C# requires the base CLASS first when there is one, so the first entry is
// `extends` and the rest are `implements`; graph resolution then corrects a
// first entry that turns out to name an interface (see relations.ts).
function firstIsBase(clause: TSNode | undefined, self: string, node: TSNode): RawRelation[] {
  const targets = heritageTargets(clause);
  return targets.map((to, i) => rel(i === 0 ? "extends" : "implements", self, to, node));
}

export interface LangSpec {
  lang: string;
  defs: Record<string, string>;
  containers: Set<string>;
  exported: (header: string, name: string) => boolean;
  imports?: Record<string, "string" | "path">; // node type → how to read the specifier
  // Call-expression node type → how to read the callee name. "function": read the
  // callee/function field, descending to the rightmost segment of a member/
  // attribute/selector/scoped callee. "member": a dedicated member-call node —
  // read its `name` field. "constructor": a new/object-creation node — read the
  // constructed type identifier.
  calls?: Record<string, "function" | "member" | "constructor">;
  // Also surface top-level ASSIGNMENTS of function/class expressions —
  // `res.sendStatus = function sendStatus() {}`, `Foo.prototype.bar = () => {}`,
  // `exports.helper = function () {}` — the CommonJS definition style that
  // declaration-node walks miss entirely (express, connect, older Node code).
  // Two grammar shapes are handled: JS/TS expression_statement>assignment_
  // expression and lua assignment_statement (variable_list = expression_list).
  assignments?: boolean;

  /**
   * Node types that mark everything they wrap as exported. JS/TS `export …`, and
   * `declare …` in a `.d.ts` — an ambient declaration IS the module's public
   * surface, and without this every `.d.ts` in a repo indexed to nothing at all.
   */
  exportMarkers?: Set<string>;

  /**
   * Per-node-type name reader, for shapes the generic `nameOf` gets wrong.
   * Returning undefined SKIPS the node — which is how Go's embedded struct
   * fields (`struct { Scheduler }`, a field_declaration with a type and no name)
   * stay out of the symbol table and become an `extends` relation instead.
   */
  nameFrom?: Record<string, (node: TSNode) => string | undefined>;

  /**
   * Per-node-type kind chooser, for one node type that is two declarations.
   * C++ spells a method declaration and a data member both `field_declaration`,
   * and a namespace-scope constant and a free function both `declaration`;
   * only the presence of a function_declarator tells them apart.
   */
  kindFrom?: Record<string, (node: TSNode) => string | undefined>;

  /**
   * Container node types that QUALIFY their members with a type name. Rust's
   * `impl Scheduler { … }` is not itself a declaration, so without this its
   * methods surfaced as unparented top-level `new`/`dispatch`/`fmt` symbols —
   * colliding with every same-named method in the repo.
   */
  parentFrom?: Record<string, (node: TSNode) => string | undefined>;

  /**
   * Container node types whose members are public regardless of the visibility
   * heuristic: `impl Trait for Type` members are part of the trait's public
   * contract even without `pub`.
   */
  publicMembersIn?: Record<string, (node: TSNode) => boolean>;

  /** Read a symbol's doc from the first string INSIDE its body (Python docstrings). */
  docstring?: boolean;

  /**
   * Read a symbol's doc from somewhere neither a preceding comment nor a
   * docstring: Elixir documents with an `@doc "…"` module ATTRIBUTE, which is a
   * sibling expression, not a comment. Tried before the generic paths.
   */
  docFrom?: (node: TSNode) => string | undefined;

  /**
   * Honour section markers that flip visibility for the members that follow —
   * C++ `private:` / `public:` (an `access_specifier` node) and Ruby's bare
   * `private` (an identifier at body scope). Members default to public; C++
   * headers are the interface, and a `class`-vs-`struct` default would make the
   * common `class X { public: … }` case pay for the uncommon one.
   */
  sectionVisibility?: (node: TSNode) => boolean | undefined;

  /** Force non-exported even inside an `export`ed declaration (TS `private`/`protected` members). */
  privateMember?: (node: TSNode) => boolean;

  /**
   * Force exported for a declaration whose visibility keyword is never written
   * because the language implies it. A Java or C# RECORD component is a public
   * accessor spelled `String name`, so the `public`-keyword heuristic reads it as
   * private — the same problem PUBLIC_MEMBER_KINDS solves for interface members,
   * but decided per NODE rather than by the owner's kind, since a record's other
   * members really can be private.
   */
  publicMember?: (node: TSNode) => boolean;

  /**
   * A mapped call node that is NOT a call site. Elixir needs this because its
   * declarations are macro calls: the inner `start(queue)` of `def start(queue)`
   * is the signature, and a module attribute (`@max_attempts 5`) is a call too.
   * Structural rather than a (name, line) match, so a genuine same-line
   * recursion still registers.
   */
  skipCall?: (node: TSNode) => boolean;

  /** Emit a bare identifier child of these containers as this kind (TS `enum { A, B }`). */
  bareMembers?: Record<string, string>;

  /**
   * The last resort: extra symbols a container child declares that no table
   * above can describe. Used by Python (module/class-scope assignments are the
   * only way constants and dataclass fields exist) and Ruby (`MAX = 5`,
   * `attr_reader :queue`).
   */
  extraMembers?: (node: TSNode, ctx: { ownerKind?: string; inFunctionBody: boolean }) => { name: string; kind: string }[];

  /**
   * Inheritance the declaration states: `extends` / `implements` targets, keyed
   * by node type. `ctx.self` is the declaring symbol — the declaration's own name
   * for a class/interface, the impl target for Rust, the enclosing class for a
   * Ruby `include`.
   *
   * The graph had no way to express "B is a kind of A", so "who implements this
   * interface" and "what overrides this method" were unanswerable from the index.
   */
  relationsFrom?: Record<string, (node: TSNode, ctx: { self?: string }) => RawRelation[]>;
}

/**
 * Kinds whose MEMBERS are public in every language here: an interface method, a
 * trait method and an enum constant are reachable by anyone who can name the
 * type, whatever modifier keyword the declaration lacks. Without this, Java and
 * C# interface members and Java enum constants all read as private, because the
 * `public` keyword they inherit is never written.
 */
export const PUBLIC_MEMBER_KINDS = new Set(["interface", "trait", "enum", "protocol"]);

/** Kinds whose body is executable code, so members found inside are locals, not API. */
export const FUNCTION_KINDS = new Set(["function", "method", "def", "constructor", "operator"]);

/** Node types that are a function/class VALUE — a declarator holding one is a definition. */
export const FUNCTION_VALUE_TYPES = new Set([
  "function",
  "function_expression",
  "arrow_function",
  "generator_function",
  "class",
  "function_definition",
  "lambda",
]);

const byPublicKeyword = (line: string): boolean => /\b(public|internal)\b/.test(line);
// Scala is public by default; `private`/`protected` modifiers sit on the
// declaration's header (same stance as the regex tier).
const byNotPrivate = (line: string): boolean => !/\b(private|protected)\b/.test(line);
// Lua: `local function f` is file-local by construction. Assignment-style
// `local f = function()` stays exported — regex-tier parity (its rule marks
// those exported), and the `local` keyword lives on the wrapping
// variable_declaration, outside the assignment node this line is read from.
const byNotLocal = (line: string): boolean => !/^local\b/.test(line);
const byPub = (line: string): boolean => /\bpub\b/.test(line);
const byCapital = (_l: string, name: string): boolean => /^[A-Z]/.test(name);
const byPyConvention = (_l: string, name: string): boolean => !name.startsWith("_") || /^__\w+__$/.test(name);
const always = (): boolean => true;
// JS/TS export is structural (an `export` statement wraps the declaration); a
// bare declaration is module-private, so the name/header heuristic never marks it.
const neverExport = (): boolean => false;

const hasFunctionDeclarator = (node: TSNode): boolean =>
  findFirst(node, (n) => n.type === "function_declarator") !== undefined;

// Elixir's declaring macros, by callee name. Anything not here is an ordinary
// call, not a declaration.
const ELIXIR_DEFS: Record<string, string> = {
  defmodule: "module",
  defprotocol: "protocol",
  defimpl: "impl",
  defstruct: "struct",
  defexception: "exception",
  def: "function",
  defp: "function",
  defmacro: "macro",
  defmacrop: "macro",
  defguard: "guard",
  defguardp: "guard",
  defdelegate: "function",
};

// HCL/Terraform declares everything as a labelled block. Only these top-level
// block types name something a reader looks up; `lifecycle`, `ingress` and the
// rest are nested configuration, and treating them as symbols would bury the
// real ones.
const HCL_BLOCKS = new Set(["resource", "data", "variable", "output", "module", "provider", "locals", "terraform"]);

const TERRAFORM_SPEC: LangSpec = {
  lang: "terraform",
  defs: { block: "block" },
  containers: new Set(["config_file", "body"]),
  exported: always,
  kindFrom: {
    block: (node) => {
      const type = node.namedChildren.find((c) => c.type === "identifier")?.text;
      return type && HCL_BLOCKS.has(type) ? type : undefined;
    },
  },
  nameFrom: {
    // A block's identity is its labels: `resource "aws_instance" "web"` is
    // addressed as aws_instance.web, which is exactly how Terraform names it.
    block: (node) => {
      const labels = node.namedChildren
        .filter((c) => c.type === "string_lit")
        .map((c) => c.text.replace(/^"|"$/g, ""));
      if (labels.length) return labels.join(".");
      return node.namedChildren.find((c) => c.type === "identifier")?.text;
    },
  },
};

// TypeScript is the base for tsx and javascript, so it is a named const rather
// than indexed back out of SPECS (which noUncheckedIndexedAccess would widen to
// `LangSpec | undefined`, breaking the derived spreads below).
const TS_SPEC: LangSpec = {
  lang: "typescript",
  defs: {
    function_declaration: "function",
    generator_function_declaration: "function",
    // `declare function f(): void` and an overload signature — the ENTIRE
    // content of a typical `.d.ts`, previously indexed as nothing.
    function_signature: "function",
    class_declaration: "class",
    abstract_class_declaration: "class",
    interface_declaration: "interface",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    enum_assignment: "enum-member",
    method_definition: "method",
    method_signature: "method",
    abstract_method_signature: "method",
    // Interface members and class fields — the shape of the data, and the half
    // of a TypeScript API that an index of declarations alone never showed.
    property_signature: "property",
    public_field_definition: "property",
    // `namespace X {}` / `module X {}`
    internal_module: "namespace",
    module: "namespace",
    variable_declarator: "const",
  },
  containers: new Set([
    "class_body",
    "export_statement",
    "ambient_declaration",
    "program",
    "lexical_declaration",
    "variable_declaration",
    // Interface/enum bodies, and function bodies (for nested declarations —
    // route handlers, hooks, helper closures).
    "interface_body",
    "object_type",
    "enum_body",
    "statement_block",
  ]),
  exported: neverExport, // export is tracked structurally; see LangSpec.exportMarkers
  exportMarkers: new Set(["export_statement", "ambient_declaration"]),
  bareMembers: { enum_body: "enum-member" },
  privateMember: (node) => {
    for (const c of node.namedChildren) {
      if (c.type === "accessibility_modifier" && /^(private|protected)/.test(c.text)) return true;
      // `#field` — private by syntax, with no modifier keyword.
      if (c.type === "private_property_identifier") return true;
    }
    return false;
  },
  imports: { import_statement: "string" },
  calls: { call_expression: "function", new_expression: "constructor" },
  assignments: true,
  relationsFrom: {
    class_declaration: tsHeritage,
    abstract_class_declaration: tsHeritage,
    interface_declaration: (node, ctx) =>
      ctx.self
        ? heritageTargets(childOfType(node, "extends_type_clause")).map((to) => rel("extends", ctx.self!, to, node))
        : [],
  },
};

export const SPECS: Record<string, LangSpec> = {
  typescript: TS_SPEC,
  tsx: { ...TS_SPEC, lang: "typescript" },
  javascript: {
    ...TS_SPEC,
    lang: "javascript",
    defs: {
      function_declaration: "function",
      generator_function_declaration: "function",
      class_declaration: "class",
      method_definition: "method",
      field_definition: "property",
      variable_declarator: "const",
    },
  },
  python: {
    lang: "python",
    defs: { function_definition: "function", class_definition: "class" },
    containers: new Set(["block", "decorated_definition", "module"]),
    exported: byPyConvention,
    imports: { import_statement: "path", import_from_statement: "path" },
    calls: { call: "function" },
    docstring: true,
    // Python has no interfaces, so every base is an `extends`; graph resolution
    // reclassifies one that turns out to name a Protocol.
    relationsFrom: {
      class_definition: (node, ctx) =>
        ctx.self
          ? heritageTargets(node.childForFieldName("superclasses")).map((to) => rel("extends", ctx.self!, to, node))
          : [],
    },
    // Python declares constants and dataclass fields by ASSIGNING them; there is
    // no declaration node to map. `X = 1` at module scope is a constant, the same
    // shape inside a class body is a field, and inside a function it is a local
    // (excluded via ctx.inFunctionBody).
    extraMembers: (node, ctx) => {
      if (ctx.inFunctionBody || node.type !== "expression_statement") return [];
      const assign = node.namedChildren[0];
      if (!assign || assign.type !== "assignment") return [];
      const left = assign.childForFieldName("left");
      if (!left || left.type !== "identifier") return [];
      return [{ name: left.text, kind: ctx.ownerKind === "class" ? "field" : "const" }];
    },
  },
  go: {
    lang: "go",
    defs: {
      function_declaration: "function",
      method_declaration: "method",
      type_spec: "type",
      const_spec: "const",
      var_spec: "var",
      field_declaration: "field",
      // Interface method sets: `method_spec` through grammar 0.22, renamed
      // `method_elem` in 0.23 — both listed so a grammar bump cannot silently
      // drop every interface method from the index.
      method_spec: "method",
      method_elem: "method",
    },
    containers: new Set([
      "type_declaration",
      "const_declaration",
      "var_declaration",
      "source_file",
      // A struct/interface body hangs one level below its type_spec.
      "struct_type",
      "interface_type",
      "field_declaration_list",
    ]),
    exported: byCapital,
    imports: { import_declaration: "string" },
    calls: { call_expression: "function" },
    // A method's receiver is what it belongs to: `func (s *Scheduler) Start()`
    // is Scheduler.Start, not a free function named Start.
    parentFrom: {
      method_declaration: (node) => readTypeName(node.childForFieldName("receiver")),
    },
    nameFrom: {
      // An EMBEDDED field (`struct { Scheduler }`) has a type and no name. The
      // generic reader would return the type as the field name; returning
      // undefined skips it, and the relation below records the embedding instead.
      field_declaration: (node) => node.childForFieldName("name")?.text,
    },
    relationsFrom: {
      // Embedding IS Go's inheritance: `type Audited struct { Scheduler }`
      // promotes every Scheduler method onto Audited.
      field_declaration: (node, ctx) => {
        if (!ctx.self || node.childForFieldName("name")) return [];
        const to = readTypeName(node.childForFieldName("type"));
        return to ? [rel("extends", ctx.self, to, node)] : [];
      },
    },
  },
  ruby: {
    lang: "ruby",
    defs: { method: "def", singleton_method: "def", class: "class", module: "module" },
    containers: new Set(["class", "module", "body_statement", "program"]),
    exported: always,
    // Ruby models every invocation — dotted, parenthesized, or bare command form
    // (`puts "x"`) — as a `call` node whose callee is the `method` field.
    calls: { call: "function" },
    // A bare `private` switches every following definition in the body to
    // private. It is a method call, not a keyword, so nothing but position says so.
    sectionVisibility: (node) =>
      (node.type === "identifier" || node.type === "call") && /^(private|protected)$/.test(node.text)
        ? false
        : node.type === "identifier" && node.text === "public"
          ? true
          : undefined,
    relationsFrom: {
      class: (node, ctx) => {
        if (!ctx.self) return [];
        const to = readTypeName(node.childForFieldName("superclass"));
        return to ? [rel("extends", ctx.self, to, node)] : [];
      },
      // `include Runnable` mixes a module in — Ruby's only `implements`. It is a
      // method call, so nothing but the callee name identifies it.
      call: (node, ctx) => {
        const method = node.childForFieldName("method");
        if (!ctx.self || !method || !/^(include|prepend|extend)$/.test(method.text)) return [];
        const out: RawRelation[] = [];
        for (const a of node.childForFieldName("arguments")?.namedChildren ?? []) {
          const to = readTypeName(a);
          if (to) out.push(rel("implements", ctx.self, to, node));
        }
        return out;
      },
    },
    extraMembers: (node, ctx) => {
      if (ctx.inFunctionBody) return [];
      // `MAX_ATTEMPTS = 5` — a constant is an assignment to a `constant` node.
      if (node.type === "assignment") {
        const left = node.childForFieldName("left");
        return left?.type === "constant" ? [{ name: left.text, kind: "const" }] : [];
      }
      // `attr_reader :queue` declares real accessor methods; nothing else in the
      // file mentions `queue`, so without this the attribute does not exist.
      if (node.type === "call") {
        const method = node.childForFieldName("method");
        if (!method || !/^attr_(reader|writer|accessor)$/.test(method.text)) return [];
        const args = node.childForFieldName("arguments");
        const out: { name: string; kind: string }[] = [];
        for (const a of args?.namedChildren ?? []) {
          if (a.type === "simple_symbol") out.push({ name: a.text.replace(/^:/, ""), kind: "attr" });
        }
        return out;
      }
      return [];
    },
  },
  java: {
    lang: "java",
    defs: {
      class_declaration: "class",
      interface_declaration: "interface",
      annotation_type_declaration: "annotation",
      enum_declaration: "enum",
      enum_constant: "enum-member",
      record_declaration: "record",
      method_declaration: "method",
      constructor_declaration: "constructor",
      field_declaration: "field",
    },
    containers: new Set([
      "class_body",
      "interface_body",
      "enum_body",
      "enum_body_declarations",
      "annotation_type_body",
      "program",
      // A record's components ARE its public accessors.
      "formal_parameters",
    ]),
    exported: byPublicKeyword,
    imports: { import_declaration: "path" },
    calls: { method_invocation: "function", object_creation_expression: "constructor" },
    kindFrom: {
      // A RECORD's components are its public accessors and belong in the index; a
      // method's or constructor's parameters are arguments and do not. Both are
      // `formal_parameter` under `formal_parameters`, so only the grandparent
      // distinguishes them.
      formal_parameter: (node) => (node.parent?.parent?.type === "record_declaration" ? "field" : undefined),
    },
    publicMember: (node) => node.parent?.parent?.type === "record_declaration",

    nameFrom: {
      // `private final List<JobSpec> pending = …` — the generic reader's last
      // resort would return the TYPE (`List`); the name is on the declarator.
      field_declaration: (node) => findFirst(node, (n) => n.type === "variable_declarator")?.childForFieldName("name")?.text,
    },
    relationsFrom: {
      class_declaration: (node, ctx) => {
        if (!ctx.self) return [];
        const out: RawRelation[] = [];
        for (const to of heritageTargets(node.childForFieldName("superclass"))) out.push(rel("extends", ctx.self, to, node));
        const interfaces = node.childForFieldName("interfaces");
        for (const to of heritageTargets(childOfType(interfaces ?? node, "type_list") ?? interfaces))
          out.push(rel("implements", ctx.self, to, node));
        return out;
      },
      interface_declaration: (node, ctx) => {
        const extendsClause = node.childForFieldName("interfaces") ?? childOfType(node, "extends_interfaces");
        return ctx.self
          ? heritageTargets(childOfType(extendsClause ?? node, "type_list") ?? extendsClause).map((to) =>
              rel("extends", ctx.self!, to, node),
            )
          : [];
      },
      record_declaration: (node, ctx) => {
        const interfaces = node.childForFieldName("interfaces");
        return ctx.self
          ? heritageTargets(childOfType(interfaces ?? node, "type_list") ?? interfaces).map((to) =>
              rel("implements", ctx.self!, to, node),
            )
          : [];
      },
    },
  },
  rust: {
    lang: "rust",
    defs: {
      function_item: "function",
      // A trait's method declarations have no body and are a different node.
      function_signature_item: "function",
      struct_item: "struct",
      enum_item: "enum",
      enum_variant: "enum-member",
      field_declaration: "field",
      trait_item: "trait",
      type_item: "type",
      associated_type: "type",
      mod_item: "mod",
      const_item: "const",
      static_item: "static",
      union_item: "union",
      macro_definition: "macro",
    },
    containers: new Set(["impl_item", "declaration_list", "source_file", "field_declaration_list", "enum_variant_list"]),
    exported: byPub,
    calls: { call_expression: "function" },
    parentFrom: {
      // `impl Scheduler` / `impl Display for Scheduler` — the members belong to
      // the TYPE in both forms (the trait is recorded as a relation, not a parent).
      impl_item: (node) => readTypeName(node.childForFieldName("type")),
    },
    publicMembersIn: {
      // A trait implementation's methods are callable by anyone holding the
      // trait, so `pub` is neither required nor allowed on them.
      impl_item: (node) => node.childForFieldName("trait") !== null,
    },
    relationsFrom: {
      impl_item: (node, ctx) => {
        const to = readTypeName(node.childForFieldName("trait"));
        return ctx.self && to ? [rel("implements", ctx.self, to, node)] : [];
      },
    },
  },
  c_sharp: {
    lang: "csharp",
    defs: {
      class_declaration: "class",
      interface_declaration: "interface",
      struct_declaration: "struct",
      enum_declaration: "enum",
      enum_member_declaration: "enum-member",
      record_declaration: "record",
      delegate_declaration: "delegate",
      method_declaration: "method",
      constructor_declaration: "constructor",
      property_declaration: "property",
      indexer_declaration: "indexer",
      operator_declaration: "operator",
      field_declaration: "field",
      event_declaration: "event",
      event_field_declaration: "event",
    },
    containers: new Set([
      "namespace_declaration",
      "declaration_list",
      "compilation_unit",
      "file_scoped_namespace_declaration",
      "enum_member_declaration_list",
      // A positional record's parameters ARE its public properties.
      "parameter_list",
    ]),
    exported: byPublicKeyword,
    calls: { invocation_expression: "function", object_creation_expression: "constructor" },
    kindFrom: {
      // Same rule as Java: a positional RECORD's parameters are its properties,
      // while a delegate's or a method's are arguments.
      parameter: (node) => (node.parent?.parent?.type === "record_declaration" ? "field" : undefined),
    },
    publicMember: (node) => node.parent?.parent?.type === "record_declaration",

    nameFrom: {
      // C# wraps a field's declarator one level deeper than Java's, inside a
      // `variable_declaration` — same problem, same fix.
      field_declaration: (node) => findFirst(node, (n) => n.type === "variable_declarator")?.childForFieldName("name")?.text,
      event_field_declaration: (node) =>
        findFirst(node, (n) => n.type === "variable_declarator")?.childForFieldName("name")?.text,
    },
    relationsFrom: {
      class_declaration: (node, ctx) => (ctx.self ? firstIsBase(childOfType(node, "base_list"), ctx.self, node) : []),
      struct_declaration: (node, ctx) => (ctx.self ? firstIsBase(childOfType(node, "base_list"), ctx.self, node) : []),
      record_declaration: (node, ctx) => (ctx.self ? firstIsBase(childOfType(node, "base_list"), ctx.self, node) : []),
      interface_declaration: (node, ctx) =>
        ctx.self
          ? heritageTargets(childOfType(node, "base_list")).map((to) => rel("extends", ctx.self!, to, node))
          : [],
    },
  },
  php: {
    lang: "php",
    defs: {
      function_definition: "function",
      class_declaration: "class",
      interface_declaration: "interface",
      trait_declaration: "trait",
      enum_declaration: "enum",
      enum_case: "enum-member",
      method_declaration: "method",
      property_declaration: "property",
      const_declaration: "const",
    },
    containers: new Set(["declaration_list", "enum_declaration_list", "program"]),
    // PHP has real visibility keywords, so `always` was throwing away a fact the
    // source states outright — a `private function` read as part of the API.
    exported: byNotPrivate,
    calls: {
      function_call_expression: "function",
      member_call_expression: "member",
      object_creation_expression: "constructor",
    },
    nameFrom: {
      property_declaration: (node) => findFirst(node, (n) => n.type === "variable_name")?.text.replace(/^\$/, ""),
      const_declaration: (node) => findFirst(node, (n) => n.type === "const_element")?.namedChildren[0]?.text,
    },
    relationsFrom: {
      class_declaration: (node, ctx) => {
        if (!ctx.self) return [];
        const out: RawRelation[] = [];
        for (const to of heritageTargets(childOfType(node, "base_clause"))) out.push(rel("extends", ctx.self, to, node));
        for (const to of heritageTargets(childOfType(node, "class_interface_clause")))
          out.push(rel("implements", ctx.self, to, node));
        return out;
      },
      interface_declaration: (node, ctx) =>
        ctx.self ? heritageTargets(childOfType(node, "base_clause")).map((to) => rel("extends", ctx.self!, to, node)) : [],
    },
  },
  c: {
    lang: "c",
    defs: {
      function_definition: "function",
      struct_specifier: "struct",
      enum_specifier: "enum",
      enumerator: "enum-member",
      union_specifier: "union",
      type_definition: "type",
      field_declaration: "field",
    },
    // C has no visibility keyword — headers are the interface, so everything
    // counts as exported (same stance as the regex extractor).
    containers: new Set([
      "translation_unit",
      "declaration_list",
      "field_declaration_list",
      "enumerator_list",
      "linkage_specification",
      "preproc_ifdef",
      "preproc_if",
    ]),
    exported: always,
    calls: { call_expression: "function" },
    kindFrom: {
      // In a struct body a `field_declaration` is a data member; with a
      // function_declarator it is a function-pointer member.
      field_declaration: (node) => (hasFunctionDeclarator(node) ? "method" : "field"),
    },
  },
  cpp: {
    lang: "cpp",
    defs: {
      function_definition: "function",
      class_specifier: "class",
      struct_specifier: "struct",
      enum_specifier: "enum",
      enumerator: "enum-member",
      union_specifier: "union",
      type_definition: "type",
      alias_declaration: "type",
      concept_definition: "concept",
      namespace_definition: "namespace",
      field_declaration: "field",
      declaration: "const",
    },
    containers: new Set([
      "translation_unit",
      "declaration_list",
      "field_declaration_list",
      "enumerator_list",
      "template_declaration",
      "linkage_specification",
      "preproc_ifdef",
      "preproc_if",
    ]),
    exported: always,
    calls: { call_expression: "function", new_expression: "constructor" },
    kindFrom: {
      // C++ spells a member FUNCTION declaration and a data member with the same
      // node; only a function_declarator inside tells them apart. Likewise a
      // namespace-scope `declaration` is a constant or a free function.
      field_declaration: (node) => (hasFunctionDeclarator(node) ? "method" : "field"),
      declaration: (node) => (hasFunctionDeclarator(node) ? "function" : "const"),
    },
    sectionVisibility: (node) =>
      node.type === "access_specifier" ? !/^(private|protected)/.test(node.text) : undefined,
    relationsFrom: {
      // C++ has no interfaces — a pure-virtual base is still `extends`.
      class_specifier: (node, ctx) =>
        ctx.self
          ? heritageTargets(childOfType(node, "base_class_clause")).map((to) => rel("extends", ctx.self!, to, node))
          : [],
      struct_specifier: (node, ctx) =>
        ctx.self
          ? heritageTargets(childOfType(node, "base_class_clause")).map((to) => rel("extends", ctx.self!, to, node))
          : [],
    },
  },
  scala: {
    lang: "scala",
    defs: {
      class_definition: "class",
      object_definition: "object",
      trait_definition: "trait",
      enum_definition: "enum",
      function_definition: "def",
      function_declaration: "def",
      val_definition: "val",
      val_declaration: "val",
      var_definition: "var",
      type_definition: "type",
      given_definition: "given",
    },
    // package_clause carries braced-package bodies (`package com.acme { … }`);
    // template_body is every class/object/trait body.
    containers: new Set(["compilation_unit", "package_clause", "template_body", "class_parameters", "parameters"]),
    exported: byNotPrivate,
    kindFrom: {
      // `class Scheduler(val queue: String)` declares a public accessor;
      // `class Scheduler(queue: String)` declares a private constructor
      // parameter. Only the first is a member of the type — and a `case class`
      // makes every parameter one.
      class_parameter: (node) => {
        if (/^\s*(?:val|var)\b/.test(node.text)) return /^\s*var\b/.test(node.text) ? "var" : "val";
        return node.parent?.parent?.type === "class_definition" && /\bcase\s+class\b/.test(node.parent.parent.text.slice(0, 80))
          ? "val"
          : undefined;
      },
    },
    // Qualified calls are call_expression → field_expression (value/field);
    // `new Widget(...)` is an instance_expression with a bare type child.
    calls: { call_expression: "function", instance_expression: "constructor" },
    relationsFrom: {
      // `extends Base with A with B` — the first parent is the superclass, the
      // `with` mixins are traits, i.e. Scala's `implements`.
      class_definition: (node, ctx) => (ctx.self ? firstIsBase(childOfType(node, "extends_clause"), ctx.self, node) : []),
      object_definition: (node, ctx) => (ctx.self ? firstIsBase(childOfType(node, "extends_clause"), ctx.self, node) : []),
      trait_definition: (node, ctx) =>
        ctx.self
          ? heritageTargets(childOfType(node, "extends_clause")).map((to) => rel("extends", ctx.self!, to, node))
          : [],
    },
  },
  bash: {
    lang: "shell",
    defs: { function_definition: "function" },
    // if/compound bodies carry guarded definitions (`if …; then f() { … }; fi`).
    containers: new Set(["program", "if_statement", "compound_statement"]),
    // Shell has no visibility — every function is callable from outside.
    exported: always,
    // Every invocation is a `command` whose `name` field is a command_name
    // wrapping a `word` leaf (hence IDENT_LEAF includes `word`).
    calls: { command: "function" },
  },
  // --- EXTENDED TIER (pull-only; see scripts/fetch-grammars.mjs) --------------

  kotlin: {
    lang: "kotlin",
    defs: {
      class_declaration: "class",
      object_declaration: "object",
      function_declaration: "function",
      property_declaration: "property",
      enum_entry: "enum-member",
      type_alias: "type",
      class_parameter: "property",
    },
    containers: new Set([
      "source_file",
      "class_body",
      "enum_class_body",
      "companion_object",
      "object_declaration",
      // `class Worker(val queue: String)` — a val/var primary-constructor
      // parameter is a property of the class, not just an argument.
      "primary_constructor",
      "class_parameters",
    ]),
    // Kotlin is public by default; `internal` is module-wide, which still counts
    // as reachable from outside the file.
    exported: byNotPrivate,
    calls: { call_expression: "function" },
    kindFrom: {
      // A bare `(queue: String)` parameter is an argument, not a property; only
      // `val`/`var` (or a `data class`, where every parameter is one) declares a member.
      class_parameter: (node) =>
        /^\s*(?:val|var)\b/.test(node.text) ||
        /\bdata\s+class\b/.test(node.parent?.parent?.parent?.text.slice(0, 80) ?? "")
          ? "property"
          : undefined,
      // One node type covers class, interface, enum class and annotation class —
      // only the leading keyword tells them apart.
      class_declaration: (node) => {
        const head = node.text.slice(0, 80);
        if (/\binterface\b/.test(head)) return "interface";
        if (/\benum\s+class\b/.test(head)) return "enum";
        if (/\bannotation\s+class\b/.test(head)) return "annotation";
        return "class";
      },
    },
    nameFrom: {
      // `val depth: Int` wraps the name in a variable_declaration.
      property_declaration: (node) =>
        findFirst(node, (n) => n.type === "variable_declaration")?.namedChildren[0]?.text ??
        node.namedChildren.find((c) => c.type === "identifier")?.text,
    },
    relationsFrom: {
      class_declaration: (node, ctx) => {
        if (!ctx.self) return [];
        const out: RawRelation[] = [];
        for (const spec of childOfType(node, "delegation_specifiers")?.namedChildren ?? []) {
          const to = readTypeName(spec);
          if (!to) continue;
          // `: Base()` invokes a constructor — that is the superclass. A bare
          // `: Runnable` names an interface.
          out.push(rel(findFirst(spec, (n) => n.type === "constructor_invocation") ? "extends" : "implements", ctx.self, to, node));
        }
        return out;
      },
    },
  },

  elixir: {
    lang: "elixir",
    // Elixir has NO declaration node types: `defmodule`, `def` and `defp` are
    // ordinary macro CALLS, so every declaration in the language arrives as the
    // same `call` node and only its callee name says what it declares.
    defs: {},
    containers: new Set(["source", "do_block", "call", "stab_clause"]),
    // `defp`/`defmacrop` are the private forms; everything else is public.
    exported: (header) => !/^\s*defp?macrop\b|^\s*defp\b/.test(header),
    calls: { call: "function" },
    kindFrom: {
      call: (node) => ELIXIR_DEFS[node.childForFieldName("target")?.text ?? node.namedChildren[0]?.text ?? ""],
    },
    skipCall: (node) => {
      // A module attribute: `@max_attempts 5` parses as unary_operator > call.
      if (node.parent?.type === "unary_operator") return true;
      // The declaration's own signature: `def start(queue)` nests the name in a
      // `call` under the declaring macro's `arguments`.
      if (node.parent?.type !== "arguments") return false;
      const decl = node.parent.parent;
      const target = decl?.childForFieldName("target") ?? decl?.namedChildren[0];
      return target !== undefined && ELIXIR_DEFS[target.text] !== undefined;
    },
    // Elixir documents with `@doc "…"` / `@moduledoc "…"` — a preceding
    // `unary_operator` wrapping a call, not a comment. Without this, Elixir
    // symbols carry no intent at all, which is the one thing the doc field is for.
    docFrom: (node) => {
      let prev = node.previousNamedSibling;
      while (prev && prev.type === "unary_operator") {
        const inner = prev.namedChildren[0];
        const target = inner?.childForFieldName("target") ?? inner?.namedChildren[0];
        if (target && /^(doc|moduledoc)$/.test(target.text)) {
          const str = findFirst(prev, (n) => n.type === "string");
          if (str) return str.text.replace(/^"""|"""$/g, "").replace(/^"|"$/g, "").trim() || undefined;
        }
        prev = prev.previousNamedSibling;
      }
      return undefined;
    },
    nameFrom: {
      call: (node) => {
        const args = node.childForFieldName("arguments") ?? node.namedChildren.find((c) => c.type === "arguments");
        const first = args?.namedChildren[0];
        if (!first) return undefined;
        // `defmodule Worker.Scheduler` names an alias; `def start(queue)` wraps
        // the name in an inner call; `defstruct` has no name of its own.
        if (first.type === "alias") return first.text;
        if (first.type === "identifier") return first.text;
        const inner = first.childForFieldName("target") ?? first.namedChildren[0];
        return inner && /identifier|alias/.test(inner.type) ? inner.text : undefined;
      },
    },
  },

  zig: {
    lang: "zig",
    defs: {
      function_declaration: "function",
      variable_declaration: "const",
      container_field: "field",
      test_declaration: "test",
    },
    containers: new Set([
      "source_file",
      // A type is a `const X = struct { … }`, so the declaration itself must be
      // walked into to reach the members.
      "variable_declaration",
      "struct_declaration",
      "enum_declaration",
      "union_declaration",
      "error_set_declaration",
      "block",
    ]),
    exported: byPub,
    calls: { call_expression: "function" },
    kindFrom: {
      // Zig declares every type as a constant bound to a container literal.
      variable_declaration: (node) => {
        // `const std = @import("std")` binds an IMPORT, not a declaration this
        // file makes; treating it as a constant put every dependency in the
        // symbol table.
        const builtin = node.namedChildren.find((c) => c.type === "builtin_function");
        if (builtin && /^@(import|cImport)\b/.test(builtin.text)) return undefined;
        for (const c of node.namedChildren) {
          if (c.type === "struct_declaration") return "struct";
          if (c.type === "enum_declaration") return "enum";
          if (c.type === "union_declaration") return "union";
          if (c.type === "error_set_declaration") return "error";
        }
        return /^\s*(?:pub\s+)?var\b/.test(node.text.slice(0, 24)) ? "var" : "const";
      },
      // The same node is a struct field and an enum member; only the enclosing
      // container literal distinguishes them.
      container_field: (node) => (node.parent?.type === "enum_declaration" ? "enum-member" : "field"),
    },
  },

  solidity: {
    lang: "solidity",
    defs: {
      contract_declaration: "contract",
      interface_declaration: "interface",
      library_declaration: "library",
      function_definition: "function",
      constructor_definition: "constructor",
      modifier_definition: "modifier",
      event_definition: "event",
      error_declaration: "error",
      struct_declaration: "struct",
      struct_member: "field",
      enum_declaration: "enum",
      enum_value: "enum-member",
      state_variable_declaration: "field",
      user_defined_type_definition: "type",
    },
    containers: new Set(["source_file", "contract_body", "struct_declaration", "enum_declaration", "enum_body"]),
    // Solidity states visibility on every member; `public`/`external` is the
    // contract's ABI, `internal`/`private` is not.
    exported: (header, name) => (/\b(public|external)\b/.test(header) ? true : /\b(internal|private)\b/.test(header) ? false : byCapital(header, name) || true),
    calls: { call_expression: "function" },
    nameFrom: {
      // `uint256 public constant MAX = 5` leads with its TYPE, and `type_name`
      // ends in "name", so the generic reader's last resort would return the type.
      state_variable_declaration: (node) => node.namedChildren.find((c) => c.type === "identifier")?.text,
      // An enum member is a LEAF whose own text is the name — it has no
      // identifier child for the generic reader to find.
      enum_value: (node) => node.text,
    },
    relationsFrom: {
      // `contract S is Base, IRunnable` does not distinguish a base contract
      // from an interface; resolution corrects whichever turns out to be one.
      contract_declaration: (node, ctx) =>
        ctx.self
          ? node.namedChildren
              .filter((c) => c.type === "inheritance_specifier")
              .map((c) => readTypeName(c))
              .filter((to): to is string => to !== undefined)
              .map((to) => rel("extends", ctx.self!, to, node))
          : [],
      interface_declaration: (node, ctx) =>
        ctx.self
          ? node.namedChildren
              .filter((c) => c.type === "inheritance_specifier")
              .map((c) => readTypeName(c))
              .filter((to): to is string => to !== undefined)
              .map((to) => rel("extends", ctx.self!, to, node))
          : [],
    },
  },

  terraform: TERRAFORM_SPEC,
  hcl: { ...TERRAFORM_SPEC, lang: "hcl" },
  lua: {
    lang: "lua",
    defs: { function_declaration: "function" },
    // variable_declaration wraps `local x = function()` assignment statements.
    containers: new Set(["chunk", "variable_declaration"]),
    exported: byNotLocal,
    // function_call's `name` is an identifier, a dot_index_expression
    // (table/field) or a method_index_expression (table/method) — the receiver
    // is the `table` field in both qualified forms.
    calls: { function_call: "function" },
    assignments: true, // `M.alias = function(z) … end` (assignment_statement shape)
  },
};
