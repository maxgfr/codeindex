import type { RawRef } from "../types.js";

// Import specifiers as written (no resolution), plus the file's own package.
// Resolution needs repo-wide context (tsconfig paths, go.mod, python roots) and
// happens later, in resolve.ts.
//
// Deliberately tier-independent: both extractCode (the index) and the public
// extractAst call this, with or without a loaded grammar, so a file's import
// edges never depend on whether the wasm sidecar happened to be present. The
// AST readers this replaced disagreed with the index on every language they
// covered (Python read the imported NAMES, Go only the first spec of a group).

const JS_TS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const PY = new Set([".py", ".pyi"]);
const C_CPP = new Set([".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"]);
const KOTLIN = new Set([".kt", ".kts"]);
const SCALA = new Set([".scala", ".sc"]);
const SHELL = new Set([".sh", ".bash", ".zsh", ".ksh", ".fish"]);

// Rust `use` paths may end in a brace group (`use crate::a::{b, c::d};`, nested
// allowed). Expand each leaf into a full path, capped — a giant prelude group
// shouldn't explode into hundreds of refs.
const MAX_USE_EXPANSION = 16;
function expandUseGroups(path: string, out: string[] = []): string[] {
  if (out.length >= MAX_USE_EXPANSION) return out;
  const brace = path.indexOf("{");
  if (brace === -1) {
    const cleaned = path.replace(/\s+as\s+\w+\s*$/, "").replace(/::\s*\*\s*$/, "").replace(/^::/, "").trim();
    if (cleaned) out.push(cleaned);
    return out;
  }
  const prefix = path.slice(0, brace);
  let depth = 0;
  let end = -1;
  for (let i = brace; i < path.length; i++) {
    if (path[i] === "{") depth++;
    else if (path[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return out; // unbalanced — drop rather than guess
  const parts: string[] = [];
  let cur = "";
  depth = 0;
  for (const ch of path.slice(brace + 1, end)) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (t === "self") expandUseGroups(prefix.replace(/::\s*$/, ""), out);
    else expandUseGroups(prefix + t, out);
  }
  return out;
}

// A dotted JVM import path as the resolver wants it: backquotes dropped
// (Kotlin's `a.`fun`.B`), a wildcard written `.*` whatever the language
// spelled (Scala 2's `._`), and anything that is not a plain dotted name
// rejected.
function jvmPath(raw: string): string | undefined {
  const p = raw.replace(/`/g, "").replace(/^_root_\./, "").trim().replace(/\._$/, ".*");
  return /^\w+(?:\.\w+)*(?:\.\*)?$/.test(p) ? p : undefined;
}

// One Scala import clause into full dotted paths: `a.b.C`, `a.b.C as D`,
// `a.b._` / `a.b.*`, and selector groups `a.b.{C, D => E, _}`. A `given` or
// wildcard selector imports the whole prefix (`a.b.*`); a hiding selector
// (`C => _`) imports nothing.
function expandScalaImport(clause: string, out: string[]): void {
  const brace = clause.indexOf("{");
  if (brace === -1) {
    const p = jvmPath(clause.split(/\s+as\s+/)[0]!.replace(/\.given$/, ".*"));
    if (p && out.length < MAX_USE_EXPANSION) out.push(p);
    return;
  }
  const prefix = clause.slice(0, brace).trim().replace(/\.$/, "");
  const close = clause.indexOf("}", brace);
  if (close === -1) return; // unbalanced — drop rather than guess
  for (const sel of clause.slice(brace + 1, close).split(",")) {
    const [name = "", rename] = sel.split(/=>|\bas\b/).map((s) => s.trim());
    if (!name || rename === "_") continue;
    const whole = name === "_" || name === "*" || /^given\b/.test(name);
    const p = jvmPath(whole ? prefix + ".*" : prefix + "." + name);
    if (p && out.length < MAX_USE_EXPANSION) out.push(p);
  }
}

// The script-relative spellings of a sourced path — `"$(dirname "$0")/x"`,
// `"$(dirname "${BASH_SOURCE[0]}")/x"`, `"${BASH_SOURCE%/*}/x"` — rewritten to
// `./x` so the resolver reads them against the script's own directory.
const SHELL_SELF_DIR =
  /^(["']?)(?:\$\(\s*dirname\s+(["']?)\$(?:0|\{BASH_SOURCE(?:\[0\])?\}|BASH_SOURCE)\2\s*\)|\$\{(?:BASH_SOURCE(?:\[0\])?|0)%\/\*\})\//;

// The file a `source`/`.` line names, or undefined when it is not a literal:
// any other expansion ($VAR, ~, globs, command substitution) depends on the
// environment the script runs in, and an absolute path is outside the repo.
function shellSourcePath(arg: string): string | undefined {
  const w = /^(?:"([^"]*)"|'([^']*)'|([^\s;&|)#"']+))/.exec(arg.trim().replace(SHELL_SELF_DIR, "$1./"));
  const p = w?.[1] ?? w?.[2] ?? w?.[3];
  return p && !/[$`~*?]/.test(p) && !p.startsWith("/") ? p : undefined;
}

// Scala's package: the clauses heading the file, chained (`package a` then
// `package b` nest into `a.b`). A `package object foo` after them holds the
// members of package `….foo`, so that is the file's package.
function scalaPackage(content: string): string | undefined {
  const parts: string[] = [];
  let inComment = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (inComment) {
      inComment = !line.includes("*/");
      continue;
    }
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      inComment = !line.includes("*/");
      continue;
    }
    const m = /^package[ \t]+(object[ \t]+)?([\w.`]+)/.exec(line);
    if (!m) break;
    parts.push(m[2]!.replace(/`/g, ""));
    if (m[1]) break;
  }
  return parts.length ? parts.join(".") : undefined;
}

