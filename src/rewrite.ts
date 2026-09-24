// Command rewriting: map an expensive full-tree text search onto the engine's
// indexed equivalent, so an agent shell that runs `grep -r foo .` gets bounded,
// structured, gitignore-correct hits instead of an unbounded wall of text.
//
// The contract is a HOST contract, not a shell one: the caller hands us a full
// command line and takes our stdout as the command to run instead (iterion's
// `rewriters` plugin kind, rtk's generalization). That makes a wrong rewrite
// far worse than no rewrite — it silently changes what the agent asked for.
// So this module is deliberately, aggressively conservative:
//
//   * anything the parser cannot prove it understands → NO rewrite
//   * any shell construct outside single quotes that the shell would expand or
//     interpret (pipes, redirection, substitution, chaining, globbing, braces,
//     tildes) → NO rewrite
//   * any flag not on the explicit allowlist of its binary → NO rewrite
//   * a pattern whose dialect (POSIX BRE/ERE, Rust regex) cannot be restated
//     exactly as the JavaScript regex `codeindex grep` runs → NO rewrite
//
// A refusal is cheap (the original command runs untouched); a bad rewrite is
// not. Every branch here defaults to refusing.
//
// What a rewrite DOES change, on purpose: the output (JSON hits, capped, with
// the cap reported on stderr) and the universe's noise floor — gitignored
// files, lockfiles, binaries, minified bundles and files over 1 MiB are never
// searched. What it must NOT change: which committed text files are searched
// (hence `--ignore-dir .codeindex`, which lifts the default vendor/build/out/tmp
// skips none of grep, rg or git grep make) and what the pattern matches.
import { compilePattern } from "./grep.js";
import { escapeRegExp } from "./util.js";

