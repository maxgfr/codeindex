// Cyclomatic-complexity estimates from branch-token counting over symbol line
// spans (language-generic: if/for/while/case/catch families plus &&, ||, and
// ternaries), and the risk ranking nobody else in the space ships: complexity
// × git churn — files that are BOTH hard to reason about AND constantly
// changed are where defects concentrate.
//
// Only CODE is counted. The branch regex used to run over raw text, so prose
// scored: flask's `send_file` is one `return` statement, and its docstring
// ("when", "if", "for" twelve times) ranked it the most complex function of
// helpers.py; a third of flask/app.py's branch tokens were docstring words.
// Comments and string literals are blanked first (per language family, line
// breaks kept so symbol spans still line up), and a keyword read as a member
// (`re.match(…)`, `.catch(…)`) is not a branch. Python, Ruby, Lua, Perl and
// Elixir spell their boolean operators `and`/`or`; those count like && and ||.
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { CodeSymbol } from "./types.js";
import type { RepoScan } from "./scan.js";
import { familyOf } from "./calls.js";
import { fileComplexityFor } from "./derived.js";
import { readText } from "./walk.js";
import { byStr } from "./sort.js";

const BRANCH_RE =
  /(?<![.\w$])(?:if|elif|elsif|else\s+if|for|foreach|while|until|unless|case|when|match|catch|rescue|except)\b|&&|\|\||(?<![?:])\?(?![?.:])/g;
const WORD_BOOL_RE = /(?<![.\w$])(?:and|or)\b/g;
const WORD_BOOL = new Set(["python", "ruby", "lua", "perl", "elixir"]);

// Declarations that hold other declarations. Their span is the sum of their
// members, so ranking them beside functions put flask's `Flask` class (221)
// above its most complex method; they are left out of the ranking.
const CONTAINER_KINDS = new Set([
  "class", "interface", "struct", "trait", "impl", "module", "mod", "namespace", "object",
  "enum", "record", "protocol", "union", "extension", "mixin", "type", "package",
]);

interface Syntax {
  line: string[]; // line-comment markers
  block: boolean; // /* … */
  triple: boolean; // Python """…""" / '''…'''
  backtick: "template" | "raw" | null; // JS template literal / Go raw string (both multi-line)
  charOnly: boolean; // a lone ' is a lifetime or a prime (Rust, Haskell…), not a string
}
const C_LIKE: Syntax = { line: ["//"], block: true, triple: false, backtick: null, charOnly: false };
const HASH: Syntax = { line: ["#"], block: false, triple: false, backtick: null, charOnly: false };
const SYNTAX: Record<string, Syntax> = {
  js: { ...C_LIKE, backtick: "template" },
  go: { ...C_LIKE, backtick: "raw" },
  rust: { ...C_LIKE, charOnly: true },
  php: { ...C_LIKE, line: ["//", "#"] },
  python: { ...HASH, triple: true },
  ruby: HASH,
  shell: HASH,
  perl: HASH,
  r: HASH,
  elixir: HASH,
  julia: HASH,
  terraform: { ...C_LIKE, line: ["//", "#"] },
  hcl: { ...C_LIKE, line: ["//", "#"] },
  lua: { ...HASH, line: ["--"] },
  sql: { ...C_LIKE, line: ["--"] },
  haskell: { ...HASH, line: ["--"], charOnly: true },
  elm: { ...HASH, line: ["--"], charOnly: true },
  erlang: { ...HASH, line: ["%"] },
  clojure: { ...HASH, line: [";"], charOnly: true },
};

const openers = new Map<Syntax, RegExp>();
function openerOf(syn: Syntax): RegExp {
  let re = openers.get(syn);
  if (!re) {
    const chars = new Set(["\"", "'", ...syn.line.map((m) => m[0]!)]);
    if (syn.block) chars.add("/");
    if (syn.backtick) chars.add("`");
    re = new RegExp(`[${[...chars].map((c) => "\\" + c).join("")}]`, "g");
    openers.set(syn, re);
  }
  return re;
}

