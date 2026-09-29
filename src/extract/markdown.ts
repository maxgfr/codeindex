import type { RawRef } from "../types.js";

export interface MarkdownInfo {
  title?: string;
  summary?: string;
  headings: string[];
  refs: RawRef[]; // doc-link refs (local relative targets only)
}

// Blank out code blocks so links/headings inside them are not mistaken for
// real content. Replaces them with blank lines to preserve line-based
// scanning elsewhere.
//
// Fenced blocks (``` … ``` and ~~~ … ~~~) close only on a fence of the same
// character at least as long as the opening one, with nothing after it: a
// ````-fenced example that shows a ```-fenced one is one block, not two with
// live markdown between them.
//
// Indented blocks (four spaces or a tab, after a blank line) are code too, but
// only outside a list, where that indentation is how a list item continues.
function stripCode(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let fence: RegExp | null = null; // what closes the open fenced block
  let inList = false;
  let indented = false; // inside an indented code block
  let prevBlank = true;
  for (const line of lines) {
    if (fence) {
      if (fence.test(line)) fence = null;
      out.push("");
      continue;
    }
    // At any indentation: a fence nested in a list item is indented as deep as
    // the item's content, often with a tab.
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      fence = new RegExp(`^\\s*${m[1]![0]}{${m[1]!.length},}\\s*$`);
      indented = false;
      prevBlank = false;
      out.push("");
      continue;
    }
    const blank = !line.trim();
    const deep = /^(?: {4}|\t)/.test(line);
    if (indented && (blank || deep)) {
      out.push("");
      continue;
    }
    indented = false;
    if (deep && prevBlank && !inList) {
      indented = true;
      out.push("");
      continue;
    }
    if (!blank) {
      if (/^ {0,3}(?:[-*+]|\d+[.)])(?:\s|$)/.test(line)) inList = true;
      // After a blank line, text back at the margin has left the list.
      else if (prevBlank && !/^\s/.test(line)) inList = false;
    }
    prevBlank = blank;
    out.push(line);
  }
  return out.join("\n");
}

// A link target is "external" (not a graph edge candidate) when it is a URL, a
// mail/other scheme, protocol-relative, or a pure in-page anchor.
function isExternalTarget(spec: string): boolean {
  if (!spec) return true;
  if (spec.startsWith("#")) return true;
  if (spec.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(spec); // http:, https:, mailto:, tel:, data:, …
}

// One line of human-meaningful prose for the summary: drop images/badges
// ENTIRELY (so a badge-only line yields nothing, not its alt text), keep link
// text, strip emphasis, collapse whitespace.
function cleanProse(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images/badges → removed, not kept as alt
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Does a cleaned line carry actual prose (a word with letters), or is it just
// punctuation/leftovers from a badge row?
function hasProse(s: string): boolean {
  return /[A-Za-zÀ-ɏ]{3,}/.test(s);
}

// Generic doc-template boilerplate that says nothing about THIS project.
function isBoilerplate(s: string): boolean {
  return /^(all notable changes to this project|in the interest of fostering|this project adheres to|we as members and leaders|table of contents)\b/i.test(s);
}

// A setext underline, and the lines it can underline: text that is not already
// a block of another kind. A `---` under a blank line, a list item or a quote
// is a thematic break, not a heading.
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
function isParagraphLine(line: string): boolean {
  const t = line.trim();
  return !!t && !/^ {4}|^\t/.test(line) && !/^([-*+]|\d+[.)])(\s|$)/.test(t) && !/^[>|<]/.test(t);
}

const ALERT = /^>\s*\[!(?:note|tip|important|warning|caution)\]\s*$/i;

// Extract title, section headings, a one-line summary, and local doc-link refs
// from a markdown document. Deterministic and dependency-free.
export function extractMarkdown(content: string): MarkdownInfo {
  let body = content;
  let frontTitle: string | undefined;

  // Strip a leading YAML frontmatter block, capturing a `title:` if present.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    const t = /(^|\n)title:\s*["']?(.+?)["']?\s*(\n|$)/i.exec(fm[1]!);
    if (t) frontTitle = t[2]!.trim();
    body = body.slice(fm[0].length);
  }

  const scan = stripCode(body);
  const lines = scan.split(/\r?\n/);

  const headings: string[] = [];
  let title: string | undefined = frontTitle;
  let summary: string | undefined;
  // The summary must come from the document's own intro — once a level-2+
  // section starts, a later paragraph belongs to that sub-section, not the doc.
  let summaryClosed = false;
  const heading = (level: number, raw: string): void => {
    const text = cleanProse(raw);
    headings.push(text);
    if (!title && level === 1) title = text;
    if (!summary && level >= 2) summaryClosed = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      heading(h[1]!.length, h[2]!);
      continue;
    }
    // A setext heading: a line of text underlined with `=` (level 1) or `-`
    // (level 2), the style of many older READMEs and of pandoc's output. The
    // text line would otherwise be the summary, and the heading missing.
    const under = SETEXT.exec(lines[i + 1] ?? "");
    if (under && isParagraphLine(line)) {
      heading(under[1]![0] === "=" ? 1 : 2, line.trim());
      i++;
      continue;
    }
    const t = line.trim();
    // A GitHub alert (`> [!NOTE]`) is a call-out — a deprecation, a warning —
    // never the document's description. Its whole quote is skipped.
    if (ALERT.test(t)) {
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith(">")) i++;
      continue;
    }
    if (!summary && !summaryClosed) {
      // First real prose paragraph: not a heading, list bullet, table, html or blank.
      if (t && !/^([-*+]|\d+\.)\s/.test(t) && !t.startsWith("|") && !t.startsWith("<")) {
        const cleaned = cleanProse(t);
        // Reject list lead-ins ("Exemple :", "Nous avons :") and known boilerplate.
        if (cleaned.length >= 8 && hasProse(cleaned) && !cleaned.endsWith(":") && !isBoilerplate(cleaned)) {
          summary = cleaned.slice(0, 200);
        }
      }
    }
  }

  // Local doc-link refs: inline `[t](target)` / `![a](target)` plus
  // reference-style definitions `[id]: target`. External/anchor targets dropped.
  const refs: RawRef[] = [];
  const seen = new Set<string>();
  const addRef = (raw: string) => {
    let spec = raw.trim();
    // Strip an optional `"title"` after the URL in `](url "title")`.
    spec = spec.replace(/\s+["'(].*$/, "").trim();
    spec = spec.replace(/^<|>$/g, "");
    if (isExternalTarget(spec)) return;
    if (seen.has(spec)) return;
    seen.add(spec);
    refs.push({ kind: "doc-link", spec });
  };
  const inline = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(scan))) addRef(m[1]!);
  const refdef = /^\s*\[[^\]]+\]:\s+(\S+)/gm;
  while ((m = refdef.exec(scan))) addRef(m[1]!);

  return { title, summary, headings, refs };
}