// Split on whitespace the way a POSIX shell would, or return undefined the
// moment the line holds anything the shell would expand or interpret. Single
// quotes are opaque; inside double quotes only \$ \` \" \\ are escapes and a
// bare $ or ` is an expansion; outside quotes a backslash quotes the next
// character. Metacharacters are refused only where the shell sees them, so
// `rg 'foo|bar'` is a pattern, not a pipeline. An unquoted * ? [ is kept but
// marks its word `globbed`: the shell would expand it against the files in
// the cwd.
function lex(line: string): { value: string; globbed: boolean }[] | undefined {
  const out: { value: string; globbed: boolean }[] = [];
  let cur = "";
  let started = false; // a quoted empty string is still an argument
  let globbed = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return undefined; // unterminated quote
      cur += line.slice(i + 1, end);
      started = true;
      i = end;
    } else if (c === '"') {
      started = true;
      for (i++; ; i++) {
        const d = line[i];
        if (d === undefined) return undefined; // unterminated quote
        if (d === '"') break;
        if (d === "$" || d === "`") return undefined; // expansion
        if (d === "\\") {
          const n = line[i + 1];
          if (n === "$" || n === "`" || n === '"' || n === "\\") {
            cur += n;
            i++;
            continue;
          }
          if (n === "\n") return undefined;
        }
        cur += d;
      }
    } else if (c === "\\") {
      const n = line[i + 1];
      if (n === undefined || n === "\n" || n === "\r") return undefined;
      cur += n;
      started = true;
      i++;
    } else if (c === " " || c === "\t") {
      if (started || cur) out.push({ value: cur, globbed });
      cur = "";
      started = false;
      globbed = false;
    } else if (/[|&;<>()$`\n\r{}]/.test(c)) {
      return undefined; // control operators, expansions, brace expansion
    } else if ((c === "#" || c === "~") && !started && !cur) {
      return undefined; // a comment, a tilde expansion
    } else {
      if (c === "*" || c === "?" || c === "[") globbed = true;
      cur += c;
    }
  }
  if (started || cur) out.push({ value: cur, globbed });
  return out;
}

export function tokenize(line: string): string[] | undefined {
  return lex(line)?.map((t) => t.value);
}

// Wrap a token so the shell reproduces it verbatim. Single-quoting is total
// (no escapes are interpreted inside), so the only case needing care is a
// literal single quote, spliced via the standard '\'' idiom.
export function shellQuote(s: string): string {
  if (s !== "" && !/[^A-Za-z0-9_\-./=@:]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

type Dialect = "bre" | "ere" | "rust";

interface Parsed {
  patterns: string[];
  dialect: Dialect;
  fixed: boolean;
  word: boolean;
  ignoreCase: boolean;
  smartCase: boolean;
  // Already in the engine's rooted glob dialect, in the caller's order.
  includes: string[];
  excludes: string[];
  excludeDirs: string[];
  // Set when an exclusion came before an inclusion: grep and rg then let the
  // LATER rule win for a file matching both, where codeindex always excludes.
  orderSensitive: boolean;
  types: string[];
  paths: string[];
  recursive: boolean;
  filesOnly: boolean;
  noGitignore: boolean;
}

// ---------------------------------------------------------------------------
// argv → flags
// ---------------------------------------------------------------------------

interface Flag {
  name: string;
  value?: string;
}

// Split argv into flags (short clusters expanded, `--x=v` split) and
// positionals. `takesValue` names the flags that consume an argument — a value
// attached to a short flag (`-tpy`, `-efoo`) ends its cluster.
function splitArgs(
  args: string[],
  takesValue: Set<string>,
): { flags: Flag[]; positionals: string[]; afterDashDash: number } | undefined {
  const flags: Flag[] = [];
  const positionals: string[] = [];
  let afterDashDash = -1; // index in positionals where `--` put us
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      afterDashDash = positionals.length;
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      let value = eq === -1 ? undefined : a.slice(eq + 1);
      if (takesValue.has(name) && value === undefined) {
        value = args[++i];
        if (value === undefined) return undefined;
      }
      flags.push({ name, value });
    } else if (a.startsWith("-") && a !== "-") {
      for (let j = 1; j < a.length; j++) {
        const name = `-${a[j]}`;
        if (!takesValue.has(name)) {
          flags.push({ name });
          continue;
        }
        const value = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if (value === undefined) return undefined;
        flags.push({ name, value });
        break;
      }
    } else positionals.push(a);
  }
  return { flags, positionals, afterDashDash };
}

function fresh(dialect: Dialect, recursive: boolean): Parsed {
  return {
    patterns: [],
    dialect,
    fixed: false,
    word: false,
    ignoreCase: false,
    smartCase: false,
    includes: [],
    excludes: [],
    excludeDirs: [],
    orderSensitive: false,
    types: [],
    paths: [],
    recursive,
    filesOnly: false,
    noGitignore: false,
  };
}

function include(p: Parsed, glob: string | undefined): boolean {
  if (glob === undefined) return false;
  if (p.excludes.length) p.orderSensitive = true;
  p.includes.push(glob);
  return true;
}
function exclude(p: Parsed, glob: string | undefined): boolean {
  if (glob === undefined) return false;
  p.excludes.push(glob);
  return true;
}
// A directory exclusion prunes whole trees and never competes with a file
// inclusion, so it does not make the rule order matter.
function excludeDir(p: Parsed, glob: string | undefined): boolean {
  if (glob === undefined) return false;
  p.excludeDirs.push(glob);
  return true;
}

// Glob characters the engine's dialect implements (`*`, `**`, `?`); classes,
// braces and escapes it does not.
const UNSUPPORTED_GLOB = /[[\]{}\\]/;

// GNU grep --include/--exclude/--exclude-dir match a BASE name at any depth.
function baseNameGlob(g: string | undefined, dir = false): string | undefined {
  if (!g || g.includes("/") || UNSUPPORTED_GLOB.test(g)) return undefined;
  return dir ? `**/${g}/**` : `**/${g}`;
}

// rg -g is gitignore-style: a slash-less glob matches a base name at any
// depth, one with a slash is anchored at the search root.
function rgGlob(g: string | undefined, rootIsRepo: boolean): string | undefined {
  if (!g || UNSUPPORTED_GLOB.test(g) || g.endsWith("/")) return undefined;
  if (!g.includes("/")) return `**/${g}`;
  return rootIsRepo ? g.replace(/^\//, "") : undefined;
}

// GNU grep / egrep. `-r` is required: a non-recursive `grep pattern file.ts` is
// already cheap and its semantics (one file, text output) are not what the
// indexed search provides.
function parseGrep(bin: string, args: string[]): Parsed | undefined {
  const split = splitArgs(args, new Set(["-e", "--regexp", "--include", "--exclude", "--exclude-dir"]));
  if (!split) return undefined;
  const p = fresh(bin === "egrep" ? "ere" : "bre", false);
  for (const { name, value } of split.flags) {
    switch (name) {
      case "-r":
      case "-R":
      case "--recursive":
      case "--dereference-recursive":
        p.recursive = true;
        break;
      case "-i":
      case "-y":
      case "--ignore-case":
        p.ignoreCase = true;
        break;
      case "--no-ignore-case":
        p.ignoreCase = false;
        break;
      case "-E":
      case "--extended-regexp":
        p.dialect = "ere";
        break;
      case "-G":
      case "--basic-regexp":
        p.dialect = "bre";
        break;
      case "-F":
      case "--fixed-strings":
        p.fixed = true;
        break;
      case "-w":
      case "--word-regexp":
        p.word = true;
        break;
      case "-e":
      case "--regexp":
        p.patterns.push(value!);
        break;
      case "-l":
      case "--files-with-matches":
        p.filesOnly = true;
        break;
      case "--include":
        if (!include(p, baseNameGlob(value))) return undefined;
        break;
      case "--exclude":
        if (!exclude(p, baseNameGlob(value))) return undefined;
        break;
      case "--exclude-dir":
        if (!excludeDir(p, baseNameGlob(value, true))) return undefined;
        break;
      // Presentation only — every hit carries file + line, binaries are never
      // searched, and there is no colour to turn off.
      case "-n":
      case "--line-number":
      case "-H":
      case "--with-filename":
      case "-s":
      case "--no-messages":
      case "-I":
        break;
      case "--color":
      case "--colour":
        if (value !== undefined && !["never", "auto", "always"].includes(value)) return undefined;
        break;
      default:
        return undefined;
    }
  }
  if (!positionalsInto(p, split.positionals)) return undefined;
  return p;
}

// ripgrep. Recursive by default; `-r` is --replace here, NOT --recursive.
function parseRg(args: string[]): Parsed | undefined {
  const split = splitArgs(
    args,
    new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-j", "--threads", "--sort"]),
  );
  if (!split) return undefined;
  const p = fresh("rust", true);
  let unrestricted = 0;
  const pending: { glob: string; negated: boolean }[] = [];
  for (const { name, value } of split.flags) {
    switch (name) {
      case "-i":
      case "--ignore-case":
        p.ignoreCase = true;
        p.smartCase = false;
        break;
      case "-s":
      case "--case-sensitive":
        p.ignoreCase = false;
        p.smartCase = false;
        break;
      case "-S":
      case "--smart-case":
        p.smartCase = true;
        p.ignoreCase = false;
        break;
      case "-F":
      case "--fixed-strings":
        p.fixed = true;
        break;
      case "-w":
      case "--word-regexp":
        p.word = true;
        break;
      case "-e":
      case "--regexp":
        p.patterns.push(value!);
        break;
      case "-l":
      case "--files-with-matches":
        p.filesOnly = true;
        break;
      case "-g":
      case "--glob":
        // Translated once the search path is known (a slashed glob is anchored
        // at it).
        pending.push({ glob: value!.replace(/^!/, ""), negated: value!.startsWith("!") });
        break;
      case "-t":
      case "--type":
      case "-T":
      case "--type-not": {
        const globs = RG_TYPES[value!];
        if (!globs) return undefined;
        if (name === "-t" || name === "--type") {
          for (const g of globs) if (!include(p, `**/${g}`)) return undefined;
          p.types.push(value!);
        } else for (const g of globs) exclude(p, `**/${g}`);
        break;
      }
      case "--no-ignore":
      case "--no-ignore-vcs":
        p.noGitignore = true;
        break;
      case "-u":
      case "--unrestricted":
        // -u lifts ignore files; -uu also hidden files (the engine searches
        // those anyway); -uuu adds binaries, which the engine never searches.
        if (++unrestricted > 2) return undefined;
        p.noGitignore = true;
        break;
      case "--sort":
        if (value !== "path") return undefined; // hits are always sorted by path
        break;
      case "-n":
      case "--line-number":
      case "-N":
      case "--no-line-number":
      case "-H":
      case "--with-filename":
      case "-I":
      case "--no-filename":
      case "--no-heading":
      case "--heading":
      case "--column":
      case "-p":
      case "--pretty":
      case "--hidden":
      case "-.":
      case "--sort-files":
      case "-j":
      case "--threads":
        break;
      case "--color":
        if (value !== undefined && !["never", "auto", "always", "ansi"].includes(value)) return undefined;
        break;
      default:
        return undefined; // includes -r (--replace), -A/-B/-C, -c, -v, -o, -m…
    }
  }
  if (!positionalsInto(p, split.positionals)) return undefined;
  // rg lets an override glob beat the type filter: `-t py -g '*.md'` searches
  // both. The engine ANDs them, so the mix refuses.
  if (p.types.length && pending.some((g) => !g.negated)) return undefined;
  for (const { glob, negated } of pending) {
    const g = rgGlob(glob, p.paths.length === 0);
    if (!(negated ? exclude(p, g) : include(p, g))) return undefined;
  }
  return p;
}

// `git grep [flags] <pattern> [-- <pathspec>…]`. Searches the tree under the
// current directory (recursive by default). Anything before `--` after the
// pattern would be a revision: refused.
function parseGitGrep(args: string[]): Parsed | undefined {
  const split = splitArgs(args, new Set(["-e"]));
  if (!split) return undefined;
  const p = fresh("bre", true);
  for (const { name, value } of split.flags) {
    switch (name) {
      case "-i":
      case "-y":
      case "--ignore-case":
        p.ignoreCase = true;
        break;
      case "-E":
      case "--extended-regexp":
        p.dialect = "ere";
        break;
      case "-G":
      case "--basic-regexp":
        p.dialect = "bre";
        break;
      case "-F":
      case "--fixed-strings":
        p.fixed = true;
        break;
      case "-w":
      case "--word-regexp":
        p.word = true;
        break;
      case "-e":
        p.patterns.push(value!);
        break;
      case "-l":
      case "--files-with-matches":
      case "--name-only":
        p.filesOnly = true;
        break;
      case "-n":
      case "--line-number":
      case "-I":
      case "-r":
      case "--recursive":
      case "--no-color":
      case "--full-name":
        break;
      default:
        return undefined;
    }
  }
  const { positionals, afterDashDash } = split;
  const beforeDashDash = afterDashDash === -1 ? positionals.length : afterDashDash;
  if (p.patterns.length === 0) {
    if (beforeDashDash === 0) return undefined;
    p.patterns.push(positionals[0]!);
    if (beforeDashDash > 1) return undefined; // a revision
  } else if (beforeDashDash > 0) return undefined;
  // Pathspecs are OR-ed: one plain path (a scope), or `*`-globs without a
  // slash (git's `*` crosses directories: `*.ts` ≡ `**/*.ts`), not a mix.
  const specs = afterDashDash === -1 ? [] : positionals.slice(afterDashDash);
  const plain = specs.filter((s) => !/[*?]/.test(s));
  const globbed = specs.filter((s) => /[*?]/.test(s));
  if (specs.some((s) => s.startsWith(":") || UNSUPPORTED_GLOB.test(s))) return undefined; // pathspec magic
  if (plain.length > 1 || (plain.length && globbed.length)) return undefined;
  for (const g of globbed) if (g.includes("/") || !include(p, `**/${g}`)) return undefined;
  p.paths.push(...plain);
  return p;
}

// With -e patterns bound, every positional is a path; otherwise the first is
// the pattern.
function positionalsInto(p: Parsed, positionals: string[]): boolean {
  const rest = [...positionals];
  if (p.patterns.length === 0) {
    const first = rest.shift();
    if (first === undefined) return false;
    p.patterns.push(first);
  }
  p.paths = rest;
  return true;
}

// rg's built-in types (rg 14 `--type-list`), bracket classes expanded.
const RG_TYPES: Record<string, string[]> = {
  c: ["*.c", "*.h", "*.H", "*.c.in", "*.h.in", "*.H.in", "*.cats"],
  cpp: [
    "*.C", "*.h", "*.H", "*.C.in", "*.h.in", "*.H.in", "*.cpp", "*.hpp", "*.cpp.in", "*.hpp.in", "*.cxx",
    "*.hxx", "*.cxx.in", "*.hxx.in", "*.cc", "*.cc.in", "*.hh", "*.hh.in", "*.inl",
  ],
  cs: ["*.cs"],
  csharp: ["*.cs"],
  css: ["*.css", "*.scss"],
  go: ["*.go"],
  html: ["*.ejs", "*.htm", "*.html"],
  java: ["*.java", "*.jsp", "*.jspx", "*.properties"],
  js: ["*.cjs", "*.js", "*.jsx", "*.mjs", "*.vue"],
  json: ["*.json", "*.sarif", "composer.lock"],
  kotlin: ["*.kt", "*.kts"],
  lua: ["*.lua"],
  markdown: ["*.markdown", "*.md", "*.mdown", "*.mdwn", "*.mdx", "*.mkd", "*.mkdn"],
  md: ["*.markdown", "*.md", "*.mdown", "*.mdwn", "*.mdx", "*.mkd", "*.mkdn"],
  php: ["*.php", "*.php3", "*.php4", "*.php5", "*.php7", "*.php8", "*.pht", "*.phtml"],
  py: ["*.py", "*.pyi"],
  ruby: ["*.gemspec", "*.rb", "*.rbw", ".irbrc", "Gemfile", "Rakefile", "config.ru"],
  rust: ["*.rs"],
  scala: ["*.sbt", "*.scala"],
  sql: ["*.psql", "*.sql"],
  swift: ["*.swift"],
  toml: ["*.toml", "Cargo.lock"],
  ts: ["*.cts", "*.mts", "*.ts", "*.tsx"],
  typescript: ["*.cts", "*.mts", "*.ts", "*.tsx"],
  txt: ["*.txt"],
  yaml: ["*.yaml", "*.yml"],
};

// ---------------------------------------------------------------------------
// Pattern dialects → JavaScript
// ---------------------------------------------------------------------------

// POSIX named classes, as the C locale defines them (and Rust's ASCII classes).
const POSIX_CLASSES: Record<string, string> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\r\\f\\v",
  blank: " \\t",
  xdigit: "0-9A-Fa-f",
  punct: "!-\\/:-@\\[-`{-~",
  word: "A-Za-z0-9_",
};

// A bracket expression starting at p[i] === "[" → [JS class, index of its
// closing "]"], or undefined. POSIX brackets take a backslash literally; Rust
// ones treat it as an escape and allow nesting and set operators (refused).
function bracket(p: string, i: number, dialect: Dialect): [string, number] | undefined {
  let j = i + 1;
  let out = "[";
  if (p[j] === "^") {
    out += "^";
    j++;
  }
  for (let first = true; j < p.length; j++, first = false) {
    const c = p[j]!;
    if (c === "]" && !first) return [out + "]", j];
    if (c === "[" && p[j + 1] === ":") {
      const m = /^\[:(\w+):\]/.exec(p.slice(j));
      const cls = m && POSIX_CLASSES[m[1]!];
      if (!cls || (m![1] === "word" && dialect !== "rust")) return undefined;
      out += cls;
      j += m![0].length - 1;
    } else if (c === "[") {
      if (dialect === "rust") return undefined; // a nested class
      out += "\\[";
    } else if (c === "\\") {
      if (dialect !== "rust") {
        out += "\\\\";
        continue;
      }
      const n = p[j + 1];
      if (n === undefined || /[A-Za-z0-9]/.test(n) && !"nrtfvsSwWdD".includes(n)) return undefined;
      out += `\\${n}`;
      j++;
    } else if (dialect === "rust" && (c === "&" || c === "~" || c === "-") && p[j + 1] === c) {
      return undefined; // set operators
    } else if (c === "]") {
      out += "\\]"; // a leading ] is a member
    } else out += c;
  }
  return undefined; // unterminated
}

// GNU BRE/ERE → JS. BRE's operators are the escaped forms (\( \) \| \+ \? \{
// \}) and their bare spellings are literals; ERE is the other way round. Both
// have \< \> word edges, POSIX brackets and back-references.
function fromPosix(p: string, ere: boolean): string | undefined {
  let out = "";
  // Where a `*` is a literal and a `^` an anchor: at the start of the pattern
  // or of a group/alternative.
  const atStart = (): boolean => out === "" || out.endsWith("(") || out.endsWith("|") || out === "^";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      const n = p[++i];
      if (n === undefined) return undefined;
      if (!ere && "()|+?".includes(n)) out += n;
      else if (!ere && n === "{") {
        const m = /^\\\{(\d*)(,?)(\d*)\\\}/.exec(p.slice(i - 1));
        if (!m || (m[1] === "" && m[2] === "")) return undefined;
        out += `{${m[1] || "0"}${m[2]}${m[3]}}`;
        i += m[0].length - 2;
      } else if (n === "<" || n === ">") out += "\\b";
      else if ("wWsSbB".includes(n) || /[1-9]/.test(n)) out += `\\${n}`;
      else if (/[.*[\]^$\\/+?(){}|]/.test(n)) out += `\\${n}`;
      else return undefined; // \d, \n, \t… mean other things across grep versions
      continue;
    }
    if (c === "[") {
      const b = bracket(p, i, "bre");
      if (!b) return undefined;
      out += b[0];
      i = b[1];
    } else if (c === "*") {
      out += atStart() ? "\\*" : "*";
    } else if (c === "^") {
      out += ere || atStart() ? "^" : "\\^";
    } else if (c === "$") {
      const rest = p.slice(i + 1);
      out += ere || rest === "" || rest.startsWith("\\)") || rest.startsWith("\\|") ? "$" : "\\$";
    } else if (!ere && "()|+?{}".includes(c)) {
      out += `\\${c}`;
    } else if (ere && c === "{") {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(p.slice(i));
      if (m && (m[1] !== "" || m[2] !== "")) {
        out += `{${m[1] || "0"}${m[2]}${m[3]}}`;
        i += m[0].length - 1;
      } else out += "\\{";
    } else if (ere && c === "}") {
      out += "\\}";
    } else if (ere && (c === "+" || c === "?" || c === "*") && atStart()) {
      return undefined; // a leading repetition: implementation-defined
    } else out += c;
  }
  return out;
}

