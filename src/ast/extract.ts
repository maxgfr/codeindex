import type { CodeSymbol, RawRef } from "../types.js";
import { byStr } from "../sort.js";
import { grammarKeyForExt, grammarReady, parserFor } from "./loader.js";

// A tree-sitter Node — typed structurally so we don't depend on web-tree-sitter's
// exported types leaking through the bundle. Only the members we use.
interface TSNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildCount: number;
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  children: TSNode[];
}

export interface AstResult {
  symbols: CodeSymbol[];
  refs: RawRef[];
  pkg?: string;
  // Distinctive identifiers this file REFERENCES (not defines) — the raw material
  // for code→code `use` edges. Bounded and pre-filtered to identifiers that could
  // plausibly be a unique exported symbol (length ≥ 5), so the set stays small.
  idents: string[];
  // Unresolved call-site callee names — raw material for the cross-file call
  // graph, resolved globally later. Always present (empty when the grammar has no
  // `calls` mapping), mirroring how `idents` is always present.
  calls: { name: string; line: number }[];
  // JS/TS named-import bindings — always present (empty for non-JS/TS).
  importedNames: string[];
}

const MAX_REF_IDENTS = 256;
const MAX_CALLS = 512;
const MAX_IMPORTED_NAMES = 256;

// Collect distinctive referenced identifiers across the whole tree, minus the
// file's own definition names. Deterministic (sorted) and capped.
function collectRefIdents(root: TSNode, defNames: Set<string>): string[] {
  const found = new Set<string>();
  const visit = (node: TSNode): void => {
    if (
      node.namedChildCount === 0 &&
      /identifier|constant|(^|_)name$/.test(node.type) &&
      /^[A-Za-z_]\w{4,}$/.test(node.text) &&
      !defNames.has(node.text)
    ) {
      found.add(node.text);
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
  };
  visit(root);
  return [...found].sort().slice(0, MAX_REF_IDENTS);
}

// How one grammar's declarations map to symbols. `defs` maps a node type to a
// symbol kind; `containers` are nodes whose body we recurse into for nested
// members (methods, namespace/impl bodies); `exported` decides visibility from
// the declaration's first line or name.
interface LangSpec {
  lang: string;
  defs: Record<string, string>;
  containers: Set<string>;
  exported: (firstLine: string, name: string) => boolean;
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
  assignments?: boolean;
}

const byPublicKeyword = (line: string): boolean => /\b(public|internal)\b/.test(line);
const byPub = (line: string): boolean => /\bpub\b/.test(line);
const byCapital = (_l: string, name: string): boolean => /^[A-Z]/.test(name);
const byPyConvention = (_l: string, name: string): boolean => !name.startsWith("_") || /^__\w+__$/.test(name);
const always = (): boolean => true;
// JS/TS export is structural (an `export` statement wraps the declaration); a
// bare declaration is module-private, so the name/line heuristic never marks it.
const neverExport = (): boolean => false;

// TypeScript is the base for tsx and javascript, so it is a named const rather
// than indexed back out of SPECS (which noUncheckedIndexedAccess would widen to
// `LangSpec | undefined`, breaking the derived spreads below).
const TS_SPEC: LangSpec = {
  lang: "typescript",
  defs: {
    function_declaration: "function", generator_function_declaration: "function",
    class_declaration: "class", abstract_class_declaration: "class",
    interface_declaration: "interface", type_alias_declaration: "type",
    enum_declaration: "enum", method_definition: "method", variable_declarator: "const",
  },
  containers: new Set(["class_body", "export_statement", "program", "lexical_declaration", "variable_declaration"]),
  exported: neverExport, // export is tracked structurally via export_statement; see walk
  imports: { import_statement: "string" },
  calls: { call_expression: "function", new_expression: "constructor" },
  assignments: true,
};

const SPECS: Record<string, LangSpec> = {
  typescript: TS_SPEC,
  tsx: { ...TS_SPEC, lang: "typescript" },
  javascript: {
    ...TS_SPEC,
    lang: "javascript",
    defs: {
      function_declaration: "function", generator_function_declaration: "function",
      class_declaration: "class", method_definition: "method", variable_declarator: "const",
    },
  },
  python: {
    lang: "python",
    defs: { function_definition: "function", class_definition: "class" },
    containers: new Set(["block", "decorated_definition", "module"]),
    exported: byPyConvention,
    imports: { import_statement: "path", import_from_statement: "path" },
    calls: { call: "function" },
  },
  go: {
    lang: "go",
    defs: {
      function_declaration: "function", method_declaration: "method",
      type_spec: "type", const_spec: "const", var_spec: "var",
    },
    containers: new Set(["type_declaration", "const_declaration", "var_declaration", "source_file"]),
    exported: byCapital,
    imports: { import_declaration: "string" },
    calls: { call_expression: "function" },
  },
  ruby: {
    lang: "ruby",
    defs: { method: "def", singleton_method: "def", class: "class", module: "module" },
    containers: new Set(["class", "module", "body_statement", "program"]),
    exported: always,
    // Ruby models every invocation — dotted, parenthesized, or bare command form
    // (`puts "x"`) — as a `call` node whose callee is the `method` field.
    calls: { call: "function" },
  },
  java: {
    lang: "java",
    defs: {
      class_declaration: "class", interface_declaration: "interface",
      enum_declaration: "enum", record_declaration: "record",
      method_declaration: "method", constructor_declaration: "constructor",
    },
    containers: new Set(["class_body", "interface_body", "enum_body", "program"]),
    exported: byPublicKeyword,
    imports: { import_declaration: "path" },
    calls: { method_invocation: "function", object_creation_expression: "constructor" },
  },
  rust: {
    lang: "rust",
    defs: {
      function_item: "function", struct_item: "struct", enum_item: "enum",
      trait_item: "trait", type_item: "type", mod_item: "mod",
      const_item: "const", static_item: "static", union_item: "union", macro_definition: "macro",
    },
    containers: new Set(["impl_item", "declaration_list", "source_file"]),
    exported: byPub,
    calls: { call_expression: "function" },
  },
  c_sharp: {
    lang: "csharp",
    defs: {
      class_declaration: "class", interface_declaration: "interface",
      struct_declaration: "struct", enum_declaration: "enum", record_declaration: "record",
      method_declaration: "method", constructor_declaration: "constructor", property_declaration: "property",
    },
    containers: new Set(["namespace_declaration", "declaration_list", "compilation_unit", "file_scoped_namespace_declaration"]),
    exported: byPublicKeyword,
    calls: { invocation_expression: "function", object_creation_expression: "constructor" },
  },
  php: {
    lang: "php",
    defs: {
      function_definition: "function", class_declaration: "class",
      interface_declaration: "interface", trait_declaration: "trait",
      enum_declaration: "enum", method_declaration: "method",
    },
    containers: new Set(["declaration_list", "program"]),
    exported: always,
    calls: { function_call_expression: "function", member_call_expression: "member", object_creation_expression: "constructor" },
  },
};

function firstLine(node: TSNode): string {
  const nl = node.text.indexOf("\n");
  return (nl === -1 ? node.text : node.text.slice(0, nl)).trim().slice(0, 200);
}

function nameOf(node: TSNode): string | undefined {
  const named = node.childForFieldName("name");
  if (named?.text) return named.text;
  // Fall back to the first identifier-like named child (covers grammars that do
  // not expose a `name` field on a given node).
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (/(^|_)(identifier|name|constant)$/.test(c.type)) return c.text;
  }
  return undefined;
}

