import type { FileRecord } from "../types.js";
import { maskJs } from "./imports.js";

// Build output committed under an ordinary name: minified code not called
// `*.min.js` (the walk skips that one by name) and bundles. Either otherwise
// goes through full extraction as if someone wrote it. A minified file yields
// hundreds of one- and two-letter symbols (`zf`, `O`, `lo`), thousands of call
// sites between them, and a parse that costs more than the rest of the repo's
// files together. A bundle redefines every function of the sources it was built
// from: this repo's own scripts/engine.mjs redefined 958 names of src/, so a
// call no import explains could no longer be bound to its one definition, and
// find-symbol and dead code answered twice. extractCode
// keeps such a file in the index (path, summary, imports) but extracts nothing
// else, and flags the record `generated` with the reason.
//
// Only the JS extensions: minifiers and bundlers emit `.js`/`.mjs`/`.cjs`, and
// a `.ts` or `.jsx` file is source by construction.
const BUILD_EXTS = new Set([".js", ".mjs", ".cjs"]);

export type GeneratedKind = NonNullable<FileRecord["generated"]>;

// Why a file is build output, or undefined for source. A pure function of the
// extension and the bytes, so the flag is as deterministic as extraction.
export function generatedKind(ext: string, content: string): GeneratedKind | undefined {
  if (!BUILD_EXTS.has(ext)) return undefined;
  if (isMinified(ext, content)) return "minified";
  if (isBundle(ext, content)) return "bundle";
  return undefined;
}

// A line is minified code when it holds at least LONG_LINE code characters,
// with little whitespace between them and the punctuation of statements.
// Measured on the MASK (extract/imports.ts), so string, template, regex and
// comment text never counts: a long base64 or SVG literal, a long message or a
// long regex is data on an ordinary line, not minification.
//
// Calibrated on ~15k JS files (node_modules of this repo, the TypeScript repo's
// compiled baselines, this repo's own bundles). Minifiers wrap at 500 bytes
// (uglify's default, lodash.min.js) or never, so 300 code characters catches
// both while hand-written code, even unformatted, stays far below. Minified
// lines have 1-5 whitespace runs per 100 code characters; compiled and
// hand-written code with long lines (tsc's inlined helpers, JSX transforms)
// has 10 or more. A one-line numeric table (`[4,52,65,…]`) has neither
// statements nor calls, so it is data, not code: the `;{}(` count rejects it
// and the file's functions stay indexed.
const LONG_LINE = 300;
const MAX_GAPS_PER_100 = 6;
const MIN_PUNCT_PER_100 = 1;

const SEMI = 59;
const LPAREN = 40;
const LBRACE = 123;
const RBRACE = 125;

// True when at least half of a JS file's code characters sit on minified lines.
export function isMinified(ext: string, content: string): boolean {
  if (!BUILD_EXTS.has(ext)) return false;
  // Cheap exit for the common case: no physical line long enough to qualify.
  let longest = 0;
  for (let at = 0; at < content.length && longest < LONG_LINE; ) {
    const nl = content.indexOf("\n", at);
    const end = nl === -1 ? content.length : nl;
    longest = Math.max(longest, end - at);
    at = end + 1;
  }
  if (longest < LONG_LINE) return false;

  const masked = maskJs(content);
  let total = 0;
  let minified = 0;
  let code = 0; // code characters on the current line
  let gaps = 0; // whitespace runs between them — real whitespace only
  let punct = 0;
  let inGap = false;
  let gapReal = true; // the current run is source whitespace, not a masked literal
  const endLine = (): void => {
    total += code;
    if (code >= LONG_LINE && gaps * 100 <= code * MAX_GAPS_PER_100 && punct * 100 >= code * MIN_PUNCT_PER_100) {
      minified += code;
    }
    code = gaps = punct = 0;
    inGap = false;
  };
  for (let i = 0; i < masked.length; i++) {
    const c = masked.charCodeAt(i);
    if (c === 10) endLine();
    else if (c > 32) {
      if (inGap && gapReal && code > 0) gaps++;
      inGap = false;
      code++;
      if (c === SEMI || c === LPAREN || c === LBRACE || c === RBRACE) punct++;
    } else {
      if (!inGap) {
        inGap = true;
        gapReal = true;
      }
      // A masked literal reads as spaces too; only whitespace the SOURCE has
      // separates tokens (a string's body is one token, however long).
      if (content.charCodeAt(i) > 32) gapReal = false;
    }
  }
  endLine();
  return minified > 0 && minified * 2 >= total;
}

// A bundle, told by what its bundler writes, never by size or style (a bundle
// reads like hand-written code):
//   - esbuild (and tsup, Vite's library mode, Bun) opens each inlined module
//     with a comment naming its source, `// src/walk.ts` at column 0, followed
//     by that module's code;
//   - webpack, and ncc built on it, define their module loader,
//     `function __webpack_require__(moduleId)`.
// Both are checked on the mask, so a code generator whose template literal
// holds such lines is not taken for its own output. Rollup writes no marker,
// and its output is left alone.
const MODULE_BANNER = /^\/\/ ((?:[\w@$.+~-]+\/)*[\w@$.+~-]+\.(?:[cm]?[jt]sx?|json|vue|svelte|astro))\r?$/gm;
const MODULE_LOADER = /\bfunction __(?:webpack|nccwpck)_require__\s*\(/;
// Distinct inlined sources before a file counts as a bundle: two could be a
// hand-written file with two path-comment section headers.
const MIN_MODULES = 3;

export function isBundle(ext: string, content: string): boolean {
  if (!BUILD_EXTS.has(ext)) return false;
  let masked: string | undefined;
  if (content.includes("_require__") && MODULE_LOADER.test((masked = maskJs(content)))) return true;
  const banners: RegExpExecArray[] = [];
  MODULE_BANNER.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = MODULE_BANNER.exec(content)); ) banners.push(m);
  if (new Set(banners.map((m) => m[1])).size < MIN_MODULES) return false;
  masked ??= maskJs(content);
  const sources = new Set<string>();
  for (const m of banners) {
    // A banner is a comment the mask blanks, and the line after it is the
    // module's code, which the mask keeps. The same line inside a template
    // literal is followed by more template text: blank too.
    const next = m.index + m[0].length + 1;
    const end = masked.indexOf("\n", next);
    if (masked.slice(next, end === -1 ? masked.length : end).trim()) sources.add(m[1]!);
  }
  return sources.size >= MIN_MODULES;
}
