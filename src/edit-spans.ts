// Line-span heuristics the symbolic edits need beyond what the index records:
// where a regex-tier declaration ENDS (the regex tier records only its first
// line), and where the comments and decorators written ABOVE a declaration
// begin (most grammars start the declaration node below them).
//
// Both answer "undefined"/"no further" whenever the text is not conclusive. An
// edit that cannot place itself exactly is refused by the caller; one that
// guesses writes invalid code and reports success, which is strictly worse.

// --- where a regex-tier declaration ends -------------------------------------
//
// Only for brace-bodied languages that reach the edit tools WITHOUT an AST span:
// Swift and Dart have no grammar, Kotlin's is in the optional extended tier. All
// three share C-style comments (block comments nest), `"`/`"""` strings with
// escapes, and brace or paren interpolation, which is what the lexer below
// understands. Anything else, and anything it cannot account for, is no answer.
const BRACE_LANGS = new Set(["swift", "kotlin", "dart"]);

// A declaration longer than this is not worth a heuristic.
const MAX_SPAN_LINES = 10_000;

type Frame =
  // Code. `close` is null at the top level; inside an interpolation it is the
  // bracket that returns to the string, with `nest` counting its nested pairs.
  | { t: "code"; close: ")" | "}" | null; nest: number }
  | { t: "str"; quote: string; hashes: number; escapes: boolean; interp: "dollar" | "swift" | null; multiline: boolean }
  | { t: "comment"; nest: number };

// Trailing text allowed after the token that ends a declaration.
const TRAILER = /^\s*[;,]?\s*(?:\/\/.*)?$/;

const leadingSpace = (line: string): string => /^\s*/.exec(line)![0];

