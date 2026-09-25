import type { RawRef } from "../types.js";
import type { MarkdownInfo } from "./markdown.js";

// reStructuredText, the format of Sphinx (the Python ecosystem's default docs
// tool): title, section headings, a summary and local doc links, the same
// fields extractMarkdown gives a markdown file. Before this every .rst file was
// indexed under its file name only, so none of flask's 79 docs had a heading,
// a summary or a link, and a search for "application factory" missed the page
// titled "Application Factories". A line scanner, deterministic and
// dependency-free, like the markdown one.

// A section adornment: one punctuation character repeated to the line's end.
const ADORNMENT = /^([!-/:-@[-`{-~])\1+\s*$/;

// Is `under` an adornment long enough to underline `text`? docutils accepts a
// short one with a warning, but a two- or three-character line under a
// paragraph (`::`, `..`) is markup, not a title.
function underlines(under: string, text: string): boolean {
  if (!ADORNMENT.test(under)) return false;
  const width = under.trimEnd().length;
  return width >= [...text.trim()].length || width >= 4;
}

// Inline markup reduced to its text: ``code``, *emphasis*, **strong**, a role
// (`:doc:`Title <target>``, `:func:`~pkg.mod.name`` shows "name", a bare
// `:doc:` its document's name), a link
// (`` `text <url>`_ ``, `` `text`_ ``) and a substitution (`|name|`).
function cleanInline(text: string): string {
  return text
    .replace(/``([^`]+)``/g, "$1")
    .replace(/:[\w:.+-]+:`([^`<]*?)\s*<[^`>]*>`/g, "$1")
    // A bare `:doc:` shows the target's title, which only that file has; its
    // name is the closest text at hand.
    .replace(/:doc:`([^`]*)`/g, (_m, t: string) => t.slice(t.lastIndexOf("/") + 1))
    .replace(/:[\w:.+-]+:`!?~?([^`]*)`/g, (_m, t: string) => (t.startsWith("~") ? t.slice(t.lastIndexOf(".") + 1) : t))
    .replace(/`([^`<]*?)\s*<[^`>]*>`__?/g, "$1")
    .replace(/`([^`]+)`__?/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\|([^|\s][^|]*)\|/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// A Sphinx document name as a doc-link spec. A relative name is relative to
// the linking file, as resolveDocLink reads every spec. An absolute one
// (`/patterns/appfactories`) is relative to the Sphinx source directory, which
// only conf.py's location says: each ancestor of the file is tried as that
// directory, as soft refs, which become an edge only where the file exists.
function docnameRefs(rel: string, name: string, ext: string, out: (ref: RawRef) => void): void {
  const target = name.trim();
  // An intersphinx target (`werkzeug:test`), a URL, a glob pattern or `self`
  // names no file of this repo.
  if (!target || target === "self" || /[:*?[\]\s]/.test(target)) return;
  if (!target.startsWith("/")) {
    out({ kind: "doc-link", spec: target + ext });
    return;
  }
  const depth = rel.split("/").length - 1;
  for (let up = 0; up <= depth; up++) {
    out({ kind: "doc-link", spec: "../".repeat(up) + target.slice(1) + ext, soft: true });
  }
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

const DIRECTIVE = /^(\s*)\.\.\s+([\w:-]+)::\s*(.*)$/;
const DOC_ROLE = /:doc:`(?:[^`<]*<([^`>]+)>|([^`]+))`/g;
// Directives whose body is code or math, where a `:doc:` is text, not a link.
const VERBATIM = new Set([
  "code-block", "code", "sourcecode", "literalinclude", "doctest", "testcode", "testoutput", "testsetup",
  "testcleanup", "ipython", "math", "raw", "graphviz", "productionlist", "highlight", "jinja",
]);

export function extractRst(rel: string, content: string): MarkdownInfo {
  const lines = content.split(/\r?\n/);
  const headings: string[] = [];
  let title: string | undefined;
  let summary: string | undefined;
  // Heading levels are the order in which adornment styles first appear. The
  // summary comes from the document's intro: once a second-level section
  // starts, a later paragraph belongs to that section.
  const styles: string[] = [];
  let summaryClosed = false;

  const refs: RawRef[] = [];
  const seen = new Set<string>();
  const addRef = (ref: RawRef): void => {
    const key = `${ref.soft ? "~" : ""}${ref.spec}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  const heading = (style: string, text: string): void => {
    let level = styles.indexOf(style);
    if (level === -1) level = styles.push(style) - 1;
    const clean = cleanInline(text);
    headings.push(clean);
    if (!title) title = clean;
    if (level > 0 && !summary) summaryClosed = true;
  };
  const blank = (i: number): boolean => !(lines[i] ?? "").trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Over- and underlined title: the text may be inset, the two lines match.
    if (ADORNMENT.test(line) && lines[i + 1]?.trim() && lines[i + 2]?.trimEnd() === line.trimEnd()) {
      if (!ADORNMENT.test(lines[i + 1]!)) {
        heading(`${line[0]}${line[0]}`, lines[i + 1]!);
        i += 2;
        continue;
      }
    }
    // Underlined title: the text starts in column 0, after a blank line.
    if (line.trim() && !/^\s/.test(line) && !ADORNMENT.test(line) && (i === 0 || blank(i - 1))) {
      const under = lines[i + 1];
      if (under !== undefined && underlines(under, line)) {
        heading(under[0]!, line);
        i++;
        continue;
      }
    }

    const directive = DIRECTIVE.exec(line);
    if (directive) {
      const [, indent, name, arg] = directive;
      if (name === "include" || name === "literalinclude") {
        const path = arg!.trim();
        if (path.startsWith("/")) docnameRefs(rel, path, "", addRef);
        else if (path && !path.startsWith("<")) addRef({ kind: "doc-link", spec: path });
      }
      // The directive's body: every following line that is blank or indented
      // deeper than the directive. A toctree's body lists document names.
      let j = i + 1;
      for (; j < lines.length; j++) {
        const body = lines[j]!;
        if (body.trim() && indentOf(body) <= indent!.length) break;
        if (name === "toctree") {
          const entry = body.trim();
          if (!entry || entry.startsWith(":")) continue;
          const titled = /<([^<>]+)>\s*$/.exec(entry);
          docnameRefs(rel, titled ? titled[1]! : entry, ".rst", addRef);
        } else if (!VERBATIM.has(name!)) docRoles(body);
      }
      i = j - 1;
      continue;
    }
    // A comment (`.. text`), a link target (`.. _name: url`) or a substitution
    // definition, with its indented continuation.
    if (/^\s*\.\.(?:\s|$)/.test(line)) {
      i = skipBlock(i);
      continue;
    }

    docRoles(line);
    if (!summary && !summaryClosed && isParagraphStart(i)) summary = summaryAt(i);
    // `text::` ends a paragraph that introduces a literal block: the indented
    // lines after it are code.
    if (/::\s*$/.test(line)) i = skipBlock(i);
  }

  return { title, summary, headings, refs };

  function docRoles(text: string): void {
    for (const m of text.matchAll(DOC_ROLE)) docnameRefs(rel, m[1] ?? m[2]!, ".rst", addRef);
  }

  // The last line of the block below line `i`: blank lines and lines indented
  // deeper than it.
  function skipBlock(i: number): number {
    const indent = indentOf(lines[i]!);
    while (i + 1 < lines.length && (blank(i + 1) || indentOf(lines[i + 1]!) > indent)) i++;
    return i;
  }

  function isParagraphStart(i: number): boolean {
    const line = lines[i]!;
    return !!line.trim() && !/^\s/.test(line) && (i === 0 || blank(i - 1));
  }

  // The summary: the first sentence of the intro's first plain paragraph, in
  // column 0 — not a list, a table, a field list (`:orphan:`), a quote or
  // literal block (indented). A paragraph that is only a lead-in to a list or
  // a code block (one clause ending in `:`) says nothing yet; one that opens
  // with a full sentence does ("Applications fail, servers fail. … errors:").
  function summaryAt(i: number): string | undefined {
    if (/^(?:[-*+•]\s|#\.\s|\d+[.)]\s|\(?[a-z0-9]\)\s|[+=|]|:[^:\s][^:]*:(?:\s|$))/i.test(lines[i]!)) return undefined;
    const para: string[] = [];
    for (let j = i; j < lines.length && !blank(j) && !/^\s/.test(lines[j]!); j++) para.push(lines[j]!.trim());
    const text = cleanInline(para.join(" "));
    const sentence = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1] ?? (text.endsWith(":") ? "" : text);
    if (sentence.length < 8 || !/[A-Za-zÀ-ɏ]{3,}/.test(sentence)) return undefined;
    return sentence.slice(0, 200);
  }
}
