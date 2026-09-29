import type { CodeSymbol } from "../types.js";
import { stripCommentMarkers, summarizeDocLines } from "../extract/doc-text.js";

// An identifier as the languages with Unicode names spell it (JS/TS, Go,
// Kotlin, Swift): `café`, `Ünïcode` and `日本語` are all legal names, and a
// `\w` rule cut the first at "caf" and skipped the others. Rules that use it
// need the `u` flag.
export const ID = String.raw`[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$\u200c\u200d]*`;

// A line-level extraction rule. `re` must capture the symbol name in a named
// group `name` (or capture group 1). One symbol is emitted per matching line
// (first rule wins), which keeps the heuristics cheap and predictable.
export interface Rule {
  re: RegExp;
  kind: string;
  exported?: boolean | ((m: RegExpExecArray, line: string) => boolean);
  // "member": the line must sit at the top level or directly in the body of a
  // type this scan already found (`class`, `struct`, …), never in a function
  // body. How a property (`let name: String`) is told from a local that reads
  // exactly the same. Needs the masked text: brace depth is read from it.
  scope?: "member";
}

// What the regex tier knows about a language beyond its rules: how to mask it,
// and how its doc comments look. Read by `annotate` below.
export interface Lexis {
  // Blank comments and string bodies, offsets and lines kept (the brace
  // languages). The rules then match code only, and a declaration's body is
  // found by matching its braces.
  mask?: (src: string) => string;
  // A line that is wholly a comment, which a doc comment is made of.
  comment: RegExp;
  // `/* … */` blocks document declarations too.
  block?: boolean;
  // Lines allowed between a doc comment and its declaration: annotations,
  // attributes, decorators.
  decoration?: RegExp;
  // Elixir documents a function with the `@doc` attribute above it.
  docAttr?: boolean;
}

// The kinds whose body holds members, for `scope: "member"` rules.
const TYPE_KINDS = new Set([
  "class", "struct", "enum", "interface", "protocol", "actor", "extension", "object", "trait", "mixin",
]);

// Run a list of rules line-by-line over file content. Deterministic and
// zero-dep — no parser, no AST, no LLM. Good enough to locate declarations and
// rank them; ripgrep covers everything inside bodies.
//
// With `masked` (see Lexis.mask) the rules read the masked line, so prose and
// strings that merely look like a declaration are not one; the signature still
// quotes the real line.
export function scan(rel: string, content: string, lang: string, rules: Rule[], masked?: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = content.split(/\r?\n/);
  const code = masked === undefined ? lines : masked.split(/\r?\n/);
  const owners = masked !== undefined && rules.some((r) => r.scope === "member") ? braceOwners(masked) : undefined;
  // Line (0-based) → kind of the symbol declared there, for member scoping.
  const kinds = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = code[i]!;
    if (!line.trim()) continue;
    for (const rule of rules) {
      if (rule.scope === "member") {
        const owner = owners?.[i];
        if (owner === undefined || (owner !== -1 && !ownedByType(kinds, code, owner))) continue;
      }
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = m.groups?.name ?? m[1];
      if (!name) continue;
      const exported =
        typeof rule.exported === "function" ? rule.exported(m, line) : rule.exported ?? false;
      kinds.set(i, rule.kind);
      out.push({
        name,
        kind: rule.kind,
        file: rel,
        line: i + 1,
        signature: lines[i]!.trim().slice(0, 200),
        exported,
        lang,
      });
      break;
    }
  }
  return out;
}

// Is the brace opened on line `owner` a type's body? The type is declared on
// that line, or on the line above when the brace sits alone on its own line.
function ownedByType(kinds: Map<number, string>, code: string[], owner: number): boolean {
  const kind = kinds.get(owner) ?? (code[owner]!.trim() === "{" ? kinds.get(owner - 1) : undefined);
  return kind !== undefined && TYPE_KINDS.has(kind);
}