// Rust regex (rg) → JS. The shared core passes through; Rust-only syntax is
// refused rather than approximated. \w \d \b are Unicode-aware in rg and ASCII
// in the engine — identical on ASCII text, which code overwhelmingly is.
function fromRust(p: string): string | undefined {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      const n = p[++i];
      if (n === undefined) return undefined;
      if ("wWdDsSbBnrtfv".includes(n)) out += `\\${n}`;
      else if (n === "p" || n === "P") {
        const m = /^\{[^}]+\}|^[A-Za-z]/.exec(p.slice(i + 1));
        if (!m) return undefined;
        out += `\\${n}${m[0].startsWith("{") ? m[0] : `{${m[0]}}`}`;
        i += m[0].length;
      } else if (n === "x" || n === "u") {
        const m = /^\{[0-9A-Fa-f]{1,6}\}|^[0-9A-Fa-f]{2}/.exec(p.slice(i + 1));
        if (!m || (n === "u" && !m[0].startsWith("{") && !/^[0-9A-Fa-f]{4}/.test(p.slice(i + 1)))) return undefined;
        const hex = n === "u" && !m[0].startsWith("{") ? p.slice(i + 1, i + 5) : m[0].replace(/[{}]/g, "");
        out += `\\u{${hex}}`;
        i += n === "u" && !m[0].startsWith("{") ? 4 : m[0].length;
      } else if (/[A-Za-z0-9<>]/.test(n)) return undefined; // \A \z \Q \1 \< …
      else out += `\\${n}`;
      continue;
    }
    if (c === "[") {
      const b = bracket(p, i, "rust");
      if (!b) return undefined;
      out += b[0];
      i = b[1];
    } else if (c === "(" && p[i + 1] === "?") {
      const m = /^\(\?(?::|P?<([A-Za-z_]\w*)>)/.exec(p.slice(i));
      if (!m) return undefined; // inline flags (?i), lookaround (an rg error)
      out += m[1] ? `(?<${m[1]}>` : "(?:";
      i += m[0].length - 1;
    } else if (c === "{") {
      const m = /^\{\d+(?:,\d*)?\}/.exec(p.slice(i));
      if (!m) return undefined; // an rg syntax error
      out += m[0];
      i += m[0].length - 1;
    } else out += c;
  }
  return out;
}

