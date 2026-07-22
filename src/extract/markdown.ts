import type { RawRef } from "../types.js";

export interface MarkdownInfo {
  title?: string;
  summary?: string;
  headings: string[];
  refs: RawRef[]; // doc-link refs (local relative targets only)
}

// Strip fenced code blocks (``` … ``` and ~~~ … ~~~) so links/headings inside
// them are not mistaken for real content. Replaces them with blank lines to
// preserve line-based scanning elsewhere.
function stripFences(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (m && line.trim().startsWith(fence[0]![0]!.repeat(3).slice(0, 3))) fence = null;
      out.push("");
      continue;
    }
    if (m) {
      fence = m[1]!;
      out.push("");
      continue;
    }
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

  const scan = stripFences(body);
  const lines = scan.split(/\r?\n/);

  const headings: string[] = [];
  let title: string | undefined = frontTitle;
  let summary: string | undefined;
  // The summary must come from the document's own intro — once a level-2+
  // section starts, a later paragraph belongs to that sub-section, not the doc.
  let summaryClosed = false;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const text = cleanProse(h[2]!);
      headings.push(text);
      if (!title && h[1]!.length === 1) title = text;
      if (!summary && h[1]!.length >= 2) summaryClosed = true;
      continue;
    }
    if (!summary && !summaryClosed) {
      const t = line.trim();
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