// --- masking ----------------------------------------------------------------
//
// The import scans below are regexes, and a regex over raw text cannot tell a
// statement from prose that quotes one: a JSDoc usage example, commented-out
// code, a code generator's template literal (`} from "./visitor.ts";` in the
// TypeScript repo's AST generator) and a flask docstring's `from flask import
// Flask` all produced import edges, some of them to test fixtures production
// code never touches. So each scan runs over a MASKED copy of the file: every
// comment, string body, template-literal text and regex-literal body replaced by
// spaces. Newlines are kept, so every offset and line in the mask is the same
// offset and line in the source, and a specifier the mask locates (its quotes
// survive, its body is blank) is read back from the source at that span.

// A copy of `src` with chosen spans blanked. Edited in place as UTF-16 code
// units and decoded once: building it from slices and space runs instead made
// one small string per literal, and on a 2 MB lib.dom.d.ts the garbage
// collector cost ten times the scan itself.
class Mask {
  private codes: Uint16Array | undefined;
  constructor(private readonly src: string) {}

  /** Blank [from, to): every code unit but "\n" becomes a space. */
  blank(from: number, to: number): void {
    if (to <= from) return;
    let codes = this.codes;
    if (!codes) {
      codes = this.codes = new Uint16Array(this.src.length);
      for (let i = 0; i < codes.length; i++) codes[i] = this.src.charCodeAt(i);
    }
    for (let i = from; i < to; i++) if (codes[i] !== NEWLINE) codes[i] = SPACE;
  }

  /** The code unit at `at` as masked so far. */
  codeAt(at: number): number {
    return this.codes ? this.codes[at]! : this.src.charCodeAt(at);
  }

  done(): string {
    const codes = this.codes;
    if (!codes) return this.src;
    if (UTF16_HOST) return UTF16_HOST.decode(codes);
    // Chunked: fromCharCode.apply has an argument-count ceiling.
    let out = "";
    for (let i = 0; i < codes.length; i += 8192) {
      out += String.fromCharCode.apply(null, codes.subarray(i, i + 8192) as unknown as number[]);
    }
    return out;
  }
}

// Native decoding of the code units, when the host stores them little-endian
// (every mainstream platform). `ignoreBOM` keeps a leading U+FEFF, which would
// otherwise vanish and shift every offset by one.
const UTF16_HOST =
  new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? new TextDecoder("utf-16le", { ignoreBOM: true }) : undefined;

const NEWLINE = 10;
const SPACE = 32;
const HASH = 35; // "#"
const DOLLAR = 36; // "$"
const SQUOTE = 39; // "'"
const DQUOTE = 34; // '"'
const STAR = 42; // "*"
const SLASH = 47; // "/"
const LBRACKET = 91; // "["
const BACKSLASH = 92;
const RBRACKET = 93; // "]"
const BACKTICK = 96;
const LBRACE = 123; // "{"
const RBRACE = 125; // "}"

function isIdentChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === DOLLAR || c > 127;
}

