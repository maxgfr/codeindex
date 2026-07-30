import type { CodeSymbol, RawRef, RawRelation } from "../types.js";
import { byStr } from "../sort.js";
import { grammarKeyForExt, grammarReady, parserFor } from "./loader.js";
import { IDENT_LEAF, findFirst, nameOf, readName, readReceiver, type TSNode } from "./node.js";
import { FUNCTION_KINDS, FUNCTION_VALUE_TYPES, PUBLIC_MEMBER_KINDS, SPECS, type LangSpec } from "./specs.js";
import { declHeader } from "./signature.js";
import { docCommentFor, docstringFor } from "./doc.js";
import { stripCommentMarkers } from "../extract/doc-text.js";
import { subtokens } from "../util.js";

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
  // `calls` mapping), mirroring how `idents` is always present. `receiver` is the
  // immediate receiver of a qualified call (`axios.get(...)` → "axios").
  calls: { name: string; line: number; receiver?: string }[];
  // JS/TS named-import bindings — always present (empty for non-JS/TS).
  importedNames: string[];
  // Inheritance stated by this file's declarations, deduped and sorted. Always
  // present (empty when the grammar has no `relationsFrom` mapping).
  relations: RawRelation[];
  // PROSE vocabulary of the file: words from its comments and its short string
  // literals, subtokenized, deduped, capped and sorted. This is what makes
  // "where is rate limiting handled" answerable — the phrase lives in a comment,
  // and an index built only from declaration names cannot see it.
  terms: string[];
  // True when a per-file cap truncated the result — never silent, same doctrine
  // as the walk's `capped` flag.
  truncated?: true;
}

const MAX_REF_IDENTS = 512;
const MAX_CALLS = 512;
const MAX_IMPORTED_NAMES = 256;
const MAX_SYMBOLS = 2000;
const MAX_RELATIONS = 256;
// Prose-term ceiling. Collected in SOURCE order and truncated at the tail, then
// sorted for storage: truncating the sorted list instead would cut the alphabet
// off at "m" and bias every large file's vocabulary toward early letters.
const MAX_TERMS = 512;
// Longest string literal treated as prose. A route path, an error message or a
// config key is worth indexing; a base64 blob or an embedded template is not.
const MAX_LITERAL_LEN = 80;

// How many nested FUNCTION bodies deep we keep looking for declarations. Depth 1
// finds a route handler or a helper closure inside an exported function; depth 2
// finds one nested inside that. Beyond it the yield is noise, and a generated
// bundle could otherwise walk arbitrarily deep.
const MAX_FUNC_DEPTH = 2;

// Declaration kinds that stay worth indexing inside a function body. A `const`
// there is a local; a `struct` there is a type someone can name.
const NESTED_TYPE_KINDS = new Set(["class", "struct", "enum", "interface", "trait", "type", "record", "union"]);

// JS/TS node types an anonymous `export default` can wrap ("function" and
// "class" are the expression forms; the _declaration forms cover grammars that
// keep the declaration node but omit the name).
const ANON_DEFAULT_FN = new Set([
  "function", "function_expression", "function_declaration",
  "generator_function", "generator_function_declaration", "arrow_function",
]);
const ANON_DEFAULT_CLASS = new Set(["class", "class_declaration", "abstract_class_declaration"]);

const REF_IDENT_TYPE = /identifier|constant|(^|_)name$/;
const REF_IDENT_TEXT = /^[A-Za-z_]\w{4,}$/;

// Everything the post-declaration passes need, gathered in ONE pre-order walk.
//
// These four collections used to be four independent full-tree traversals, each
// re-crossing the wasm boundary for every node. They are order-independent by
// construction — idents and importedNames are Sets that get sorted, calls dedups
// on (name, line) then sorts — so folding them into a single pre-order walk in
// the original per-node order produces byte-identical results.
//
// `refs`/`pkg` are computed only when `wantImports` is set: the production path
// (extractCode) recomputes both with regex and discards the AST's versions, so
// paying for them by default was pure waste. The public `extractAst` still asks
// for them, keeping its contract intact.
interface Collected {
  refs: RawRef[];
  idents: string[];
  calls: { name: string; line: number; receiver?: string }[];
  importedNames: string[];
  terms: string[];
}

