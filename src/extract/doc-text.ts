// Turning raw comment text into one useful sentence — the logic shared by the
// FILE summary (extract/code.ts topDocComment, line-based over raw content) and
// the per-SYMBOL doc comment (ast/doc.ts, node-based over comment siblings).
//
// Both need the same three things: strip whatever markers the language uses,
// discard lines that are tooling noise rather than prose, and reduce what's left
// to a first sentence. Keeping one copy is what stops the two from drifting into
// disagreeing about whether `/*! jQuery */` is a description.

// Tooling pragmas and boilerplate that are technically the first comment but say
// nothing about what the code does — never use them as a summary.
const DIRECTIVE_RE =
  /^(eslint\b|eslint-|prettier\b|prettier-|tslint\b|jshint\b|jslint\b|globals?\b|istanbul\b|c8\s|v8\s|@ts-|ts-|@flow\b|@jsx\b|@jsxRuntime\b|@jest-environment\b|@vitest-environment\b|@license\b|@preserve\b|@copyright\b|copyright\b|spdx-|<reference\b|use strict|biome-|deno-lint|noqa\b|type:\s*ignore|pylint:|flake8:|mypy:|coding[:=])/i;

export function isDirective(line: string): boolean {
  return DIRECTIVE_RE.test(line.trim());
}

// License / banner boilerplate common in minified-library preambles (the `/*!`
// "preserve" banner of Express, jQuery, Bootstrap, Lodash, moment, …): a license
// name or a "released under"/URL line, not a description of what the file does.
// "Copyright" and "@license" are already caught by DIRECTIVE_RE.
const BANNER_RE =
  /^((?:mit|isc|bsd|apache|gnu|gpl|mpl|lgpl|agpl)\s+licen[sc]ed?\b|licen[sc]ed\b|(?:released|distributed)\s+under\b|all rights reserved\b|https?:\/\/|www\.)/i;

export function isBanner(line: string): boolean {
  return BANNER_RE.test(line.trim());
}

// Strip every comment marker a supported language can put around prose, from ONE
// line: `///`, `//!`, `//`, `#`, `--`, `/**`, `/*!`, `/*`, a leading `*`
// continuation, a closing `*/`, and python/elixir triple quotes. The closing
// delimiter goes BEFORE the leading stars, so a line ending in `*/` cannot leave
// a stray "/" once its leading star is gone.
export function stripCommentMarkers(raw: string): string {
  return (
    raw
      .replace(/\*+\/\s*$/, "")
      .replace(/^\s*\/\*+!?/, "")
      .replace(/^\s*\/\/[/!]?/, "")
      .replace(/^\s*--+/, "")
      .replace(/^\s*#+/, "")
      .replace(/^\s*\*+/, "")
      .replace(/^\s*(?:"""|''')/, "")
      .replace(/(?:"""|''')\s*$/, "")
      // Section-divider rules (`// --- output schemas ------------`) are layout,
      // not prose: keep the label, drop the ruling, so a divider above a
      // declaration cannot pad its doc with forty dashes.
      .replace(/[-=~_]{3,}/g, " ")
      .trim()
  );
}

// Documentation markup that carries no prose of its own. XML doc comments (C#,
// and the `<summary>` style Java/VB also use) would otherwise contribute their
// tag names to the summary; `@param`/`@returns` blocks are structure, not
// description, and belong after the sentence we keep.
function stripDocMarkup(text: string): string {
  return text
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_DOC = 300;

// Reduce already-stripped comment lines to a single summary sentence, or
// undefined when nothing informative survives. `maxLen` caps the result.
//
// Lines are filtered (directives, banners), joined, de-marked-up, then cut at
// the first sentence terminator. A block that opens with a tag line (`@param`,
// `@deprecated`) yields nothing rather than a fragment of structure.
export function summarizeDocLines(lines: string[], maxLen = MAX_DOC): string | undefined {
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || isDirective(t) || isBanner(t)) continue;
    // Stop at the first block tag: everything after it is structured detail.
    if (/^@[a-z]/i.test(t)) break;
    kept.push(t);
  }
  const text = stripDocMarkup(kept.join(" "));
  if (text.length < 3) return undefined;
  const sentence = /^(.*?[.!?])(\s|$)/.exec(text);
  return (sentence ? sentence[1]! : text).slice(0, maxLen);
}