// After one of these a `/` starts a regex literal; after anything else (an
// identifier, a number, `)`, `]`, a closing quote or regex delimiter) it is a
// division. `}` counts as a statement end: a block closes far more often right
// before a regex than an object literal is divided. The classic
// one-token-lookbehind heuristic: wrong only on shapes like `a++ /re/` or
// `if (x) /re/`, and a wrong guess blanks or keeps the rest of ONE line —
// strings and regex literals both end at a newline here.
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"].map((ch) => ch.charCodeAt(0)));
const REGEX_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

// What a JSDoc block may legitimately import: a type expression
// (`@type {import("./x").T}` — how a checkJs codebase such as webpack imports
// its types) and a TS 5.5 `@import { T } from "./x"` tag. Both are real type
// dependencies, so they survive the mask while the rest of the comment
// (usage examples included) is blanked.
const JSDOC_IMPORT = /\bimport\(\s*['"][^'"\n]*['"]\s*[,)]|@import\b[^'"@]{0,2048}?\bfrom\s*['"][^'"\n]*['"]/g;

// Mask a JS/TS file. Template literals nest (`${ `inner` }`); each open
// interpolation records the brace depth it opened at, and the `}` that brings
// the depth back to it returns the scan to template text. The code inside an
// interpolation stays code — a `${require("x")}` is a real require.
export function maskJs(src: string): string {
  const n = src.length;
  const mask = new Mask(src);
  const interpolations: number[] = [];
  let depth = 0;

  // Template text from `from` up to its closing backtick or next `${`;
  // returns where code resumes.
  const templateText = (from: number): number => {
    let j = from;
    while (j < n) {
      const ch = src.charCodeAt(j);
      if (ch === BACKSLASH) j += 2;
      else if (ch === BACKTICK) {
        mask.blank(from, j);
        return j + 1;
      } else if (ch === DOLLAR && src.charCodeAt(j + 1) === LBRACE) {
        mask.blank(from, j);
        interpolations.push(depth++);
        return j + 2;
      } else j++;
    }
    mask.blank(from, n);
    return n;
  };

  // Does a `/` at `at` open a regex literal? Decided by the last significant
  // character before it, read back from the mask rather than tracked on every
  // character (a quarter of the scan): a masked comment reads as whitespace,
  // and the delimiters a string, template or regex literal keeps read as the
  // operand that just ended.
  const regexAllowed = (at: number): boolean => {
    let j = at - 1;
    while (j >= 0 && mask.codeAt(j) <= SPACE) j--;
    if (j < 0) return true;
    const prev = mask.codeAt(j);
    if (REGEX_AFTER.has(prev)) return true;
    if (!isIdentChar(prev)) return false;
    let s = j;
    while (s > 0 && isIdentChar(src.charCodeAt(s - 1))) s--;
    return REGEX_AFTER_WORD.has(src.slice(s, j + 1));
  };

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === SLASH) {
      const next = src.charCodeAt(i + 1);
      if (next === SLASH) {
        const end = src.indexOf("\n", i);
        const stop = end === -1 ? n : end;
        mask.blank(i, stop);
        i = stop;
        continue;
      }
      if (next === STAR) {
        const close = src.indexOf("*/", i + 2);
        const end = close === -1 ? n : close + 2;
        let from = i;
        if (src.charCodeAt(i + 2) === STAR) {
          JSDOC_IMPORT.lastIndex = 0;
          const body = src.slice(i, end);
          for (let m: RegExpExecArray | null; (m = JSDOC_IMPORT.exec(body)); ) {
            mask.blank(from, i + m.index);
            from = i + m.index + m[0].length;
            // A tag wrapped over lines keeps the comment's ` * ` gutter between
            // its parts (`@import { A }\n * from "./a"`); blank the gutter so the
            // kept text reads as the one statement it is.
            for (const gutter of m[0].matchAll(/\n[ \t]*\*/g)) {
              const star = i + m.index + gutter.index! + gutter[0].length - 1;
              mask.blank(star, star + 1);
            }
          }
        }
        mask.blank(from, end);
        i = end;
        continue;
      }
      if (regexAllowed(i)) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const ch = src.charCodeAt(j);
          if (ch === NEWLINE) break;
          if (ch === BACKSLASH) {
            j += 2;
            continue;
          }
          if (ch === LBRACKET) inClass = true;
          else if (ch === RBRACKET) inClass = false;
          else if (ch === SLASH && !inClass) break;
          j++;
        }
        if (j < n && src.charCodeAt(j) === SLASH) {
          mask.blank(i + 1, j);
          i = j + 1;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === SQUOTE || c === DQUOTE) {
      let j = i + 1;
      while (j < n) {
        const ch = src.charCodeAt(j);
        if (ch === c || ch === NEWLINE) break;
        j += ch === BACKSLASH ? 2 : 1;
      }
      const end = Math.min(j, n);
      mask.blank(i + 1, end);
      i = end < n && src.charCodeAt(end) === c ? end + 1 : end;
      continue;
    }
    if (c === BACKTICK) {
      i = templateText(i + 1);
      continue;
    }
    if (c === LBRACE) depth++;
    else if (c === RBRACE) {
      depth--;
      if (interpolations.length && interpolations[interpolations.length - 1] === depth) {
        interpolations.pop();
        i = templateText(i + 1);
        continue;
      }
    }
    i++;
  }
  return mask.done();
}

