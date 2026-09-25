// The names an import statement binds that a call site or a base-class list
// uses INSTEAD of the declaration's own name — what the call binder needs to
// see `salute("a")` as a call to `greet`, `ft.cast(...)` as a call into the
// `typing` module, or `class Blueprint(SansioBlueprint)` as extending
// `Blueprint`.
//
// Kept apart from collectAll: imports sit at the top of a module (Python's may
// sit under a top-level `if`/`try`), so a shallow walk over the root reads them
// all without touching the one-pass visitor.
import type { ImportAlias } from "../types.js";
import { byStr } from "../sort.js";
import type { TSNode } from "./node.js";

const MAX_ALIASES = 256;

// Python statements that hold module-level code without opening a new scope —
// `if TYPE_CHECKING:`, `try: … except ImportError:` — where imports routinely sit.
const PY_TOP_BLOCKS = new Set([
  "if_statement", "elif_clause", "else_clause", "try_statement", "except_clause",
  "finally_clause", "with_statement", "block",
]);

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

// JS/TS: `import d, { a as b } from "s"`, `import * as ns from "s"`, and the
// module's own `export default X` (recorded as `default` → X, without `from`,
// so a default import elsewhere can find the declaration it denotes).
function readJs(node: TSNode, out: ImportAlias[]): void {
  if (node.type === "import_statement") {
    const source = node.childForFieldName("source");
    if (!source) return;
    const from = unquote(source.text);
    for (const clause of node.namedChildren) {
      if (clause.type !== "import_clause") continue;
      for (const part of clause.namedChildren) {
        if (part.type === "identifier") out.push({ local: part.text, name: "default", from });
        else if (part.type === "namespace_import") {
          const id = part.namedChildren.find((c) => c.type === "identifier");
          if (id) out.push({ local: id.text, name: "*", from });
        } else if (part.type === "named_imports") {
          for (const spec of part.namedChildren) {
            if (spec.type !== "import_specifier") continue;
            const name = spec.childForFieldName("name")?.text;
            const alias = spec.childForFieldName("alias")?.text;
            // An un-renamed specifier already reaches the call binder as
            // FileRecord.importedNames; only a rename needs recording.
            if (name && alias && alias !== name) out.push({ local: alias, name: unquote(name), from });
          }
        }
      }
    }
  } else if (node.type === "export_statement" && node.children.some((c) => c.type === "default")) {
    const decl = node.childForFieldName("declaration");
    const name = decl ? decl.childForFieldName("name")?.text : node.childForFieldName("value")?.type === "identifier" ? node.childForFieldName("value")!.text : undefined;
    // An anonymous default is named after the file stem by the declaration walk;
    // the binder falls back to that name, so nothing needs recording for it.
    if (name) out.push({ local: "default", name });
  }
}

// Python: `import a.b [as c]` binds a MODULE (`a`, or `c`); `from m import x
// as y` renames a name — or a submodule, which only resolution can tell apart.
// An un-renamed `from m import x` binds `x` under its own name: nothing to map.
function readPython(node: TSNode, out: ImportAlias[]): void {
  if (node.type === "import_statement") {
    for (const part of node.namedChildren) {
      if (part.type === "dotted_name") {
        // `import a.b.c` binds only the root `a`, to the package `a`.
        const root = part.namedChildren[0]?.text;
        if (root) out.push({ local: root, name: "*", from: root });
      } else if (part.type === "aliased_import") {
        const from = part.childForFieldName("name")?.text;
        const alias = part.childForFieldName("alias")?.text;
        if (from && alias) out.push({ local: alias, name: "*", from });
      }
    }
  } else if (node.type === "import_from_statement") {
    const from = node.childForFieldName("module_name")?.text;
    if (!from) return;
    for (const part of node.namedChildren) {
      if (part.type !== "aliased_import") continue;
      const name = part.childForFieldName("name")?.text;
      const alias = part.childForFieldName("alias")?.text;
      // `from .app import Flask as Flask` is PEP 484's re-export marker, not a
      // rename (the declaration walk reports it as a `reexport` symbol).
      if (name && alias && alias !== name) out.push({ local: alias, name, from });
    }
  } else if (PY_TOP_BLOCKS.has(node.type)) {
    for (const c of node.namedChildren) readPython(c, out);
  }
}

// Go: only an EXPLICIT package name (`foo "x/bar"`) is recorded — the implicit
// one is the package's own name, which the binder reads off the imported
// package. The blank (`_`) and dot (`.`) forms bind no qualifier.
function readGo(node: TSNode, out: ImportAlias[]): void {
  if (node.type === "import_declaration" || node.type === "import_spec_list") {
    for (const c of node.namedChildren) readGo(c, out);
  } else if (node.type === "import_spec") {
    const name = node.childForFieldName("name");
    const path = node.childForFieldName("path");
    if (name?.type === "package_identifier" && path) out.push({ local: name.text, name: "*", from: unquote(path.text) });
  }
}

/** The import aliases a file's top level binds, deduped and sorted (local, name, from). */
export function readImportAliases(root: TSNode, lang: string): ImportAlias[] {
  const read =
    lang === "typescript" || lang === "javascript" ? readJs : lang === "python" ? readPython : lang === "go" ? readGo : undefined;
  if (!read) return [];
  const found: ImportAlias[] = [];
  for (const node of root.namedChildren) read(node, found);
  const seen = new Set<string>();
  const out: ImportAlias[] = [];
  for (const a of found.sort((x, y) => byStr(x.local, y.local) || byStr(x.name, y.name) || byStr(x.from ?? "", y.from ?? ""))) {
    const key = `${a.local}\u0000${a.name}\u0000${a.from ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}