// rg's smart case: insensitive unless the pattern holds an uppercase LITERAL
// (escapes like \W or \p{Lu} are not literals).
function hasUpperLiteral(p: string): boolean {
  const literal = p.replace(/\\[pP]\{[^}]*\}|\\[pP][A-Za-z]|\\./g, "");
  return literal !== literal.toLowerCase();
}

// The one JS pattern the parsed command means, or undefined.
function toPattern(p: Parsed): string | undefined {
  const parts: string[] = [];
  for (const raw of p.patterns) {
    if (raw === "" || raw.includes("\n")) return undefined;
    const js = p.fixed ? escapeRegExp(raw) : p.dialect === "rust" ? fromRust(raw) : fromPosix(raw, p.dialect === "ere");
    if (js === undefined) return undefined;
    parts.push(js);
  }
  let pattern = parts.length === 1 ? parts[0]! : parts.map((s) => `(?:${s})`).join("|");
  if (p.word) {
    // grep -w / rg -w: the match must not touch a word character on either
    // side. For literals that start and end with one, \b says exactly that
    // (and keeps the fast ripgrep path); otherwise spell the rule out.
    const literals = p.patterns.every((s) => (p.fixed || !/[\\^$.*+?()[\]{}|]/.test(s)) && /^\w(?:.*\w)?$/.test(s));
    const body = parts.length === 1 && literals ? pattern : `(?:${pattern})`;
    pattern = literals ? `\\b${body}\\b` : `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`;
  }
  return pattern;
}

