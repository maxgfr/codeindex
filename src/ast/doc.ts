// The doc comment attached to a declaration — the single field that tells an
// agent WHY a symbol exists rather than only that it does.
//
// Before this, a `CodeSymbol` carried a name, a kind and a span. An agent reading
// `symbols_overview` on an unfamiliar file got a list of identifiers and had to
// open the file anyway; the sentence the author already wrote above each
// declaration was sitting in the tree, unread.
//
// Two shapes cover every language here: a run of comments ABOVE the declaration
// (JSDoc, `///` rustdoc, `//` godoc, `#`, javadoc, C# XML docs) and a string as
// the first statement INSIDE the body (Python docstrings).
import type { TSNode } from "./node.js";
import { stripCommentMarkers, summarizeDocLines } from "../extract/doc-text.js";

// Grammars name comments differently — `comment` (most), `line_comment` and
// `block_comment` (Rust, newer Java). Matching the suffix covers all of them,
// and any future grammar that follows the same convention.
const COMMENT_TYPE = /(^|_)comment$/;

// Nodes that sit BETWEEN a declaration and the comment written above it. The
// comment is a sibling of the wrapper, not of the declaration, so a naive
// previous-sibling walk finds nothing for the single most common case in JS/TS:
// an exported, documented function.
//
// Each entry is a shape a real grammar produces:
//   export_statement / ambient_declaration  `export function f` / `declare class C`
//   lexical_declaration / variable_declaration  `export const X = 1` — the
//       declarator is two levels below the comment
//   type_declaration / const_declaration / var_declaration  Go groups every
//       `type`/`const`/`var` spec under a declaration node, so godoc comments
//       (`// MaxAttempts bounds …`) are never a spec's own sibling
//   body_statement  tree-sitter-ruby HOISTS a body's leading comment out of the
//       body, making it a sibling of the body rather than of its first member
//   decorated_definition  a Python decorator sits between the two
const DOC_WRAPPERS = new Set([
  "export_statement",
  "ambient_declaration",
  "decorated_definition",
  "template_declaration",
  "labeled_statement",
  "lexical_declaration",
  "variable_declaration",
  "type_declaration",
  "const_declaration",
  "var_declaration",
  "body_statement",
]);

// The contiguous comment run immediately above `node`, oldest line first.
// "Contiguous" means no blank line: a comment separated from what follows
// belongs to neither, and attributing it would put a file header on whichever
// declaration happens to come first.
function commentLinesAbove(node: TSNode): string[] {
  const blocks: TSNode[] = [];
  let prev = node.previousNamedSibling;
  let nextRow = node.startPosition.row;
  while (prev && COMMENT_TYPE.test(prev.type)) {
    if (nextRow - prev.endPosition.row > 1) break;
    blocks.push(prev);
    nextRow = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  if (!blocks.length) return [];
  blocks.reverse();
  const lines: string[] = [];
  for (const b of blocks) for (const l of b.text.split(/\r?\n/)) lines.push(stripCommentMarkers(l));
  return lines;
}

/**
 * The doc comment for a declaration, or undefined when it has none. Climbs out
 * of transparent wrappers (`export …`, `declare …`, a decorator) so a documented
 * export is not treated as undocumented.
 */
export function docCommentFor(node: TSNode): string | undefined {
  let anchor: TSNode | null = node;
  while (anchor) {
    const lines = commentLinesAbove(anchor);
    if (lines.length) {
      const doc = summarizeDocLines(lines);
      if (doc) return doc;
    }
    const parent: TSNode | null = anchor.parent;
    if (!parent || !DOC_WRAPPERS.has(parent.type)) return undefined;
    anchor = parent;
  }
  return undefined;
}

/**
 * A Python-style docstring: the first string statement inside the declaration's
 * body. Checked before the comment-above form, because a language with
 * docstrings puts the real documentation there.
 */
export function docstringFor(node: TSNode): string | undefined {
  const body = node.childForFieldName("body");
  const first = body?.namedChildren[0];
  if (!first) return undefined;
  const str = first.type === "string" ? first : first.type === "expression_statement" ? first.namedChildren[0] : undefined;
  if (!str || str.type !== "string") return undefined;
  return summarizeDocLines(str.text.split(/\r?\n/).map(stripCommentMarkers));
}
