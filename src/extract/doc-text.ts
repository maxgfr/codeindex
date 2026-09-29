// Turning raw comment text into one useful sentence — the logic shared by the
// FILE summary (fileSummary below, line-based over raw content) and the
// per-SYMBOL doc comment (ast/doc.ts, node-based over comment siblings).
//
// Both need the same three things: strip whatever markers the language uses,
// discard lines that are tooling noise rather than prose, and reduce what's left
// to a first sentence. Keeping one copy is what stops the two from drifting into
// disagreeing about whether `/*! jQuery */` is a description.

// Tooling pragmas and boilerplate that are technically the first comment but say
// nothing about what the code does — never use them as a summary. Includes the
// magic comments that open whole ecosystems' files: Ruby's
// `frozen_string_literal`, Sorbet's `typed:`, an Emacs `-*- coding: utf-8 -*-`
// line (which was also becoming the doc of a module's first function), Go build
// constraints, a copyright line. An ESLint `global a, b` list is matched whole,
// so a doc that opens "Global registry of handlers." is still prose.
const DIRECTIVE_RE =
  /^(eslint\b|eslint-|prettier\b|prettier-|tslint\b|jshint\b|jslint\b|globals?\s+[\w$]+(?::\s*\w+)?(?:\s*,\s*[\w$]+(?::\s*\w+)?)*\s*$|istanbul\b|c8\s|v8\s|@ts-|ts-|@flow\b|@jsx\b|@jsxRuntime\b|@jest-environment\b|@vitest-environment\b|@preserve\b|@copyright\b|copyright\b|\(c\)\s*\d|©|spdx-|<reference\b|use strict|biome-|deno-lint|noqa\b|type:\s*ignore|pylint:|flake8:|mypy:|pyright:|ruff:|isort:|fmt:\s*(?:on|off|skip)\b|pragma(?::|\s+once\b|\s+mark\b)|coding[:=]|-\*-|encoding[:=]|frozen_string_literal:|typed:|rubocop:|go:(?:build|generate|embed)\b|\+build\b|nolint\b|shellcheck\b|swiftlint:|vim?:)/i;

export function isDirective(line: string): boolean {
  return DIRECTIVE_RE.test(line.trim());
}

// Banner noise inside an otherwise descriptive comment: a URL, "all rights
// reserved". Dropped line by line, like a directive.
const BANNER_RE = /^(all rights reserved\b|https?:\/\/|www\.)/i;

export function isBanner(line: string): boolean {
  return BANNER_RE.test(line.trim());
}

// The opening line of a paragraph of LEGAL text — each paragraph of the common
// license headers (MIT, BSD, ISC, Apache, GPL, MPL, and the Go/Chromium
// "governed by a BSD-style license" line). Filtering such lines one by one (the
// old rule) kept their continuations instead: 88 of gin's 100 files, and every
// file of leveldb, were summarized "Use of this source code is governed by a
// MIT style license that can be found in the LICENSE file.", which made
// "license" match the whole repo in search.
const LICENSE_RE = new RegExp(
  // An optional list marker first: BSD numbers its clauses ("1. Redistributions
  // of source code must retain …"), other headers bullet them.
  "^(?:[-*\u2022]|\\d+[.)])?\\s*[[(]?\\s*(?:" +
    [
      "@license\\b",
      "(?:the\\s+)?(?:mit|isc|bsd|apache|gnu|gpl|mpl|lgpl|agpl|mozilla\\s+public)\\s+licen[sc]ed?\\b",
      // "Licensed under the Apache License", "Released under the MIT license":
      // the license must be named on the line, so prose that merely continues
      // with "distributed under load" is not taken for legal text.
      "(?:released|distributed|licen[sc]ed)\\s+under\\b.*\\b(?:licen[sc]e|mit|bsd|gpl|apache|isc|mpl)\\b",
      "licen[sc]ed\\s+to\\b",
      "use of this source code is governed\\b",
      "permission is hereby granted\\b",
      "permission to use, copy\\b",
      "redistributions?\\s+(?:and use in|of source|in binary)\\b",
      "neither the name of\\b",
      "the above copyright notice\\b",
      "(?:this|the) (?:program|library|file|software|(?:source )?code|project|package) is (?:part of|licensed|distributed)\\b",
      // The warranty disclaimer: "THE SOFTWARE IS PROVIDED "AS IS"", "THIS
      // SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS", "THIS CODE IS PROVIDED ON
      // AN *AS IS* BASIS". Not "the code is provided as a fallback".
      "(?:this|the) (?:software|code|program|library|file|work) is provided\\s+(?:by\\b|on an\\b|[\"'*\u201c]*as[ -]is\\b)",
      "see (?:the\\s+)?(?:[\\w.-]+\\s+){0,4}licen[sc]e\\b",
      // GPL names the program: "GNU Foo is free software: you can redistribute it".
      "(?:[\\w.+-]+\\s+){1,4}is free software\\b",
      "this source code form is subject\\b",
      "unless required by applicable law\\b",
      "you (?:should have received a copy|may not use this file|may obtain a copy)\\b",
      "gnu (?:lesser |affero )?general public license\\b",
    ].join("|") +
    ")",
  "i",
);