const COMMENT_NODE = /(^|_)comment$/;
const STRING_NODE = /(^|_)string(_literal)?$/;

function collectAll(
  root: TSNode,
  spec: LangSpec,
  defNames: Set<string>,
  maxCalls: number,
  wantImports: boolean,
): Collected {
  const identsFound = new Set<string>();

  const wantCalls = spec.calls !== undefined;
  const calls: { name: string; line: number; receiver?: string }[] = [];
  const callSeen = new Set<string>();
  const addCall = (name: string | undefined, node: TSNode, receiver?: string): void => {
    if (!name || name.length < 2 || !/^[A-Za-z_]\w*$/.test(name)) return;
    const line = node.startPosition.row + 1;
    const key = `${name} ${line}`;
    if (callSeen.has(key)) return;
    callSeen.add(key);
    calls.push(receiver ? { name, line, receiver } : { name, line });
  };

  // Prose vocabulary, in source order (see MAX_TERMS on why order matters).
  const termsFound = new Set<string>();
  const addTerms = (text: string): void => {
    if (termsFound.size >= MAX_TERMS) return;
    for (const t of subtokens(text)) {
      if (termsFound.size >= MAX_TERMS) return;
      termsFound.add(t);
    }
  };

  const wantNames = spec.imports?.import_statement !== undefined;
  const namesFound = new Set<string>();

  const wantRefs = wantImports && spec.imports !== undefined;
  const refs: RawRef[] = [];
  const refSeen = new Set<string>();
  const addRef = (s: string): void => {
    const v = s.trim();
    if (v && !refSeen.has(v)) {
      refSeen.add(v);
      refs.push({ kind: "import", spec: v });
    }
  };

  const visit = (node: TSNode): void => {
    const type = node.type;
    const kids = node.namedChildren;

    // --- distinctive referenced identifiers (leaves only) ---
    if (kids.length === 0 && REF_IDENT_TYPE.test(type)) {
      const text = node.text;
      if (REF_IDENT_TEXT.test(text) && !defNames.has(text)) identsFound.add(text);
    }

    // --- prose: comments and short string literals ---
    if (COMMENT_NODE.test(type)) {
      for (const line of node.text.split(/\r?\n/)) addTerms(stripCommentMarkers(line));
    } else if (kids.length === 0 && STRING_NODE.test(type) && node.endIndex - node.startIndex <= MAX_LITERAL_LEN) {
      addTerms(node.text.replace(/^['"`]+|['"`]+$/g, ""));
    }

    // --- call sites ---
    // A node that DECLARES something is not a call site. Elixir needs this
    // outright: `def`, `defp` and `defmodule` are ordinary macro calls there, so
    // without the guard every declaration in the file also registers a call to
    // "def".
    if (wantCalls && !(spec.kindFrom?.[type] && spec.kindFrom[type]!(node)) && !spec.skipCall?.(node)) {
      const how = spec.calls![type];
      if (how === "function") {
        // Grammars name the callee field differently: `function` (TS/py/go/rust/
        // c#/php), `name` (Java's method_invocation), `method` (Ruby's call). The
        // receiver lives on the qualified callee node, or (java/ruby) on the call
        // node itself.
        // Grammars that name the callee field: `function`, `callee`, `method`,
        // `name`, `target`. Kotlin and Elixir name it NOTHING — the callee is
        // simply the first child — so a field-only read found no calls at all in
        // either language.
        const callee =
          node.childForFieldName("function") ??
          node.childForFieldName("callee") ??
          node.childForFieldName("method") ??
          node.childForFieldName("name") ??
          node.childForFieldName("target") ??
          kids[0] ??
          null;
        addCall(readName(callee), node, readReceiver(callee) ?? readReceiver(node));
      } else if (how === "member") {
        addCall(readName(node.childForFieldName("name")), node, readReceiver(node));
      } else if (how === "constructor") {
        // TS/Java/C# expose the type under a `constructor`/`type` field; PHP's
        // object_creation_expression carries it as a bare `name` child, so fall
        // back to the first identifier-ish child when no field matches.
        let t = node.childForFieldName("constructor") ?? node.childForFieldName("type") ?? node.childForFieldName("name");
        for (let i = 0; !t && i < kids.length; i++) {
          const c = kids[i]!;
          if (IDENT_LEAF.test(c.type)) t = c;
        }
        addCall(readName(t), node, readReceiver(t ?? null));
      }
    }

    // --- JS/TS named-import bindings: import_clause → named_imports →
    // import_specifier, reading each specifier's pre-alias `name`. Default and
    // namespace bindings are intentionally NOT collected — the call-resolution
    // gate only corroborates named imports.
    if (wantNames && type === "import_statement") {
      for (const clause of kids) {
        if (clause.type !== "import_clause") continue;
        for (const named of clause.namedChildren) {
          if (named.type !== "named_imports") continue;
          for (const specifier of named.namedChildren) {
            if (specifier.type !== "import_specifier") continue;
            const nm = specifier.childForFieldName("name") ?? specifier.namedChildren[0];
            if (nm?.text) namesFound.add(nm.text);
          }
        }
      }
    }

    // --- raw import specifiers. "string" pulls the first string literal's inner
    // text; "path" takes the dotted/namespaced module text verbatim (resolution
    // happens later).
    if (wantRefs) {
      const how = spec.imports![type];
      if (how === "string") {
        const str = findFirst(node, (n) => /string/.test(n.type));
        if (str) addRef(str.text.replace(/^['"]|['"]$/g, ""));
      } else if (how === "path") {
        const name = node.childForFieldName("name") ?? node.childForFieldName("module_name");
        addRef((name ?? node).text.replace(/^(import|from)\s+/, "").split(/\s+/)[0]!);
      }
    }

    for (const c of kids) visit(c);
  };
  visit(root);

  calls.sort((a, b) => byStr(a.name, b.name) || a.line - b.line);
  return {
    refs,
    idents: [...identsFound].sort().slice(0, MAX_REF_IDENTS),
    calls: calls.slice(0, maxCalls),
    importedNames: [...namesFound].sort(byStr).slice(0, MAX_IMPORTED_NAMES),
    terms: [...termsFound].sort(byStr),
  };
}


// Every identifier a destructuring pattern BINDS, in source order. Recurses so
// nested and defaulted patterns (`const { a: { b }, c = 1 } = …`) yield `b` and
// `c` rather than the pattern's text.
function boundNames(pattern: TSNode): string[] {
  const out: string[] = [];
  const visit = (n: TSNode): void => {
    if (/^(shorthand_property_identifier_pattern|identifier)$/.test(n.type)) {
      if (!out.includes(n.text)) out.push(n.text);
      return;
    }
    // A `pair_pattern`'s KEY is the source property, not a binding; only its
    // value side binds a name.
    if (n.type === "pair_pattern") {
      const v = n.childForFieldName("value");
      if (v) visit(v);
      return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  for (const c of pattern.namedChildren) visit(c);
  return out;
}

// What the walk knows about where it currently is. Threaded rather than stored,
// so the walk stays a pure function of the tree and two builds agree byte for byte.
interface WalkCtx {
  /** Immediate enclosing symbol name. */
  parent?: string;
  /** Full ancestor path ("Scheduler/dispatch"), for symbols nested 2+ deep. */
  parentPath?: string;
  /** Kind of the enclosing declaration — decides whether members are locals or fields. */
  ownerKind?: string;
  /** An enclosing `export`/`declare` marks everything inside it as public. */
  exported: boolean;
  /** Inside an interface/trait/enum, or a trait implementation: members are public. */
  forcePublic: boolean;
  /** Inside executable code: whatever is declared here is a local, not API. */
  inFunctionBody: boolean;
  /** How many function bodies deep, against MAX_FUNC_DEPTH. */
  funcDepth: number;
  /** Current visibility section (C++ `private:`, Ruby bare `private`). */
  sectionPublic: boolean;
}

// Extract declared symbols from one file via its committed grammar. Returns
// undefined when no grammar is loaded for the extension (caller falls back to the
// regex extractor). Walks top-level declarations, type members, and declarations
// nested up to MAX_FUNC_DEPTH function bodies deep.
// `opts.maxCalls` overrides the per-file call-site cap (default MAX_CALLS).
// `opts.imports` (default true) computes `refs`/`pkg`; extractCode passes false
// because it recomputes both with regex and discards these — see collectAll.
export function extractAst(
  rel: string,
  ext: string,
  content: string,
  opts: { maxCalls?: number; imports?: boolean; maxSymbols?: number } = {},
): AstResult | undefined {
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
    const maxSymbols = opts.maxSymbols ?? MAX_SYMBOLS;
    const symbols: CodeSymbol[] = [];
    const root = tree.rootNode;
    // The file stem names an anonymous `export default` (Button.tsx → "Button").
    const stem = (rel.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    // `export default Foo;` / `export { Foo }` re-export a declaration made
    // earlier in the file; record those names and mark the matching symbols
    // exported after the walk (the declaration node itself is not wrapped).
    const exportedNames = new Set<string>();

    const emit = (s: CodeSymbol): void => {
      if (symbols.length < maxSymbols) symbols.push(s);
    };

    const relations: RawRelation[] = [];
    const relSeen = new Set<string>();
    // `self` is what the relation is ABOUT: a class's own name, Rust's impl
    // target, or the enclosing class for a Ruby `include`.
    const collectRelations = (node: TSNode, self: string | undefined): void => {
      const reader = spec.relationsFrom?.[node.type];
      if (!reader) return;
      for (const r of reader(node, { self })) {
        if (r.from === r.to) continue; // a type does not inherit from itself
        const key = `${r.kind} ${r.from} ${r.to}`;
        if (relSeen.has(key) || relations.length >= MAX_RELATIONS) continue;
        relSeen.add(key);
        relations.push(r);
      }
    };

    // Visibility of one declaration, in precedence order. A local always loses,
    // an explicit `private` beats an enclosing `export`, and an interface/trait
    // member wins over a missing keyword it is not allowed to write.
    const visibilityOf = (node: TSNode, header: string, name: string, ctx: WalkCtx): boolean => {
      if (ctx.inFunctionBody) return false;
      if (spec.privateMember?.(node) === true) return false;
      if (spec.publicMember?.(node) === true) return true;
      if (!ctx.sectionPublic) return false;
      if (ctx.forcePublic) return true;
      return ctx.exported || spec.exported(header, name);
    };

    const docOf = (node: TSNode): string | undefined =>
      spec.docFrom?.(node) ?? (spec.docstring ? docstringFor(node) : undefined) ?? docCommentFor(node);

    // Iterate a container's children, tracking the visibility section its
    // markers set. The section is LOCAL to this container: a `private:` in one
    // class body must not leak into the next.
    const walkChildren = (container: TSNode, ctx: WalkCtx): void => {
      let sectionPublic = ctx.sectionPublic;
      const bareKind = spec.bareMembers?.[container.type];
      for (const c of container.namedChildren) {
        if (spec.sectionVisibility) {
          const flip = spec.sectionVisibility(c);
          if (flip !== undefined) {
            sectionPublic = flip;
            continue;
          }
        }
        const childCtx = sectionPublic === ctx.sectionPublic ? ctx : { ...ctx, sectionPublic };

        // Enum members written without an initialiser are a bare identifier
        // leaf, not a declaration node any table can key on.
        if (bareKind && c.namedChildren.length === 0 && IDENT_LEAF.test(c.type)) {
          emit({
            name: c.text,
            kind: bareKind,
            file: rel,
            line: c.startPosition.row + 1,
            endLine: c.endPosition.row + 1,
            ...(childCtx.parent ? { parent: childCtx.parent } : {}),
            exported: childCtx.forcePublic || childCtx.exported,
            lang: spec.lang,
          });
          continue;
        }

        for (const extra of spec.extraMembers?.(c, { ownerKind: childCtx.ownerKind, inFunctionBody: childCtx.inFunctionBody }) ?? []) {
          const header = declHeader(c, content);
          const doc = docCommentFor(c);
          emit({
            name: extra.name,
            kind: extra.kind,
            file: rel,
            line: c.startPosition.row + 1,
            endLine: c.endPosition.row + 1,
            ...(childCtx.parent ? { parent: childCtx.parent } : {}),
            ...(childCtx.parentPath && childCtx.parentPath !== childCtx.parent ? { parentPath: childCtx.parentPath } : {}),
            signature: header,
            ...(doc ? { doc } : {}),
            exported: visibilityOf(c, header, extra.name, childCtx),
            lang: spec.lang,
          });
        }

        walk(c, childCtx);
      }
    };

    // Descend into a declaration's body. Normally the body is a container CHILD
    // (a class_body, a declaration_list). Some grammars give a declaration no
    // body node at all and hang its members directly off it — Solidity's
    // `enum Outcome { Timeout, Rejected }` — so when no container child exists
    // and the declaration is itself a container, walk it directly. Guarded on
    // "no container child" precisely so a language whose declaration IS also a
    // container (Ruby's `class`, whose body_statement is the container) does not
    // get its body walked twice and emit every member twice.
    const walkBody = (node: TSNode, ctx: WalkCtx): void => {
      let descended = false;
      for (const c of node.namedChildren) {
        if (!spec.containers.has(c.type)) continue;
        descended = true;
        walkChildren(c, ctx);
      }
      if (!descended && spec.containers.has(node.type)) walkChildren(node, ctx);
    };

    const walk = (node: TSNode, ctx: WalkCtx): void => {
      if (ctx.funcDepth > MAX_FUNC_DEPTH) return;
      const type = node.type;

      // `export …` / `declare …` marks everything it wraps as public.
      const isExportMarker = spec.exportMarkers?.has(type) === true;
      const nowExported = ctx.exported || isExportMarker;
      if (type === "export_statement") {
        for (const c of node.namedChildren) {
          if (c.type === "identifier") exportedNames.add(c.text);
          else if (c.type === "export_clause") {
            for (const clause of c.namedChildren) {
              const nm = clause.childForFieldName("name") ?? clause.namedChildren[0];
              if (nm?.text) exportedNames.add(nm.text);
            }
          }
        }
        // An anonymous `export default function/class/arrow` has no name node the
        // declaration walk could pick up — name it after the file stem (ultradoc
        // parity), so the module's default export is a real, referencable symbol.
        if (stem && node.children.some((c) => c.type === "default")) {
          for (const c of node.namedChildren) {
            const fnLike = ANON_DEFAULT_FN.has(c.type);
            const classLike = ANON_DEFAULT_CLASS.has(c.type);
            if ((fnLike || classLike) && !c.childForFieldName("name")) {
              const doc = docCommentFor(node);
              emit({
                name: stem,
                kind: classLike ? "class" : "function",
                file: rel,
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                signature: declHeader(node, content),
                ...(doc ? { doc } : {}),
                exported: true,
                lang: spec.lang,
              });
              break;
            }
          }
        }
      }

      // CommonJS-style definition: a top-level `<target> = <function|class>`
      // expression. Named after the assigned property (or identifier); only
      // `exports.*` / `module.exports.*` targets count as exported — augmenting
      // a local object (res.*, Foo.prototype.*) is not a module export.
      if (spec.assignments && type === "expression_statement") {
        const expr = node.namedChildren[0];
        if (expr?.type === "assignment_expression") {
          const left = expr.childForFieldName("left");
          const right = expr.childForFieldName("right");
          if (left?.type === "member_expression" && left.text === "module.exports" && right) {
            // `module.exports = { foo, bar: baz }` — a CJS export list: mark the
            // shorthand names, keys and identifier values as exported (key = the
            // exported surface, identifier value = the local declaration).
            if (right.type === "object") {
              for (const p of right.namedChildren) {
                if (p.type === "shorthand_property_identifier") exportedNames.add(p.text);
                else if (p.type === "pair") {
                  const k = p.childForFieldName("key");
                  const v = p.childForFieldName("value");
                  if (k?.type === "property_identifier") exportedNames.add(k.text);
                  if (v?.type === "identifier") exportedNames.add(v.text);
                }
              }
              return;
            }
            // `module.exports = Foo;` — the CJS default export of a local decl.
            if (right.type === "identifier") {
              exportedNames.add(right.text);
              return;
            }
          }
          const funcy = right && FUNCTION_VALUE_TYPES.has(right.type);
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
              const doc = docCommentFor(node);
              emit({
                name,
                kind: right.type === "class" ? "class" : "function",
                file: rel,
                line: expr.startPosition.row + 1,
                endLine: expr.endPosition.row + 1,
                ...(ctx.parent ? { parent: ctx.parent } : {}),
                signature: declHeader(expr, content),
                ...(doc ? { doc } : {}),
                exported: !ctx.inFunctionBody && (nowExported || exportedAssign),
                lang: spec.lang,
              });
              return;
            }
          } else if (left?.type === "member_expression" && right) {
            // CJS named VALUE export — `exports.foo = 42`, `exports.foo = bar`:
            // emit `foo` as an exported const (ultradoc parity); when the RHS is
            // a bare identifier, mark that local declaration exported too (and
            // skip the emission when it would only duplicate the same name).
            const prop = left.childForFieldName("property");
            if (prop?.type === "property_identifier") {
              const obj = left.text.slice(0, left.text.length - prop.text.length - 1);
              if (obj === "exports" || obj === "module.exports") {
                if (right.type === "identifier") exportedNames.add(right.text);
                if (right.type !== "identifier" || right.text !== prop.text) {
                  emit({
                    name: prop.text,
                    kind: "const",
                    file: rel,
                    line: expr.startPosition.row + 1,
                    endLine: expr.endPosition.row + 1,
                    ...(ctx.parent ? { parent: ctx.parent } : {}),
                    signature: declHeader(expr, content),
                    exported: true,
                    lang: spec.lang,
                  });
                }
                return;
              }
            }
          }
        }
      }

      // Lua-flavored assignment definitions: `M.alias = function(z) … end` /
      // `local alias = function(y) … end` — an assignment_statement pairs a
      // `variable_list` of targets with an `expression_list` of values (fields
      // name/value, index-aligned). Only function-valued targets become
      // symbols, named after the full target text (dotted/colon names stay
      // whole — regex-tier parity).
      if (spec.assignments && type === "assignment_statement") {
        const vars = node.children.find((c) => c.type === "variable_list");
        const vals = node.children.find((c) => c.type === "expression_list");
        const targets = vars?.namedChildren ?? [];
        const values = vals?.namedChildren ?? [];
        const pairs = Math.min(targets.length, values.length);
        for (let i = 0; i < pairs; i++) {
          const target = targets[i]!;
          const value = values[i]!;
          if (value.type !== "function_definition" || !/^[\w.:]+$/.test(target.text)) continue;
          const header = declHeader(node, content);
          const doc = docCommentFor(node);
          emit({
            name: target.text,
            kind: "function",
            file: rel,
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            ...(ctx.parent ? { parent: ctx.parent } : {}),
            signature: header,
            ...(doc ? { doc } : {}),
            exported: visibilityOf(node, header, target.text, { ...ctx, exported: nowExported }),
            lang: spec.lang,
          });
        }
        return;
      }

      // A node type that qualifies what it holds with a type name: Rust's
      // `impl Scheduler`, and Go's method receiver.
      const qualifier = spec.parentFrom?.[type]?.(node);

      // A registered kind chooser is AUTHORITATIVE, like nameFrom: returning
      // undefined means "this node is not a declaration". Falling through to
      // `defs` here made every nested Terraform block (`lifecycle`, `ingress`)
      // a symbol, burying the resources that are ones.
      const chooser = spec.kindFrom?.[type];
      const kind = chooser ? chooser(node) : spec.defs[type];
      if (kind) {
        // A registered reader is AUTHORITATIVE: returning undefined means "this
        // node declares no name, skip it" — Go's embedded struct fields. Falling
        // back to the generic reader here would resurrect exactly the symbol the
        // override exists to suppress (`struct { Scheduler }` → a field named
        // Scheduler, colliding with the type it embeds).
        const reader = spec.nameFrom?.[type];
        const name = reader ? reader(node) : nameOf(node);

        // A DESTRUCTURING declaration binds several names at once
        // (`const { useTRPC, TRPCProvider } = …`, `const [a, b] = …`). The
        // generic reader returns the whole pattern's TEXT, so the index grew a
        // symbol literally named "{ useTRPC, TRPCProvider }" — worse than the
        // miss, because it is unsearchable and cites a name no source contains.
        // Emit each BOUND name instead. Found by the universal-ctags differential.
        const pattern = node.namedChildren.find((c) => c.type === "object_pattern" || c.type === "array_pattern");
        if (pattern && !ctx.inFunctionBody) {
          const header = declHeader(node, content);
          const doc = docOf(node);
          for (const bound of boundNames(pattern)) {
            emit({
              name: bound,
              kind,
              file: rel,
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              ...(ctx.parent ? { parent: ctx.parent } : {}),
              signature: header,
              ...(doc ? { doc } : {}),
              exported: visibilityOf(node, header, bound, { ...ctx, exported: nowExported }),
              lang: spec.lang,
            });
          }
          return;
        }
        // Inside executable code, only FUNCTION-like declarations are worth
        // indexing: emitting every `const x = 1` in every function body would
        // bury the API surface in locals.
        // A TYPE declared inside a function body is a declaration, not a local:
        // Rust's `fn outer() { struct Nested; }` and TypeScript's in-function
        // `interface`/`type` are real, referencable declarations. Only VALUE
        // bindings are locals, which is what this filter is for.
        const declaresFunction =
          FUNCTION_KINDS.has(kind) ||
          NESTED_TYPE_KINDS.has(kind) ||
          FUNCTION_VALUE_TYPES.has(node.childForFieldName("value")?.type ?? "");
        if (name && (!ctx.inFunctionBody || declaresFunction)) {
          const header = declHeader(node, content);
          const doc = docOf(node);
          const parent = qualifier ?? ctx.parent;
          const parentPath = qualifier ?? ctx.parentPath;
          emit({
            name,
            kind,
            file: rel,
            line: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            ...(parent ? { parent } : {}),
            ...(parentPath && parentPath !== parent ? { parentPath } : {}),
            signature: header,
            ...(doc ? { doc } : {}),
            exported: visibilityOf(node, header, name, { ...ctx, exported: nowExported }),
            lang: spec.lang,
          });
          collectRelations(node, name);
          const entersFunction = FUNCTION_KINDS.has(kind);
          walkBody(node, {
            parent: name,
            parentPath: parentPath ? `${parentPath}/${name}` : name,
            ownerKind: kind,
            exported: nowExported,
            forcePublic: PUBLIC_MEMBER_KINDS.has(kind),
            inFunctionBody: ctx.inFunctionBody || entersFunction,
            funcDepth: ctx.funcDepth + (entersFunction ? 1 : 0),
            sectionPublic: true,
          });
          return;
        }
      }

      // Not a named declaration: an `impl` block, a Ruby `include`, a Go
      // embedded field. These state relations about their ENCLOSING type.
      collectRelations(node, qualifier ?? ctx.parent);

      if (spec.containers.has(type)) {
        const forcePublic = ctx.forcePublic || spec.publicMembersIn?.[type]?.(node) === true;
        // A container can itself BE a function body without being a declaration:
        // an arrow or function expression passed as a callback. Crossing into one
        // must set the same context a named function's body does, or everything
        // declared inside a callback would inherit the enclosing `export` and read
        // as module API.
        const entersFunction = FUNCTION_VALUE_TYPES.has(type);
        walkChildren(node, {
          ...ctx,
          exported: nowExported,
          forcePublic,
          inFunctionBody: ctx.inFunctionBody || entersFunction,
          funcDepth: ctx.funcDepth + (entersFunction ? 1 : 0),
          ...(qualifier ? { parent: qualifier, parentPath: qualifier, ownerKind: "type" } : {}),
        });
      }
    };

    walkChildren(root, {
      exported: false,
      forcePublic: false,
      inFunctionBody: false,
      funcDepth: 0,
      sectionPublic: true,
    });
    if (exportedNames.size) {
      for (const s of symbols) if (!s.exported && exportedNames.has(s.name)) s.exported = true;
    }

    const wantImports = opts.imports !== false;
    const { refs, idents, calls, importedNames, terms } = collectAll(
      root,
      spec,
      new Set(symbols.map((s) => s.name)),
      opts.maxCalls ?? MAX_CALLS,
      wantImports,
    );
    let pkg: string | undefined;
    if (wantImports && spec.lang === "java") {
      const p = findFirst(root, (n) => n.type === "package_declaration");
      if (p) pkg = p.text.replace(/^package\s+/, "").replace(/;.*$/, "").trim();
    }
    relations.sort((a, b) => byStr(a.from, b.from) || byStr(a.kind, b.kind) || byStr(a.to, b.to));
    return {
      symbols,
      refs,
      pkg,
      idents,
      calls,
      importedNames,
      relations,
      terms,
      ...(symbols.length >= maxSymbols ? { truncated: true as const } : {}),
    };
  } catch {
    return undefined; // any parse/walk failure → regex fallback
  } finally {
    tree?.delete(); // free wasm-side memory every file (not GC'd otherwise)
  }
}