// For each line, the line of the innermost `{` still open where it starts, or
// -1 at the top level.
function braceOwners(masked: string): Int32Array {
  const owners = new Int32Array(countLines(masked)).fill(-1);
  const open: number[] = [];
  let line = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked.charCodeAt(i);
    if (c === 123) open.push(line);
    else if (c === 125) open.pop();
    else if (c === 10) owners[++line] = open.length ? open[open.length - 1]! : -1;
  }
  return owners;
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

// Give regex-tier symbols the two fields the AST tier reads from the tree: the
// doc comment above each declaration, and, in a brace language, the line its
// body closes on. Without them a Swift or Dart index (no grammar) had no docs
// at all, and every consumer of a span (a symbol's body, complexity, the
// enclosing function of a call, replace_symbol_body) saw one line per symbol.
export function annotate(symbols: CodeSymbol[], content: string, lexis: Lexis, masked?: string): CodeSymbol[] {
  if (!symbols.length) return symbols;
  const lines = content.split(/\r?\n/);
  const spans = masked === undefined ? undefined : new BraceSpans(masked);
  return symbols.map((s) => {
    const doc = s.doc ?? docAbove(lines, s.line - 1, lexis);
    const endLine = s.endLine ?? spans?.endOf(s.line - 1, lines);
    if (doc === undefined && endLine === undefined) return s;
    return { ...s, ...(endLine !== undefined ? { endLine } : {}), ...(doc !== undefined ? { doc } : {}) };
  });
}

// The doc comment right above line `at` (0-based): a contiguous run of comment
// lines and `/* … */` blocks, with annotations skipped between it and the
// declaration. A blank line ends the run, as in the AST tier: a comment
// separated from what follows documents neither.
function docAbove(lines: string[], at: number, lexis: Lexis): string | undefined {
  let k = at - 1;
  while (k >= 0 && lexis.decoration?.test(lines[k]!)) k--;
  if (lexis.docAttr) {
    const attr = elixirDoc(lines, k);
    if (attr) return summarizeDocLines(attr);
  }
  const run: string[] = [];
  while (k >= 0) {
    const line = lines[k]!;
    if (lexis.comment.test(line)) {
      run.push(line);
      k--;
      continue;
    }
    if (!lexis.block || !/\*\/\s*$/.test(line)) break;
    // The block's opening line must start with `/*`: `f(); /* x */` is a
    // trailing comment on code, not a doc.
    let j = k;
    while (j >= 0 && !lines[j]!.includes("/*")) j--;
    if (j < 0 || !/^\s*\/\*(?!!)/.test(lines[j]!)) break;
    for (let t = k; t >= j; t--) run.push(lines[t]!);
    k = j - 1;
  }
  if (!run.length) return undefined;
  return summarizeDocLines(run.reverse().map(stripCommentMarkers));
}