export function isLicense(line: string): boolean {
  return LICENSE_RE.test(line.trim());
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
      // Section-divider rules (`// --- output schemas ------------`, a
      // `////// Worker APIs //////` banner) are layout, not prose: keep the
      // label, drop the ruling, so a divider above a declaration cannot pad its
      // doc with forty dashes.
      .replace(/[-=~_]{3,}|\/{3,}|\*{3,}|#{3,}/g, " ")
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
// undefined when nothing informative survives. `maxLen` caps the result;
// `minLen` is the shortest joined text worth keeping.
//
// Lines are filtered (directives, banners), joined, de-marked-up, then cut at
// the first sentence terminator. A block that opens with a tag line (`@param`,
// `@deprecated`) yields nothing rather than a fragment of structure, and
// license text never becomes a description.
export function summarizeDocLines(lines: string[], maxLen = MAX_DOC, minLen = 3): string | undefined {
  const kept: string[] = [];
  let legal = false; // inside a paragraph of license text
  for (const line of lines) {
    const t = line.trim();
    // License text runs to the end of its paragraph. After a description it
    // ends the doc (`jQuery v3.6.0`, then `Released under the MIT license`);
    // before one it is skipped, because a header often puts the file's own
    // description in the paragraph AFTER the license (leveldb's
    // "TableBuilder provides the interface used to build a Table"). Checked
    // before the tag and banner rules: `@license` is a tag, "MIT Licensed"
    // reads like a banner.
    if (!t) {
      legal = false;
      continue;
    }
    if (legal) continue;
    if (isLicense(t)) {
      if (kept.length) break;
      legal = true;
      continue;
    }
    if (isDirective(t) || isBanner(t)) continue;
    // Stop at the first block tag: everything after it is structured detail.
    if (/^@[a-z]/i.test(t)) break;
    kept.push(t);
  }
  const text = stripDocMarkup(kept.join(" "));
  if (text.length < minLen) return undefined;
  const sentence = /^(.*?[.!?])(\s|$)/.exec(text);
  return (sentence ? sentence[1]! : text).slice(0, maxLen);
}

// --- the file summary ---------------------------------------------------------

// Which leading lines are comments depends on the language. `//` and `/* */`
// read the same everywhere (no language starts a line with them otherwise).
// `#` is a comment only where the language says so: in C, C++, Objective-C, C#,
// Swift and Rust a leading `#` is a preprocessor line, a compiler directive or
// an attribute, and reading it as prose summarized C files as "include
// <stdio.h>" and headers as "pragma once Widget API.".
const HASH_COMMENT = new Set([
  ".py", ".pyi", ".rb", ".rake", ".sh", ".bash", ".zsh", ".ksh", ".fish",
  ".ex", ".exs", ".tf", ".tfvars", ".hcl", ".graphql", ".gql",
]);
const DASH_COMMENT = new Set([".lua", ".sql", ".hs", ".elm"]);
const DOCSTRING = new Set([".py", ".pyi"]);
const MARKUP = new Set([".vue", ".svelte", ".astro"]);

// Lines that may precede a file's opening comment without ending the search:
// a shebang, a Rust inner attribute (`#![…]`, above the `//!` crate docs), a
// header's `#pragma once` or include guard, a PHP open tag and its
// strict-types declaration, a JS/TS directive prologue (`"use client";`), a
// Haskell `{-# LANGUAGE … #-}` pragma, a component's `<script>` tag or Astro's
// `---` fence. Any other `#` line where `#` is no comment (`#include`,
// `#import`, `#if`, `#[derive]`) is code: a comment below it documents a
// declaration, not the file.
const PREAMBLE =
  /^(?:#!.*|#\s*pragma\s+once|#\s*(?:ifndef|define)\s+\w+|<\?php\b.*|declare\s*\(\s*strict_types\s*=\s*1\s*\)\s*;?|(["'])use [\w -]+\1;?|\{-#.*#-\}|<script\b[^>]*>|---)$/i;

// Block comment openers and what closes them.
const BLOCK_OPENERS: [open: string, close: string][] = [
  ["/*", "*/"],
  ["<!--", "-->"],
  ["--[[", "]]"],
  ["{-", "-}"],
  ['"""', '"""'],
  ["'''", "'''"],
];

// A JSDoc file-level tag introduces the file's description rather than
// structured detail; keep its text.
const FILE_TAG = /^@(?:file|fileoverview|overview|desc|description)\b\s*/i;

// Xcode's file template opens every Swift and Objective-C file with the file's
// name, the project's name and "Created by NAME on DATE." — a stamp, not a
// description, so everything up to it is dropped.
const XCODE_STAMP = /^created by\b.*\bon\s+\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\.?$/i;

const MAX_SUMMARY_LINES = 60;
const MAX_SUMMARY = 200;
const MIN_SUMMARY = 8;

// One comment line's prose: markup comment and Lua/Haskell block delimiters,
// then the markers every language shares, then a Haddock `-- |` marker. An
// editor folding marker (`//#region src/utils.ts`, as bundlers emit) is none.
function proseOf(line: string): string {
  if (/^\/\/\s*#(?:end)?region\b/.test(line)) return "";
  return stripCommentMarkers(
    line.replace(/^(?:<!--+|--\[=*\[|\{-\|?)/, "").replace(/(?:-+->|\]=*\]|-\})\s*$/, ""),
  )
    .replace(/^\|(?:\s+|$)/, "")
    .replace(FILE_TAG, "");
}

// The file's own description, from its leading comments: the first comment
// block that says something, past blocks that are only directives or license
// text and past the PREAMBLE lines. Stops at the first line of code.
export function fileSummary(ext: string, content: string): string | undefined {
  const hash = HASH_COMMENT.has(ext);
  const dash = DASH_COMMENT.has(ext);
  const openers = BLOCK_OPENERS.filter(
    ([open]) =>
      open === "/*" ||
      (open === "<!--" && MARKUP.has(ext)) ||
      (open === "--[[" && ext === ".lua") ||
      (open === "{-" && ext === ".hs") ||
      (open.length === 3 && DOCSTRING.has(ext)),
  );
  let block: string[] = [];
  let close: string | undefined; // set while inside a block comment
  const flush = (): string | undefined => {
    if (!block.length) return undefined;
    const lines = block.map(proseOf);
    block = [];
    const stamp = lines.findIndex((l) => XCODE_STAMP.test(l));
    return summarizeDocLines(stamp === -1 ? lines : lines.slice(stamp + 1), MAX_SUMMARY, MIN_SUMMARY);
  };
  let at = 0;
  for (let n = 0; n < MAX_SUMMARY_LINES && at <= content.length; n++) {
    const nl = content.indexOf("\n", at);
    const line = content.slice(at, nl === -1 ? content.length : nl).trim();
    at = nl === -1 ? content.length + 1 : nl + 1;
    if (close !== undefined) {
      const end = line.indexOf(close);
      block.push(end === -1 ? line : line.slice(0, end + close.length));
      if (end === -1) continue;
      close = undefined;
      const summary = flush();
      if (summary) return summary;
      continue;
    }
    const lineComment =
      line.startsWith("//") ||
      (hash && line.startsWith("#") && !(n === 0 && line.startsWith("#!"))) ||
      (dash && line.startsWith("--") && !line.startsWith("--[["));
    if (lineComment) {
      block.push(line);
      continue;
    }
    // Anything else ends a run of line comments.
    const pending = flush();
    if (pending) return pending;
    if (line === "" || PREAMBLE.test(line)) continue;
    const opener = openers.find(([open]) => line.startsWith(open));
    if (opener) {
      const [open, closer] = opener;
      const end = line.indexOf(closer, open.length);
      if (end === -1) {
        block.push(line);
        close = closer;
        continue;
      }
      block.push(line.slice(0, end + closer.length));
      const summary = flush();
      if (summary) return summary;
      continue;
    }
    return undefined; // the first line of code
  }
  return flush();
}