// The 0-based index of the last line of the declaration starting at
// lines[start], for a Swift/Kotlin/Dart symbol without an AST span. Answers
// only when the declaration's own braces (or a `;` for a body-less one such as
// Dart's `=> expr;`) close it, the closing brace is the first thing on its
// line at the header's indentation, and nothing but a comment follows it.
export function braceBodyEnd(lines: readonly string[], start: number, lang: string): number | undefined {
  if (!BRACE_LANGS.has(lang) || start < 0 || start >= lines.length) return undefined;
  const indent = leadingSpace(lines[start]!);
  const stack: Frame[] = [{ t: "code", close: null, nest: 0 }];
  let depth = 0; // top-level braces
  let parens = 0; // top-level ( and [
  let opened = false;
  const last = Math.min(lines.length, start + MAX_SPAN_LINES);

  // Validate a candidate end: the closing token at column `col` of line `row`.
  const accept = (row: number, col: number, closingBrace: boolean): number | undefined => {
    const line = lines[row]!;
    if (!TRAILER.test(line.slice(col + 1))) return undefined;
    if (closingBrace && row !== start && (leadingSpace(line) !== indent || line.trim()[0] !== "}")) return undefined;
    return row;
  };

  for (let row = start; row < last; row++) {
    const line = lines[row]!;
    let lastCode = ""; // the last top-level code character on this line
    for (let i = 0; i < line.length; ) {
      const top = stack[stack.length - 1]!;
      const c = line[i]!;
      if (top.t === "comment") {
        if (line.startsWith("*/", i)) {
          i += 2;
          if (--top.nest === 0) stack.pop();
        } else if (line.startsWith("/*", i)) {
          i += 2;
          top.nest++;
        } else i++;
        continue;
      }
      if (top.t === "str") {
        const hashes = "#".repeat(top.hashes);
        if (line.startsWith(top.quote + hashes, i)) {
          stack.pop();
          i += top.quote.length + top.hashes;
          continue;
        }
        if (c === "\\" && (top.escapes || top.interp === "swift")) {
          // Swift's escape introducer grows with the raw-string delimiter:
          // `\#(` interpolates inside `#"…"#`, a bare `\` is literal there.
          if (!line.startsWith(hashes, i + 1)) {
            i++;
            continue;
          }
          const after = i + 1 + top.hashes;
          if (top.interp === "swift" && line[after] === "(") {
            stack.push({ t: "code", close: ")", nest: 0 });
            i = after + 1;
          } else i = after + 1; // an escaped character, whatever it is
          continue;
        }
        if (top.interp === "dollar" && line.startsWith("${", i)) {
          stack.push({ t: "code", close: "}", nest: 0 });
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // Code.
      if (line.startsWith("//", i)) break;
      if (line.startsWith("/*", i)) {
        stack.push({ t: "comment", nest: 1 });
        i += 2;
        continue;
      }
      const str = stringOpener(line, i, lang);
      if (str) {
        stack.push(str.frame);
        i += str.length;
        if (top.close === null) lastCode = '"';
        continue;
      }
      if (top.close !== null) {
        // Inside an interpolation: only its own bracket matters.
        const open = top.close === ")" ? "(" : "{";
        if (c === open) top.nest++;
        else if (c === top.close) {
          if (top.nest === 0) stack.pop();
          else top.nest--;
        }
        i++;
        continue;
      }
      if (c === "(" || c === "[") parens++;
      else if (c === ")" || c === "]") {
        if (--parens < 0) return undefined;
      } else if (c === "{") {
        depth++;
        if (parens === 0) opened = true;
      } else if (c === "}") {
        if (--depth < 0) return undefined;
        if (opened && depth === 0) return parens === 0 ? accept(row, i, true) : undefined;
      } else if (c === ";" && !opened && depth === 0 && parens === 0) {
        return accept(row, i, false);
      }
      if (!/\s/.test(c)) lastCode = c;
      i++;
    }

    const top = stack[stack.length - 1]!;
    // A single-line string cannot cross a line break: the lexer lost track.
    if (top.t === "str" && !top.multiline) return undefined;
    if (stack.length > 1 || opened || depth > 0 || parens > 0) continue;
    // The header line ended with no body opened. Continue only into a line
    // that visibly belongs to this header — an Allman `{`, or a deeper-indented
    // continuation after a trailing separator or operator (`,` `:` `=>` `->`
    // `||` …) — never into a sibling declaration, whose braces would then be
    // taken for this one's.
    const next = lines.slice(row + 1, last).findIndex((l) => l.trim() !== "");
    if (next < 0) return undefined;
    const following = lines[row + 1 + next]!;
    if (following.trim().startsWith("{")) continue;
    if (/[,:=>|&+\-*/?.]/.test(lastCode) && leadingSpace(following).length > indent.length && following.startsWith(indent)) continue;
    return undefined;
  }
  return undefined;
}

// The string literal opening at line[i], if any, for the three brace languages.
function stringOpener(line: string, i: number, lang: string): { frame: Frame; length: number } | undefined {
  const c = line[i]!;
  if (lang === "swift") {
    // #"raw"#, ##"raw"##, and their """ forms; `#if`/`#selector` are not strings.
    let hashes = 0;
    while (line[i + hashes] === "#") hashes++;
    if (line[i + hashes] !== '"') return c === "`" ? plain("`") : undefined;
    const triple = line.startsWith('"""', i + hashes);
    const quote = triple ? '"""' : '"';
    return {
      frame: { t: "str", quote, hashes, escapes: hashes === 0, interp: "swift", multiline: triple },
      length: hashes + quote.length,
    };
  }
  if (lang === "kotlin") {
    if (line.startsWith('"""', i)) return { frame: { t: "str", quote: '"""', hashes: 0, escapes: false, interp: "dollar", multiline: true }, length: 3 };
    if (c === '"') return { frame: { t: "str", quote: '"', hashes: 0, escapes: true, interp: "dollar", multiline: false }, length: 1 };
    if (c === "'") return { frame: { t: "str", quote: "'", hashes: 0, escapes: true, interp: null, multiline: false }, length: 1 };
    return c === "`" ? plain("`") : undefined;
  }
  // Dart: r-prefixed raw strings, ''' and """ multi-line, both quote kinds.
  const raw = c === "r" && (line[i + 1] === '"' || line[i + 1] === "'") && !/[\w$]/.test(line[i - 1] ?? "");
  const q = raw ? i + 1 : i;
  if (line[q] !== '"' && line[q] !== "'") return undefined;
  const triple = line.startsWith(line[q]!.repeat(3), q);
  const quote = triple ? line[q]!.repeat(3) : line[q]!;
  return {
    frame: { t: "str", quote, hashes: 0, escapes: !raw, interp: raw ? null : "dollar", multiline: triple },
    length: (raw ? 1 : 0) + quote.length,
  };
}

// A backtick identifier: a single-line quote with no escapes.
function plain(quote: string): { frame: Frame; length: number } {
  return { frame: { t: "str", quote, hashes: 0, escapes: false, interp: null, multiline: false }, length: quote.length };
}

// --- where the comments and decorators above a declaration begin -------------
//
// insert_before must land ABOVE a declaration's decorators and doc comment:
// between them it re-decorates the inserted code and detaches the godoc/JSDoc
// from its owner. TypeScript, Python, Rust, C++ and Go start the declaration's
// span below these lines (Java, C#, Kotlin, PHP and Scala already include the
// annotations and only need the doc comment).
//
// "Directly above" follows the doc-comment rule of src/ast/doc.ts: a contiguous
// run with no blank line.

const SLASH_COMMENTS = new Set([
  "typescript", "javascript", "java", "kotlin", "scala", "dart", "swift", "go", "rust",
  "csharp", "c", "cpp", "php", "zig", "solidity", "hcl", "terraform",
]);
const HASH_COMMENTS = new Set(["python", "ruby", "shell", "elixir", "php", "hcl", "terraform"]);
const DASH_COMMENTS = new Set(["lua"]);
// `@decorator` / `@Annotation` / Elixir's `@doc`/`@spec` module attributes.
const AT_ATTRIBUTES = new Set(["python", "typescript", "javascript", "java", "kotlin", "scala", "dart", "swift", "elixir"]);
const HASH_ATTRIBUTES = new Set(["rust", "php"]); // #[attr]
const BRACKET_ATTRIBUTES = new Set(["csharp", "cpp"]); // [Attr] / [[attr]]

// How far up a multi-line comment or attribute is followed before giving up.
const MAX_BLOCK_LINES = 200;

function isLineComment(t: string, lang: string, index: number): boolean {
  if (SLASH_COMMENTS.has(lang) && (t.startsWith("//") || (t.startsWith("/*") && t.endsWith("*/")))) return true;
  if (HASH_COMMENTS.has(lang) && t.startsWith("#") && !(index === 0 && t.startsWith("#!"))) return true;
  return DASH_COMMENTS.has(lang) && t.startsWith("--");
}

function isAttributeStart(t: string, lang: string): boolean {
  if (AT_ATTRIBUTES.has(lang) && /^@[A-Za-z_]/.test(t)) return true;
  if (HASH_ATTRIBUTES.has(lang) && /^#!?\[/.test(t)) return true;
  if (BRACKET_ATTRIBUTES.has(lang) && t.startsWith("[")) return true;
  return lang === "cpp" && /^template\b/.test(t);
}

// Opening minus closing brackets on a line, string literals ignored.
function bracketBalance(line: string): number {
  let balance = 0;
  for (const c of line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "")) {
    if (c === "(" || c === "[" || c === "{") balance++;
    else if (c === ")" || c === "]" || c === "}") balance--;
  }
  return balance;
}

// The first line of a multi-line comment or attribute that ENDS on
// lines[end], or undefined when lines[end] is not the end of one.
function blockStart(lines: readonly string[], end: number, lang: string): number | undefined {
  const t = lines[end]!.trim();
  const floor = Math.max(0, end - MAX_BLOCK_LINES);
  if (SLASH_COMMENTS.has(lang) && t.endsWith("*/")) {
    for (let j = end; j >= floor; j--) {
      const line = lines[j]!;
      const open = line.lastIndexOf("/*");
      if (open < 0) continue;
      // The opener must start its line: `x = 1; /* … */` is code, not a doc block.
      return line.trim().startsWith("/*") ? j : undefined;
    }
    return undefined;
  }
  if (lang === "elixir" && t.endsWith('"""')) {
    // `@doc """` … `"""` heredoc attribute.
    for (let j = end - 1; j >= floor; j--) if (lines[j]!.includes('"""')) return /^@\w+\s.*"""\s*$/.test(lines[j]!.trim()) ? j : undefined;
    return undefined;
  }
  if (lang === "cpp" && t.endsWith(">")) {
    // A template header split over several lines.
    for (let j = end; j >= floor && lines[j]!.trim() !== ""; j--) if (/^template\b/.test(lines[j]!.trim())) return j;
    return undefined;
  }
  if (!/[)\]}]$/.test(t)) return undefined;
  // A decorator/attribute whose arguments span lines: climb until the brackets
  // balance, and accept only if that line opens an attribute.
  let balance = 0;
  for (let j = end; j >= floor; j--) {
    const line = lines[j]!;
    if (line.trim() === "") return undefined;
    balance += bracketBalance(line);
    if (balance > 0) return undefined;
    if (balance === 0) return isAttributeStart(line.trim(), lang) ? j : undefined;
  }
  return undefined;
}

// The 0-based index of the first line of the comment/decorator run directly
// above lines[decl] (decl itself when there is none).
export function leadingBlockStart(lines: readonly string[], decl: number, lang: string): number {
  let top = decl;
  for (let i = decl - 1; i >= 0; ) {
    const t = lines[i]!.trim();
    if (t === "") break;
    if (isLineComment(t, lang, i) || (isAttributeStart(t, lang) && bracketBalance(t) === 0)) {
      top = i--;
      continue;
    }
    const start = blockStart(lines, i, lang);
    if (start === undefined) break;
    top = start;
    i = start - 1;
  }
  return top;
}