// Elixir's `@doc "…"` or `@doc """ … """` ending on line `k`.
function elixirDoc(lines: string[], k: number): string[] | undefined {
  if (k < 0) return undefined;
  const one = /^\s*@doc\s+(?:~[sS])?"(.*)"\s*$/.exec(lines[k]!);
  if (one) return [one[1]!];
  if (!/^\s*"""\s*$/.test(lines[k]!)) return undefined;
  for (let j = k - 1; j >= 0 && k - j < 400; j--) {
    if (/^\s*@doc\s+(?:~[sS])?"""\s*$/.test(lines[j]!)) return lines.slice(j + 1, k);
    if (/"""/.test(lines[j]!)) return undefined;
  }
  return undefined;
}

// Brace matching over masked text: where each `{` closes.
class BraceSpans {
  private readonly closeOf = new Map<number, number>();
  private readonly lineStarts: number[] = [0];

  constructor(private readonly masked: string) {
    const open: number[] = [];
    for (let i = 0; i < masked.length; i++) {
      const c = masked.charCodeAt(i);
      if (c === 10) this.lineStarts.push(i + 1);
      else if (c === 123) open.push(i);
      else if (c === 125 && open.length) this.closeOf.set(open.pop()!, i);
    }
  }

  private lineOf(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  // The 1-based line where the body of the declaration on line `at` (0-based)
  // closes, or undefined when it has no body or the guess is not safe.
  //
  // The body is the first `{` outside parentheses and brackets (a default
  // argument's closure `f(cb = {})`, a generic list `Box[T]`), found before a
  // `;` (an abstract or one-line declaration) and before the next line that
  // starts a new statement at the declaration's indentation (a property with
  // no body). A wrapped signature's continuation lines, and an Allman `{` on
  // its own line, do not end the search.
  //
  // The span is trusted only when it closes on the line it opened, or on a line
  // that starts with `}` at the declaration's own indentation, which every
  // formatter produces. A brace the mask misread (a quote nested in an
  // interpolation) rarely lands there, and then the symbol keeps no endLine
  // rather than a wrong one: replace_symbol_body splices by it.
  endOf(at: number, lines: string[]): number | undefined {
    const masked = this.masked;
    const indent = /^\s*/.exec(lines[at]!)![0];
    let depth = 0;
    let line = at;
    for (let i = this.lineStarts[at]!; i < masked.length; i++) {
      const c = masked.charCodeAt(i);
      if (c === 10) {
        line++;
        if (line - at > 60 || line >= this.lineStarts.length) return undefined;
        const next = masked.slice(this.lineStarts[line]!, this.lineStarts[line + 1] ?? masked.length);
        const lead = /^\s*/.exec(next)![0];
        const first = next.charAt(lead.length);
        if (depth === 0 && first && !"{)]".includes(first) && lead.length <= indent.length) return undefined;
        continue;
      }
      if (c === 40 || c === 91) depth++;
      else if (c === 41 || c === 93) {
        if (--depth < 0) return undefined;
      } else if (depth === 0 && c === 59) return undefined;
      else if (depth === 0 && c === 123) {
        const close = this.closeOf.get(i);
        if (close === undefined) return undefined;
        const end = this.lineOf(close);
        const rest = masked.slice(close + 1, this.lineStarts[end + 1] ?? masked.length);
        if (end === this.lineOf(i)) {
          // A one-line body ends the declaration's own line. Anything after it
          // means the pair was part of the header (`<-chan struct{} {`, a
          // generic default `<T = {}>`), and the body is still ahead; so was a
          // pair on a later line (`| { valueOf(): T }` in a wrapped alias).
          if (end === at && /^[\s;,)\]}]*$/.test(rest)) return this.continued(end) ? undefined : end + 1;
          i = close;
          continue;
        }
        // `} | {`: an alias of a union of object types goes on past this brace.
        if (rest.includes("{")) return undefined;
        return lines[end]!.startsWith(indent + "}") && !this.continued(end) ? end + 1 : undefined;
      }
    }
    return undefined;
  }

  // Does the next code line after `line` continue its expression? A wrapped
  // conditional type (`… ? {}` then `: Other;`) or union reads as a one-line
  // body until its next line is seen.
  private continued(line: number): boolean {
    for (let k = line + 1; k < this.lineStarts.length; k++) {
      const text = this.masked.slice(this.lineStarts[k]!, this.lineStarts[k + 1] ?? this.masked.length).trim();
      if (text) return /^(?:[?:|&.]|=>)/.test(text);
    }
    return false;
  }
}

// Broad extension → language label table, used for the index's language
// histogram even when no symbol extractor exists for that language.
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rb": "ruby", ".rake": "ruby",
  ".java": "java",
  ".rs": "rust",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".php": "php", ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin",
  ".scala": "scala", ".sc": "scala", ".clj": "clojure", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".hs": "haskell", ".dart": "dart", ".lua": "lua",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".ksh": "shell", ".fish": "shell",
  ".hh": "cpp", ".m": "objective-c", ".mm": "objective-c",
  ".sql": "sql", ".graphql": "graphql", ".gql": "graphql", ".proto": "protobuf",
  ".md": "markdown", ".mdx": "markdown", ".rst": "restructuredtext", ".txt": "text",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml", ".ini": "ini",
  ".html": "html", ".css": "css", ".scss": "scss", ".vue": "vue", ".svelte": "svelte",
  ".astro": "astro",
  // Extended-tier AST languages (src/ast/loader.ts EXT_GRAMMAR). Without an
  // entry here `extToLang` answered "other", which `classify` reads as non-code
  // — so a real scan never called extractCode for them and they extracted
  // nothing, while the quality harness (which calls extractCode directly)
  // published a perfect score. The grammar still arrives via `grammars pull`;
  // absent it these fall back to the regex tier like any other language.
  ".zig": "zig", ".hcl": "hcl", ".tf": "terraform", ".tfvars": "terraform", ".sol": "solidity",
};

export function extToLang(ext: string): string {
  return EXT_LANG[ext] ?? "other";
}

const REEXPORT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// Blank out comments while PRESERVING every byte offset and line break, so a
// scan that runs over the result can still report real line numbers.
//
// WHY: the barrel scan below is a regex over raw text. `src/lang/common.ts` used
// to index its OWN doc comment — the line that documents the feature contains
// `export { A, B as C } from './x'`, so the engine emitted symbols named `A` and
// `C` from its own prose. Found by the label-free invariant "a symbol's span must
// actually contain its name".
//
// String-aware, because `const s = "// not a comment"` must not be blanked.
// Template literals are treated as plain strings: an `${…}` expression cannot
// legally contain an unterminated comment, so nesting adds nothing here.
export function blankComments(src: string): string {
  // One pass over char codes, copying the kept stretches as slices and the
  // comments as runs of spaces (newlines inside a block comment are kept so
  // offsets AND line numbers survive). The previous per-character
  // `split("")`/`join("")` allocated one string per byte of every file — the
  // single largest non-parser cost of extraction.
  const n = src.length;
  let out = "";
  let kept = 0; // start of the stretch not yet copied into `out`
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === SLASH) {
      const next = src.charCodeAt(i + 1);
      if (next === SLASH) {
        out += src.slice(kept, i);
        const start = i;
        while (i < n && src.charCodeAt(i) !== NEWLINE) i++;
        out += " ".repeat(i - start);
        kept = i;
        continue;
      }
      if (next === STAR) {
        out += src.slice(kept, i);
        let run = 0;
        while (i < n && !(src.charCodeAt(i) === STAR && src.charCodeAt(i + 1) === SLASH)) {
          if (src.charCodeAt(i) === NEWLINE) {
            out += " ".repeat(run) + "\n";
            run = 0;
          } else run++;
          i++;
        }
        // Blank the closing delimiter too, or `*/` would read as code.
        if (i < n) run++;
        if (i + 1 < n) run++;
        out += " ".repeat(run);
        i += 2;
        kept = Math.min(i, n);
        continue;
      }
      i++;
      continue;
    }
    if (c === DQUOTE || c === SQUOTE || c === BACKTICK) {
      i++;
      while (i < n && src.charCodeAt(i) !== c) {
        if (src.charCodeAt(i) === BACKSLASH) i++; // skip the escaped char
        i++;
      }
      i++;
      continue;
    }
    i++;
  }
  return kept === 0 ? src : out + src.slice(kept);
}

const SLASH = 47; // "/"
const STAR = 42; // "*"
const NEWLINE = 10; // "\n"
const DQUOTE = 34; // '"'
const SQUOTE = 39; // "'"
const BACKTICK = 96; // "`"
const BACKSLASH = 92; // "\\"

// Per-file re-export ceiling. Raised from 60: this engine's own public barrel
// (src/engine.ts) declares ~200 names, so 60 hid two thirds of its API — and it
// hid them SILENTLY, which is the one thing the walk's `capped` doctrine forbids.
// Crossing it now sets FileRecord.truncated (see extract/code.ts).
export const MAX_REEXPORTS = 400;


// Barrel re-exports (`export { A, B as C } from './x'`, `export * from './y'`).
// The line-based lang extractor can't capture multi-name lists, but these ARE
// the public facade of a module — so list them as exported symbols here.
//
// An ALIAS with no `from` clause (`export { b as c }`) renames an in-file
// declaration — `localSymbols` (already extracted by the AST or regex tier)
// lets us resolve `b` and mirror ITS kind, declaration line, and endLine (AST
// tier only) onto `c` (e.g. "function" at b's own line), so the alias reads
// as the real symbol it is — citeable at its actual declaration — rather than
// the generic "reexport" pinned to the export statement's line.
// A true cross-module re-export (`export { b as c } from "./mod"`) has no
// local `b` to resolve — and an alias the local pass genuinely can't see
// (destructured/ambient/etc.) falls back the same way — both keep "reexport"
// and cite the export statement's own line, the only line they have.
//
// Shared by extractCode (extract/code.ts) AND the standalone extractSymbols
// (lang/registry.ts) — ultradoc and other direct extractSymbols consumers hit
// the same barrels a repo scan does, so both entry points must agree; this is
// the one place the alias-mirroring logic lives, reused rather than
// reimplemented on either side.
export function extractReexports(rel: string, content: string, localSymbols: CodeSymbol[]): CodeSymbol[] {
  if (!REEXPORT_EXTS.has(rel.slice(rel.lastIndexOf(".")))) return [];
  const lang = /\.(ts|tsx|mts|cts)$/.test(rel) ? "typescript" : "javascript";
  const out: CodeSymbol[] = [];
  const seen = new Set<string>();
  // 1-based line of a character offset. Line starts are computed lazily, once
  // per file — the previous `slice(0, idx).split(...)` re-scanned the whole
  // prefix for every re-exported name, quadratic on a 200-name barrel.
  let lineStarts: number[] | undefined;
  const lineAt = (idx: number): number => {
    if (!lineStarts) {
      lineStarts = [0];
      for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    // Binary search: number of line starts ≤ idx.
    let lo = 0;
    let hi = lineStarts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid]! <= idx) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Keyed on the whole CodeSymbol (not just kind) so the alias branch below
  // can also cite the resolved declaration's own line/endLine, not just mirror
  // its kind.
  const localDeclOf = new Map<string, CodeSymbol>();
  for (const s of localSymbols) if (!localDeclOf.has(s.name)) localDeclOf.set(s.name, s);

  // Scanned over comment-blanked text, so the engine cannot index prose that
  // merely QUOTES an export statement. Offsets are preserved, so `lineAt` below
  // still reports real lines.
  const scanned = blankComments(content);
  const named = /export\s*\{([\s\S]*?)\}\s*(?:from\s*['"]([^'"]+)['"])?\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(scanned)) && out.length < MAX_REEXPORTS) {
    const from = m[2];
    // Offset of the name list inside `content`, so each name can cite ITS OWN
    // line. A formatter-wrapped 20-name barrel used to pin every one of them to
    // the `export {` line, sending jump-to-definition to the wrong place.
    const listAt = m.index + m[0].indexOf("{") + 1;
    let cursor = 0;
    for (const part of m[1]!.split(",")) {
      const partAt = listAt + cursor;
      cursor += part.length + 1; // +1 for the comma the split consumed
      const p = part.trim().replace(/^type\s+/, "");
      const as = /^(\S+)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
      const orig = as ? as[1]! : p;
      const name = as ? as[2]! : p;
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === "default" || seen.has(name)) continue;
      seen.add(name);
      // A resolved decl means this is a same-file alias: cite ITS line (and
      // endLine, when the AST tier populated one) rather than the export
      // statement's — an unresolved alias or a `from`-clause re-export has no
      // local declaration to point at, so it keeps lineAt(m.index) below.
      const decl = !from ? localDeclOf.get(orig) : undefined;
      out.push({
        name, kind: decl?.kind ?? "reexport", file: rel, line: decl ? decl.line : lineAt(partAt),
        ...(decl?.endLine !== undefined ? { endLine: decl.endLine } : {}),
        signature: from ? `export { ${name} } from "${from}"` : `export { ${name} }`,
        exported: true, lang,
      });
    }
  }

  const star = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g;
  while ((m = star.exec(scanned)) && out.length < MAX_REEXPORTS) {
    const ns = m[1];
    const from = m[2]!;
    const key = "*" + (ns ?? from);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: ns ?? `* (${from})`, kind: ns ? "reexport" : "reexport-all", file: rel,
      line: lineAt(m.index), signature: `export * ${ns ? `as ${ns} ` : ""}from "${from}"`,
      exported: true, lang,
    });
  }
  return out;
}