// Read import specifiers from the whole tree by scanning for the grammar's import
// node types. "string" pulls the first string literal's inner text; "path" takes
// the dotted/namespaced module text verbatim (resolution happens later).
function collectImports(root: TSNode, spec: LangSpec): RawRef[] {
  if (!spec.imports) return [];
  const out: RawRef[] = [];
  const seen = new Set<string>();
  const add = (s: string): void => {
    const v = s.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push({ kind: "import", spec: v });
    }
  };
  const visit = (node: TSNode): void => {
    const how = spec.imports![node.type];
    if (how === "string") {
      const str = findFirst(node, (n) => /string/.test(n.type));
      if (str) add(str.text.replace(/^['"]|['"]$/g, ""));
    } else if (how === "path") {
      const name = node.childForFieldName("name") ?? node.childForFieldName("module_name");
      add((name ?? node).text.replace(/^(import|from)\s+/, "").split(/\s+/)[0]!);
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
  };
  visit(root);
  return out;
}

function findFirst(node: TSNode, pred: (n: TSNode) => boolean): TSNode | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (pred(c)) return c;
    const deep = findFirst(c, pred);
    if (deep) return deep;
  }
  return undefined;
}

// True for a leaf node that IS an identifier-ish name (identifier,
// property_identifier, type_identifier, field_identifier, constant, or php's
// `name`). The rightmost such leaf of a callee is the called name.
const IDENT_LEAF = /(^|_)(identifier|name|constant)$/;

// Read the callee's simple name from a (possibly qualified) callee node: a bare
// identifier returns itself; a member/attribute/selector/scoped access returns its
// final segment via the field name that grammar uses (falling back to the last
// named child). Returns undefined for a computed/complex callee we can't name.
function readName(node: TSNode | null): string | undefined {
  if (!node) return undefined;
  if (node.namedChildCount === 0) return IDENT_LEAF.test(node.type) ? node.text : undefined;
  const seg =
    node.childForFieldName("name") ??
    node.childForFieldName("property") ??
    node.childForFieldName("attribute") ??
    node.childForFieldName("field");
  if (seg) return readName(seg);
  const last = node.namedChild(node.namedChildCount - 1);
  return last && last !== node ? readName(last) : undefined;
}

// Collect callee names for every call-expression node the grammar maps. "function"
// reads the callee/function field (grammars that name it differently — Java's
// `method_invocation` — expose the callee under `name`); "member" reads the
// dedicated member-call node's `name`; "constructor" reads the constructed type.
// Names are filtered to plausible identifiers (≥ 2 chars), deduped by name+line,
// sorted, and capped, so the set stays small and deterministic.
function collectCalls(root: TSNode, spec: LangSpec): { name: string; line: number }[] {
  if (!spec.calls) return [];
  const out: { name: string; line: number }[] = [];
  const seen = new Set<string>();
  const add = (name: string | undefined, node: TSNode): void => {
    if (!name || name.length < 2 || !/^[A-Za-z_]\w*$/.test(name)) return;
    const line = node.startPosition.row + 1;
    const key = `${name} ${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, line });
  };
  const visit = (node: TSNode): void => {
    const how = spec.calls![node.type];
    if (how === "function") {
      // Grammars name the callee field differently: `function` (TS/py/go/rust/
      // c#/php), `name` (Java's method_invocation), `method` (Ruby's call).
      add(readName(node.childForFieldName("function") ?? node.childForFieldName("callee") ?? node.childForFieldName("method") ?? node.childForFieldName("name")), node);
    } else if (how === "member") {
      add(readName(node.childForFieldName("name")), node);
    } else if (how === "constructor") {
      // TS/Java/C# expose the type under a `constructor`/`type` field; PHP's
      // object_creation_expression carries it as a bare `name` child, so fall
      // back to the first identifier-ish child when no field matches.
      let t = node.childForFieldName("constructor") ?? node.childForFieldName("type") ?? node.childForFieldName("name");
      for (let i = 0; !t && i < node.namedChildCount; i++) {
        const c = node.namedChild(i)!;
        if (IDENT_LEAF.test(c.type)) t = c;
      }
      add(readName(t), node);
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
  };
  visit(root);
  out.sort((a, b) => byStr(a.name, b.name) || a.line - b.line);
  return out.slice(0, MAX_CALLS);
}

// Collect JS/TS named-import bindings: `import { a, b as c } from "x"` →
// `import_clause → named_imports → import_specifier`, reading each specifier's
// `name` field (the pre-alias name). Default/namespace bindings are intentionally
// NOT collected — the call-resolution gate only corroborates named imports, and a
// default/namespace binding names a module, not a specific exported symbol.
function collectImportedNames(root: TSNode, spec: LangSpec): string[] {
  if (!spec.imports?.import_statement) return [];
  const found = new Set<string>();
  const visit = (node: TSNode): void => {
    if (node.type === "import_statement") {
      for (let i = 0; i < node.namedChildCount; i++) {
        const clause = node.namedChild(i)!;
        if (clause.type !== "import_clause") continue;
        for (let j = 0; j < clause.namedChildCount; j++) {
          const named = clause.namedChild(j)!;
          if (named.type !== "named_imports") continue;
          for (let k = 0; k < named.namedChildCount; k++) {
            const specifier = named.namedChild(k)!;
            if (specifier.type !== "import_specifier") continue;
            const nm = specifier.childForFieldName("name") ?? specifier.namedChild(0);
            if (nm?.text) found.add(nm.text);
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
  };
  visit(root);
  return [...found].sort(byStr).slice(0, MAX_IMPORTED_NAMES);
}

// Extract declared symbols from one file via its committed grammar. Returns
// undefined when no grammar is loaded for the extension (caller falls back to the
// regex extractor). Walks top-level declarations plus one level of nested members.
export function extractAst(rel: string, ext: string, content: string): AstResult | undefined {
  const key = grammarKeyForExt(ext);
  if (!key || !grammarReady(key)) return undefined;
  const spec = SPECS[key];
  if (!spec) return undefined;
  const parser = parserFor(key);
  if (!parser) return undefined;

  let tree: { rootNode: TSNode; delete(): void } | null = null;
  try {
    tree = parser.parse(content) as unknown as { rootNode: TSNode; delete(): void };
    if (!tree) return undefined;
    const symbols: CodeSymbol[] = [];
    const root = tree.rootNode;
    // `export default Foo;` / `export { Foo }` re-export a declaration made
    // earlier in the file; record those names and mark the matching symbols
    // exported after the walk (the declaration node itself is not wrapped).
    const exportedNames = new Set<string>();

    const walk = (node: TSNode, parent: string | undefined, exported: boolean): void => {
      // `export …` / `export default …` (JS/TS) marks the wrapped declaration.
      const nowExported = exported || node.type === "export_statement";
      if (node.type === "export_statement") {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i)!;
          if (c.type === "identifier") exportedNames.add(c.text);
          else if (c.type === "export_clause") {
            for (let j = 0; j < c.namedChildCount; j++) {
              const spec = c.namedChild(j)!;
              const nm = spec.childForFieldName("name") ?? spec.namedChild(0);
              if (nm?.text) exportedNames.add(nm.text);
            }
          }
        }
      }
      // CommonJS-style definition: a top-level `<target> = <function|class>`
      // expression. Named after the assigned property (or identifier); only
      // `exports.*` / `module.exports.*` targets count as exported — augmenting
      // a local object (res.*, Foo.prototype.*) is not a module export.
      if (spec.assignments && node.type === "expression_statement") {
        const expr = node.namedChild(0);
        if (expr?.type === "assignment_expression") {
          const left = expr.childForFieldName("left");
          const right = expr.childForFieldName("right");
          const funcy = right && ["function_expression", "function", "generator_function", "arrow_function", "class"].includes(right.type);
          if (left && right && funcy) {
            let name: string | undefined;
            let exportedAssign = false;
            if (left.type === "member_expression") {
              const prop = left.childForFieldName("property");
              if (prop?.type === "property_identifier") {
                name = prop.text;
                const obj = left.text.slice(0, left.text.length - prop.text.length - 1);
                exportedAssign = obj === "exports" || obj === "module.exports";
              }
            } else if (left.type === "identifier") {
              name = left.text;
            }
            if (name) {
              symbols.push({
                name,
                kind: right.type === "class" ? "class" : "function",
                file: rel,
                line: expr.startPosition.row + 1,
                endLine: expr.endPosition.row + 1,
                ...(parent ? { parent } : {}),
                signature: firstLine(expr),
                exported: nowExported || exportedAssign,
                lang: spec.lang,
              });
              return;
            }
          }
        }
      }
      const kind = spec.defs[node.type];
      if (kind) {
        const name = nameOf(node);
        if (name) {
          const line = firstLine(node);
          symbols.push({
            name,
            kind,
            file: rel,
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            ...(parent ? { parent } : {}),
            signature: line,
            exported: nowExported || spec.exported(line, name),
            lang: spec.lang,
          });
          // Recurse into this declaration's body for nested members (methods),
          // scoping their parent to this symbol.
          for (let i = 0; i < node.namedChildCount; i++) {
            walkBody(node.namedChild(i)!, name, nowExported);
          }
          return;
        }
      }
      if (spec.containers.has(node.type)) {
        for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, parent, nowExported);
      }
    };
    // Recurse a declaration body one level: only container-ish children yield more
    // members, so nested functions inside a method body are not surfaced (matches
    // the "top-level + one level" contract).
    const walkBody = (node: TSNode, parent: string, exported: boolean): void => {
      if (spec.containers.has(node.type)) {
        for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, parent, exported);
      }
    };

    walk(root, undefined, false);
    if (exportedNames.size) {
      for (const s of symbols) if (!s.exported && exportedNames.has(s.name)) s.exported = true;
    }

    const refs = collectImports(root, spec);
    const idents = collectRefIdents(root, new Set(symbols.map((s) => s.name)));
    const calls = collectCalls(root, spec);
    const importedNames = collectImportedNames(root, spec);
    let pkg: string | undefined;
    if (spec.lang === "java") {
      const p = findFirst(root, (n) => n.type === "package_declaration");
      if (p) pkg = p.text.replace(/^package\s+/, "").replace(/;.*$/, "").trim();
    }
    return { symbols, refs, pkg, idents, calls, importedNames };
  } catch {
    return undefined; // any parse/walk failure → regex fallback
  } finally {
    tree?.delete(); // free wasm-side memory every file (not GC'd otherwise)
  }
}
