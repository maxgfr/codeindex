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
import type { TSNode } from "./node.js";

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
]);

const MAX_SIGNATURE = 400;

// Where this declaration's body starts, or undefined when it has none (an
// interface method, an abstract declaration, a `;`-terminated field).
//
// Searched two levels deep, not just among direct children: Go wraps the body
// one level down (`type_spec` → `struct_type` → `field_declaration_list`), so a
// direct-children-only probe would find nothing and fall back to the node's
// whole text — dumping every struct field into the struct's signature.
function bodyStart(node: TSNode): number | undefined {
  const byField = node.childForFieldName("body");
  let best = byField && byField.startIndex > node.startIndex ? byField.startIndex : undefined;
  const consider = (n: TSNode): void => {
    if (BODY_TYPES.has(n.type) && n.startIndex > node.startIndex && (best === undefined || n.startIndex < best)) {
      best = n.startIndex;
    }
  };
  for (const c of node.namedChildren) {
    consider(c);
    for (const g of c.namedChildren) consider(g);
  }
  return best;
}

// The complete declaration header: whitespace collapsed to single spaces so a
// wrapped parameter list reads as one line, a trailing body-opener dropped, and
// capped. Deterministic — a pure function of the node's byte range and `src`.
export function declHeader(node: TSNode, src: string): string {
  const end = bodyStart(node) ?? node.endIndex;
  return src
    .slice(node.startIndex, end)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*(?:\{|=>|=)$/, "")
    .trim()
    .slice(0, MAX_SIGNATURE);
}