// Mask a Python file: `#` comments and every string body, triple-quoted ones
// across lines (the docstrings whose example code read as imports). A prefix
// (`r`, `b`, `f`, …) is an identifier character before the quote and needs no
// handling of its own.
export function maskPython(src: string): string {
  const n = src.length;
  const mask = new Mask(src);
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === HASH) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      mask.blank(i, stop);
      i = stop;
      continue;
    }
    if (c === SQUOTE || c === DQUOTE) {
      const triple = src.charCodeAt(i + 1) === c && src.charCodeAt(i + 2) === c;
      const open = i + (triple ? 3 : 1);
      let j = open;
      while (j < n) {
        const ch = src.charCodeAt(j);
        if (ch === BACKSLASH) j += 2;
        else if (ch === c && (!triple || (src.charCodeAt(j + 1) === c && src.charCodeAt(j + 2) === c))) break;
        else if (ch === NEWLINE && !triple) break;
        else j++;
      }
      const end = Math.min(j, n);
      mask.blank(open, end);
      i = end < n && src.charCodeAt(end) === c ? end + (triple ? 3 : 1) : end;
      continue;
    }
    i++;
  }
  return mask.done();
}

// What a brace language's literals and comments look like, for maskBraced.
export interface BracedLexis {
  /** `/* … *\/` nests (Swift, Kotlin, Rust, Scala, Dart). */
  nested?: boolean;
  /** `#` opens a line comment (PHP). */
  hash?: boolean;
  /** `"""` opens a multi-line string (Kotlin, Swift, Scala, Dart, Java; Dart `'''` too). */
  triple?: boolean;
  /**
   * What `'` opens: a string (Dart, PHP), a character literal (C, Java, Go,
   * Kotlin, C#, Scala, Rust), or nothing (Swift). A character literal is only
   * taken when it closes within a few characters, so a Rust lifetime (`&'a T`)
   * or a Scala symbol (`'sym`) is left alone instead of swallowing the line.
   */
  squote: "string" | "char" | "none";
  /** `` ` `` opens a raw, multi-line string (Go). */
  backtick?: boolean;
  /** A quoted string may span lines (Rust, PHP). */
  multiline?: boolean;
  /**
   * Raw strings fenced by hashes, which may hold bare quotes: Rust's
   * `r#"…"#` (`"r"`), Swift's `#"…"#` (`"#"`).
   */
  raw?: "r" | "#";
}

const CHAR_LITERAL = /'(?:\\(?:u\{[0-9A-Fa-f]{1,6}\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|.)|[^\\'\n])'/y;