// Normalise a search path to the engine's repo-relative scope, or undefined
// when it points outside the tree the rewrite searches (`..`, absolute, `~`).
function toScope(path: string): string | undefined {
  if (path === "" || path.startsWith("/") || path.startsWith("~") || /[*?[\]{}\\]/.test(path)) return undefined;
  const s = path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (s.split("/").some((seg) => seg === "..")) return undefined;
  return s === "" || s === "." ? "" : s;
}

// Rewrite `cmd` to its codeindex equivalent, or return undefined to leave it
// alone. `bin` is the codeindex executable name to emit (the host may have it
// on PATH under a mount point of its choosing).
export function rewriteCommand(cmd: string, bin = "codeindex"): string | undefined {
  const lexed = lex(cmd.trim());
  if (!lexed || lexed.length < 2) return undefined;
  // An unquoted glob in a path or pattern is expanded by the shell against the
  // cwd (`rg foo src/*.ts`, `-g *.ts`): what the command means depends on
  // files we cannot see. In a flag word (`--include=*.ts`) it could only match
  // a file whose name starts with `-`, so the word reaches grep verbatim.
  if (lexed.some((t) => t.globbed && !t.value.startsWith("-"))) return undefined;
  const tokens = lexed.map((t) => t.value);

  // Refuse env-prefixed or path-qualified invocations (`FOO=1 grep …`,
  // `/usr/bin/grep …`): resolving those faithfully is not worth the risk.
  const [head, ...args] = tokens;
  let p: Parsed | undefined;
  if (head === "grep" || head === "egrep") p = parseGrep(head, args);
  else if (head === "rg") p = parseRg(args);
  else if (head === "git" && args[0] === "grep") p = parseGitGrep(args.slice(1));
  if (!p || !p.recursive) return undefined;

  // Multi-path search has no single-scope equivalent.
  if (p.paths.length > 1) return undefined;
  const scope = p.paths.length ? toScope(p.paths[0]!) : "";
  if (scope === undefined) return undefined;
  // grep and rg let the later of two conflicting include/exclude rules win;
  // the engine lets exclusion win. Only an exclude-before-include order can
  // tell the two apart.
  if (p.orderSensitive) return undefined;

  const upper = (s: string): boolean => (p.fixed ? s !== s.toLowerCase() : hasUpperLiteral(s));
  const ignoreCase = p.smartCase ? !p.patterns.some(upper) : p.ignoreCase;
  const pattern = toPattern(p);
  if (pattern === undefined) return undefined;
  try {
    compilePattern(pattern, ignoreCase);
  } catch {
    return undefined; // the engine would refuse what the original accepts
  }

  // `--` guards a pattern that starts with `-`: shell quoting does not stop
  // `--out` from being parsed as a flag once it reaches argv.
  const out = [bin, "grep", ...(pattern.startsWith("-") ? ["--"] : []), shellQuote(pattern)];
  if (scope) out.push("--scope", shellQuote(scope));
  for (const g of p.includes) out.push("--include", shellQuote(g));
  for (const g of [...p.excludes, ...p.excludeDirs]) out.push("--exclude", shellQuote(g));
  if (ignoreCase) out.push("--ignore-case");
  if (p.filesOnly) out.push("--files-with-matches");
  if (p.noGitignore) out.push("--no-gitignore");
  out.push("--ignore-dir", ".codeindex");
  return out.join(" ");
}