const CHAR_LITERAL = /'(?:\\.[^'\n]{0,8}|[^\\'\n])'/y;

/**
 * `source` with its comments and string literals blanked to spaces, every line
 * break kept. `lang` picks the comment and string syntax; without one, C-style
 * comments and quotes.
 */
export function codeOnly(source: string, lang?: string): string {
  const syn = (lang && SYNTAX[familyOf(lang)]) || C_LIKE;
  const n = source.length;
  let out = "";
  let kept = 0;
  const blank = (from: number, to: number): void => {
    out += source.slice(kept, from) + source.slice(from, to).replace(/[^\n]/g, " ");
    kept = to;
  };
  // Index just past the closing `quote`, from `i` (inside the literal).
  const close = (i: number, quote: string, escapes: boolean, multiline: boolean): number => {
    while (i < n) {
      const c = source[i]!;
      if (escapes && c === "\\") i += 2;
      else if (source.startsWith(quote, i)) return i + quote.length;
      else if (c === "\n" && !multiline) return i;
      else i++;
    }
    return n;
  };
  // Jump from one character that can open a comment or a literal to the next
  // instead of stepping through the code between them.
  const opener = openerOf(syn);
  let i = 0;
  while (i < n) {
    opener.lastIndex = i;
    if (!opener.exec(source)) break;
    i = opener.lastIndex - 1;
    const c = source[i]!;
    if (syn.block && c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const to = end === -1 ? n : end + 2;
      blank(i, to);
      i = to;
    } else if (syn.line.some((m) => source.startsWith(m, i))) {
      const end = source.indexOf("\n", i);
      const to = end === -1 ? n : end;
      blank(i, to);
      i = to;
    } else if (syn.triple && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const to = close(i + 3, source.slice(i, i + 3), true, true);
      blank(i, to);
      i = to;
    } else if (c === '"' || (c === "'" && !syn.charOnly)) {
      const to = close(i + 1, c, true, false);
      blank(i, to);
      i = to;
    } else if (c === "'") {
      CHAR_LITERAL.lastIndex = i;
      const m = CHAR_LITERAL.exec(source);
      if (m) blank(i, i + m[0].length);
      i += m ? m[0].length : 1;
    } else if (c === "`" && syn.backtick) {
      const to = close(i + 1, "`", syn.backtick === "template", true);
      blank(i, to);
      i = to;
    } else i++;
  }
  return kept === 0 ? source : out + source.slice(kept);
}

// Branch tokens in text that is already code only.
function branches(code: string, lang?: string): number {
  let count = (code.match(BRANCH_RE) ?? []).length;
  if (lang && WORD_BOOL.has(familyOf(lang))) count += (code.match(WORD_BOOL_RE) ?? []).length;
  return count;
}

/** Branch count + 1 over the code of `source`, its comments and strings aside. */
export function complexityOfSource(source: string, lang?: string): number {
  return 1 + branches(codeOnly(source, lang), lang);
}

// A file argument as the index keys it — `./gin.go`, `gin.go` and the
// absolute path all name gin.go — or an error saying it is not indexed. An
// unknown file used to answer [] with exit 0, which reads exactly like a file
// with no symbols.
export function indexedFile(scan: RepoScan, target: string): string {
  const path = isAbsolute(target) ? relative(resolve(scan.root), target) : target;
  const rel = posix.normalize(path.replace(/\\/g, "/")).replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!scan.files.some((f) => f.rel === rel)) throw new Error(`no such file in the index: ${target}`);
  return rel;
}

export interface SymbolComplexity {
  file: string;
  name: string;
  line: number;
  endLine?: number;
  complexity: number;
}

// Per-symbol complexity for one file (or the whole repo when rel is omitted),
// sorted most-complex first. Symbols without an endLine (regex tier) fall back
// to a single-line estimate and naturally rank low — labeled by the absent
// endLine rather than silently guessed. Containers are not ranked, and a
// function's score leaves out the declarations nested in it (an inner
// function or class scores on its own).
export function symbolComplexity(scan: RepoScan, rel?: string, top = 50): SymbolComplexity[] {
  const out: SymbolComplexity[] = [];
  for (const f of scan.files) {
    if (f.kind !== "code") continue;
    if (rel && f.rel !== rel) continue;
    if (!f.symbols.length) continue;
    const lines = codeOnly(readText(join(scan.root, f.rel)), f.lang).split("\n");
    const spans = f.symbols
      .filter((s) => s.kind !== "reexport" && s.kind !== "reexport-all")
      .sort((a, b) => a.line - b.line || (b.endLine ?? b.line) - (a.endLine ?? a.line));
    spans.forEach((s, i) => {
      if (CONTAINER_KINDS.has(s.kind)) return;
      const end = s.endLine ?? s.line;
      const body = lines.slice(s.line - 1, end);
      for (const inner of nestedIn(spans, i, end)) {
        for (let l = inner.line; l <= inner.endLine!; l++) body[l - s.line] = "";
      }
      const entry: SymbolComplexity = { file: f.rel, name: s.name, line: s.line, complexity: 1 + branches(body.join("\n"), f.lang) };
      if (s.endLine !== undefined) entry.endLine = s.endLine;
      out.push(entry);
    });
  }
  out.sort((a, b) => b.complexity - a.complexity || byStr(a.file, b.file) || a.line - b.line);
  return out.slice(0, top);
}

// The declarations strictly inside spans[i] (sorted by line, widest first):
// they start after it, or on its line and end before it does.
function nestedIn(spans: CodeSymbol[], i: number, end: number): CodeSymbol[] {
  const outer = spans[i]!;
  const inner: CodeSymbol[] = [];
  for (let j = i + 1; j < spans.length && spans[j]!.line <= end; j++) {
    const t = spans[j]!;
    if (t.endLine === undefined || t.endLine > end) continue;
    if (t.line > outer.line || t.endLine < end) inner.push(t);
  }
  return inner;
}

export interface RiskHotspot {
  file: string;
  complexity: number; // whole-file branch count + 1
  commits: number;
  // (commits + 1) × complexity — churn amplifies complexity; a complex but
  // frozen file ranks below a complex file under constant change.
  score: number;
}

export function riskHotspots(scan: RepoScan, churn: Map<string, number>, top = 20): RiskHotspot[] {
  // Per-file branch counts memoized per scan (src/derived.ts): the first call
  // still reads every code file from disk, repeat calls become map lookups.
  // fileComplexityFor covers exactly the code files filtered below, so the
  // lookup always hits.
  const complexityByFile = fileComplexityFor(scan);
  const out: RiskHotspot[] = scan.files
    .filter((f) => f.kind === "code")
    .map((f) => {
      const complexity = complexityByFile.get(f.rel)!;
      const commits = churn.get(f.rel) ?? 0;
      return { file: f.rel, complexity, commits, score: (commits + 1) * complexity };
    });
  out.sort((a, b) => b.score - a.score || byStr(a.file, b.file));
  return out.slice(0, top);
}