// Mask a brace-language file (the regex tier's C family, lang/common.ts): every
// comment and string body blanked, offsets and lines kept. The line rules then
// match code only — a declaration quoted in a KDoc example or a multi-line
// string is not one — and a declaration's braces can be matched to find where
// its body ends. A string ends at its line's end unless the language lets it
// span lines, which bounds the damage of a quote this scanner misreads (an
// interpolation that nests quotes, `"${m["k"]}"`) to one line.
export function maskBraced(src: string, lex: BracedLexis): string {
  const n = src.length;
  const mask = new Mask(src);
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if ((c === SLASH && src.charCodeAt(i + 1) === SLASH) || (c === HASH && lex.hash)) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      mask.blank(i, stop);
      i = stop;
      continue;
    }
    if (c === SLASH && src.charCodeAt(i + 1) === STAR) {
      let j = i + 2;
      let depth = 1;
      while (j < n) {
        if (src.charCodeAt(j) === STAR && src.charCodeAt(j + 1) === SLASH) {
          j += 2;
          if (--depth === 0) break;
        } else if (lex.nested && src.charCodeAt(j) === SLASH && src.charCodeAt(j + 1) === STAR) {
          j += 2;
          depth++;
        } else j++;
      }
      const end = Math.min(j, n);
      mask.blank(i, end);
      i = end;
      continue;
    }
    if (c === DQUOTE && lex.raw) {
      // Hashes before the quote, and for Rust the `r` before them.
      let h = i;
      while (h > 0 && src.charCodeAt(h - 1) === HASH) h--;
      const hashes = i - h;
      const isRaw = lex.raw === "r" ? /[rR]$/.test(src.slice(Math.max(0, h - 2), h)) : hashes > 0;
      if (isRaw) {
        const close = src.indexOf('"' + "#".repeat(hashes), i + 1);
        const end = close === -1 ? n : close;
        mask.blank(i + 1, end);
        i = close === -1 ? n : close + 1 + hashes;
        continue;
      }
    }
    const quote = c === DQUOTE || (c === SQUOTE && lex.squote === "string");
    if (quote || (c === BACKTICK && lex.backtick)) {
      const triple = quote && lex.triple && src.charCodeAt(i + 1) === c && src.charCodeAt(i + 2) === c;
      const open = i + (triple ? 3 : 1);
      let j = open;
      if (triple) {
        const close = src.indexOf(c === DQUOTE ? '"""' : "'''", open);
        j = close === -1 ? n : close;
      } else {
        while (j < n) {
          const ch = src.charCodeAt(j);
          if (ch === c || (ch === NEWLINE && c !== BACKTICK && !lex.multiline)) break;
          j += ch === BACKSLASH && c !== BACKTICK ? 2 : 1;
        }
      }
      const end = Math.min(j, n);
      mask.blank(open, end);
      i = end < n && src.charCodeAt(end) === c ? end + (triple ? 3 : 1) : end;
      continue;
    }
    if (c === SQUOTE && lex.squote === "char") {
      CHAR_LITERAL.lastIndex = i;
      if (CHAR_LITERAL.test(src)) {
        mask.blank(i + 1, CHAR_LITERAL.lastIndex - 1);
        i = CHAR_LITERAL.lastIndex;
        continue;
      }
    }
    i++;
  }
  return mask.done();
}

// --- per-language scans -----------------------------------------------------

// JS/TS static import/export-from clause, matched STRUCTURALLY: optional
// modifier, optional default binding and comma, then one binding, `* as ns` or
// a `{ … }` list, then `from`. The previous lazy `[^'"]*?` scan ran from every
// `import`/`export` keyword to the next quote — the end of the file in a
// quote-free module, so a 900 KB table of `export function gN()` took 11 s.
// Each attempt here stops at the first character a clause cannot contain (a
// brace list at its first `}`), which keeps the scan linear.
const ID = "[\\w$\\u00a0-\\uffff]+";
const JS_FROM = new RegExp(
  `(?:^|[^\\w$.])(?:import|export)\\b\\s*(?:(?:type|typeof|defer|source)\\s+)?(?:${ID}\\s*,\\s*)?` +
    `(?:${ID}|\\*\\s*(?:as\\s+${ID})?|\\{[^{}]*\\})\\s*from\\s*['"]([^'"]+)['"]`,
  "dg",
);
// `import "./side-effect";` at a statement start. `[ \t]*`, not `\s*`: a long
// blanked comment is one whitespace run, and `\s*` from every newline in it
// would rescan the rest of the run.
const JS_BARE = /(?:^|[\n;])[ \t]*import\s*['"]([^'"]+)['"]/dg;
const JS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/dg;
// `import("./x")`, and `import("./data.json", { with: { type: "json" } })` —
// the import-attributes argument (also TS's `resolution-mode` on type imports).
const JS_DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*[,)]/dg;

// Python import statements, at a line start or after a `;`, in source order.
// `from X import …` takes its names parenthesized (possibly across lines) or to
// the end of the logical line (backslash continuations included).
const PY_IMPORT =
  /(?:^|;)[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import\b[ \t]*(\([^)]*\)|(?:\\\r?\n|[^\n;])*)|import[ \t]+([^\n;]*))/gm;

// A PHP class-like declaration at a line start. Namespace imports come before
// it; a `use Foo;` after it and indented is a TRAIT use inside the class body.
const PHP_TYPE_DECL = /^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]+[A-Za-z_]/m;
const PHP_USE = /^([ \t]*)use\s+([^;]*);/gm;
const PHP_USE_NAME = /^[A-Za-z_][\w\\]*$/;
// `require 'x.php'`, and the file-relative forms anchored on the file's own
// directory: `__DIR__ . '/x.php'`, `dirname(__FILE__) . '/x.php'`, and
// `dirname(__DIR__[, levels]) . '/x.php'` one or more levels up.
const PHP_INCLUDE =
  /\b(?:require|include)(?:_once)?\s*\(?\s*(?:(?<here>__DIR__|dirname\(\s*__FILE__\s*\))\s*\.\s*|(?<up>dirname\(\s*__DIR__\s*(?:,\s*(?<levels>\d+)\s*)?\))\s*\.\s*)?['"](?<path>[^'"]+)['"]/g;

// The joined module path of `from X import name`: `.` + `cli` → `.cli`,
// `flask` + `json` → `flask.json`.
function pyJoin(mod: string, name: string): string {
  return /^\.+$/.test(mod) ? mod + name : `${mod}.${name}`;
}

// A relative include as the resolver expects it: leading "./" unless already
// "./" or "../".
function relSpec(path: string): string {
  return /^\.\.?\//.test(path) ? path : "./" + path;
}

export function extractImports(ext: string, content: string): RawRef[] {
  // spec → soft, in first-seen order. A hard ref for the same spec always wins
  // over a soft one, and is re-inserted at its own position so the hard refs
  // keep exactly the order they had before soft refs existed.
  const specs = new Map<string, boolean>();
  const hard = (spec: string): void => {
    if (specs.get(spec) === true) specs.delete(spec);
    specs.set(spec, false);
  };
  const soft = (spec: string): void => {
    if (!specs.has(spec)) specs.set(spec, true);
  };

  if (JS_TS.has(ext)) {
    // Every form needs one of these words; a file with none (a `.d.ts` lib, a
    // generated table) skips the mask outright.
    if (!content.includes("import") && !content.includes("require") && !content.includes("from")) return [];
    // Run over the WHOLE content, not line-by-line: a long `import { … } from "x"`
    // (or `export { … } from "x"`) is routinely wrapped across several lines by
    // formatters, and a per-line scan never sees the `from` clause — silently
    // dropping the edge. The `g` flag also catches >1 per line.
    const masked = maskJs(content);
    for (const re of [JS_FROM, JS_BARE, JS_REQUIRE, JS_DYNAMIC]) {
      re.lastIndex = 0;
      for (let m: RegExpExecArray | null; (m = re.exec(masked)); ) {
        const [from, to] = m.indices![1]!;
        hard(content.slice(from, to));
      }
    }
  } else if (PY.has(ext)) {
    if (!content.includes("import")) return [];
    const masked = maskPython(content);
    PY_IMPORT.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = PY_IMPORT.exec(masked)); ) {
      const mod = m[1];
      if (mod !== undefined) {
        hard(mod);
        // `from . import cli` imports the MODULE `.cli` when one exists, and
        // `from flask import json` the subpackage `flask.json` — a name that is
        // no module (a function, a class) resolves nowhere. So each name is a
        // SOFT candidate: an edge when it resolves to a file, silently dropped
        // otherwise. `__future__` names are compiler flags, never modules.
        if (!mod || mod === "__future__") continue;
        const list = m[2]!.startsWith("(") ? m[2]!.slice(1, -1) : m[2]!.replace(/\\\r?\n/g, " ");
        for (const part of list.split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0]!.trim();
          if (/^[A-Za-z_]\w*$/.test(name)) soft(pyJoin(mod, name));
        }
        continue;
      }
      for (const part of m[3]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name && /^[\w.]+$/.test(name)) hard(name);
      }
    }
  } else if (ext === ".go") {
    const lines = content.split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      const t = line.trim();
      if (inBlock) {
        if (t === ")") {
          inBlock = false;
          continue;
        }
        const b = /"([^"]+)"/.exec(t);
        if (b) hard(b[1]!);
        continue;
      }
      if (/^import\s*\($/.test(t)) {
        inBlock = true;
        continue;
      }
      const single = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/.exec(t);
      if (single) hard(single[1]!);
    }
  } else if (ext === ".rs") {
    let m: RegExpExecArray | null;
    // `#[path = "x.rs"] mod foo;` loads x.rs (relative to this file's dir)
    // instead of foo.rs, so it is emitted as `mod-path x.rs`; the plain
    // `mod foo` it would otherwise also yield names a file that is not there.
    // Other attributes and doc comments may sit between the two.
    const pathed = new Set<number>(); // end offsets of the `mod …;` statements taken here
    const pathRe =
      /#\[\s*path\s*=\s*"([^"]+)"\s*\]\s*(?:(?:#\[[^\]]*\]|\/\/[^\n]*)\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*\s*;/g;
    while ((m = pathRe.exec(content))) {
      hard(`mod-path ${m[1]}`);
      pathed.add(m.index + m[0].length);
    }
    // `mod foo;` declares a child module that MUST exist as a file (an inline
    // `mod foo { … }` body has no `;` and is skipped).
    const modRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
    while ((m = modRe.exec(content))) if (!pathed.has(m.index + m[0].length)) hard(`mod ${m[1]}`);
    // `use` paths, brace groups expanded. External crates (std, serde, …) are
    // filtered at resolve time, where the in-repo crate list lives.
    const useRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;
    while ((m = useRe.exec(content))) {
      for (const p of expandUseGroups(m[1]!.trim())) hard(p);
    }
  } else if (ext === ".java") {
    // `import com.a.b.C;` / `import static com.a.b.C.method;` — wildcards kept
    // as written; the resolver maps packages onto source roots.
    let m: RegExpExecArray | null;
    const imp = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;
    while ((m = imp.exec(content))) hard(m[1]!);
  } else if (ext === ".rb" || ext === ".rake") {
    // `require_relative "x"` is relative to the file — emit it as a relative path
    // (leading "./") so the resolver resolves it against the file's dir. `require
    // "x"` is resolved against lib roots or is external (a gem).
    let m: RegExpExecArray | null;
    const rel = /^\s*require_relative\s+['"]([^'"]+)['"]/gm;
    while ((m = rel.exec(content))) hard(relSpec(m[1]!));
    const req = /^\s*require\s+['"]([^'"]+)['"]/gm;
    while ((m = req.exec(content))) hard(m[1]!);
  } else if (C_CPP.has(ext)) {
    // Local `#include "foo.h"` — a real in-repo dependency. `<...>` is a system/
    // third-party header (external) and is deliberately not captured.
    let m: RegExpExecArray | null;
    const inc = /^\s*#\s*include\s*"([^"]+)"/gm;
    while ((m = inc.exec(content))) hard(m[1]!);
  } else if (ext === ".php") {
    // `use Foo\Bar\Baz;` (namespace, resolved via composer PSR-4) — also the
    // comma list `use A\B, C\D;` and the group `use App\Models\{User, Post};` —
    // and `require/include 'file.php'` (relative path, emitted with a leading
    // "./").
    let m: RegExpExecArray | null;
    const firstType = PHP_TYPE_DECL.exec(content)?.index ?? Infinity;
    PHP_USE.lastIndex = 0;
    while ((m = PHP_USE.exec(content))) {
      if (m[1] && m.index > firstType) continue; // a trait use in a class body
      const clause = m[2]!.trim().replace(/^(?:function|const)\s+/, "");
      const group = /^\\?([\w\\]*?)\\?\s*\{([^}]*)\}$/.exec(clause);
      const names = group ? group[2]!.split(",").map((p) => `${group[1]}\\${p.trim()}`) : clause.split(",");
      for (const raw of names) {
        const name = raw
          .trim()
          .replace(/\\(?:function|const)\s+/, "\\") // a mixed group's `function x`
          .replace(/\s+as\s+\w+$/, "")
          .replace(/^\\/, "");
        if (PHP_USE_NAME.test(name)) hard(name);
      }
    }
    PHP_INCLUDE.lastIndex = 0;
    while ((m = PHP_INCLUDE.exec(content))) {
      const { here, up, levels, path } = m.groups!;
      if (here) hard(relSpec(path!.replace(/^\/+/, "")));
      else if (up) hard("../".repeat(Number(levels ?? 1)) + path!.replace(/^\/+/, ""));
      else hard(relSpec(path!));
    }
  } else if (ext === ".cs") {
    // `using Foo.Bar;` — a namespace import, resolved to files declaring that
    // namespace. Skip alias (`using X = ...`) and resource (`using (...)`) forms.
    let m: RegExpExecArray | null;
    const using = /^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm;
    while ((m = using.exec(content))) hard(m[1]!);
  } else if (KOTLIN.has(ext)) {
    // `import a.b.C`, `import a.b.*`, `import a.b.C as D` — Java's dotted form
    // without the `;`, so .java/.kt/.scala share one resolver.
    let m: RegExpExecArray | null;
    const imp = /^[ \t]*import[ \t]+([\w.`*]+)/gm;
    while ((m = imp.exec(content))) {
      const p = jvmPath(m[1]!);
      if (p) hard(p);
    }
  } else if (SCALA.has(ext)) {
    // `import a.B, c.D` holds several clauses; a selector group may wrap lines.
    let m: RegExpExecArray | null;
    const imp = /^[ \t]*import[ \t]+((?:[^\n;{]|\{[^}]*\})+)/gm;
    while ((m = imp.exec(content))) {
      const out: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of m[1]!.replace(/\/\/.*$/gm, "")) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (ch === "," && depth === 0) {
          expandScalaImport(cur, out);
          cur = "";
        } else cur += ch;
      }
      expandScalaImport(cur, out);
      for (const p of out) hard(p);
    }
  } else if (ext === ".dart") {
    // `import`/`export` and `part 'x.dart'` (a piece of THIS library kept in
    // another file). `part of` names the owning library back — the library's
    // own `part` already links the pair. URIs stay as written: `dart:` is the
    // SDK, `package:` is mapped onto pubspec.yaml names at resolve time.
    let m: RegExpExecArray | null;
    const re = /^[ \t]*(?:import|export|part)[ \t]+(?:'([^'\n]+)'|"([^"\n]+)")/gm;
    while ((m = re.exec(content))) hard(m[1] ?? m[2]!);
  } else if (ext === ".lua") {
    // `require("a.b")`, `require "a.b"`, `require 'a.b'`: a module name the
    // resolver maps onto package.path's `?.lua` and `?/init.lua`.
    let m: RegExpExecArray | null;
    const re = /\brequire\s*\(?\s*['"]([\w-]+(?:[./][\w-]+)*)['"]/g;
    while ((m = re.exec(content))) hard(m[1]!);
  } else if (SHELL.has(ext)) {
    // `source f` / `. f`, at a line start or after `;`, `&&`, `||`, `then`, `do`.
    let m: RegExpExecArray | null;
    const re = /(?:^|[;&|]|\b(?:then|do|else)\b)[ \t]*(?:source|\.)[ \t]+([^\n]+)/gm;
    while ((m = re.exec(content))) {
      const p = shellSourcePath(m[1]!);
      if (p) hard(p);
    }
  } else if (ext === ".ex" || ext === ".exs") {
    // `alias A.B`, `alias A.{B, C}`, `import A`, `require A`, `use A, opts` —
    // module names, resolved through the repo's defmodule index. `__MODULE__`
    // forms need the enclosing module and are skipped.
    let m: RegExpExecArray | null;
    const re = /^[ \t]*(?:alias|import|require|use)[ \t]+([A-Z]\w*(?:\.[A-Z]\w*)*)(?:\.\{([^}]*)\})?/gm;
    while ((m = re.exec(content))) {
      if (m[2] === undefined) {
        hard(m[1]!);
        continue;
      }
      let n = 0;
      for (const part of m[2].split(",")) {
        const name = part.trim();
        if (/^[A-Z]\w*(?:\.[A-Z]\w*)*$/.test(name) && n++ < MAX_USE_EXPANSION) hard(m[1] + "." + name);
      }
    }
  }

  return [...specs].map(([spec, isSoft]) =>
    isSoft ? { kind: "import" as const, spec, soft: true as const } : { kind: "import" as const, spec },
  );
}

// The file's own package, which anchors namespace → file resolution: Java's
// `package x;`, C#'s `namespace x` (block or file-scoped), Kotlin's `package
// x` and Scala's (see scalaPackage).
export function extractPackage(ext: string, content: string): string | undefined {
  if (ext === ".java") return /^\s*package\s+([\w.]+)\s*;/m.exec(content)?.[1];
  if (ext === ".cs") return /^\s*(?:file-scoped\s+)?namespace\s+([\w.]+)/m.exec(content)?.[1];
  if (KOTLIN.has(ext)) {
    const m = /^[ \t]*package[ \t]+([\w.`]+)/m.exec(content);
    return m ? m[1]!.replace(/`/g, "") : undefined;
  }
  if (SCALA.has(ext)) return scalaPackage(content);
  return undefined;
}
