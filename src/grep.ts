// Repo text search: ripgrep when it's on PATH (fast), a pure-JS scan over
// walk() otherwise (always available). Both backends return the SAME shape,
// sorted by (file, line) with the cap applied after sorting, so a consumer
// cannot tell which backend ran — asserted by the backend-parity tests.
//
// Parity is engineered on three axes, not hoped for:
//   * the universe — ripgrep is configured to see exactly the files walk()
//     keeps, and the user's scope/globs are applied by ONE predicate in JS on
//     both paths (an rg whitelist glob overrides .gitignore and the junk-dir
//     rules, so it can never be handed to rg as a filter);
//   * the dialect — the pattern is JavaScript RegExp on both sides; the rg
//     path runs a translation that pins the constructs Rust reads differently
//     (\w \b \d are Unicode in Rust, ASCII in JS; `.` crosses \r in Rust…) and
//     hands anything it cannot translate to the JS engine;
//   * the text — both decode a file the way ripgrep does (BOM sniffing, UTF-8
//     with U+FFFD for invalid bytes, a file with a NUL is binary and skipped).
import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { walk, IGNORE_DIRS, LOCKFILES, BINARY_EXT } from "./walk.js";
import { compileGlobs, compileGlobFilter } from "./glob.js";
import { sh, have } from "./util.js";
import { byStr } from "./sort.js";

export interface SearchHit {
  file: string; // repo-relative posix path
  line: number; // 1-based
  // 1-based column of the first match on the line, in UTF-16 code units of the
  // full line (the JS string index + 1) — also what LSP positions count in.
  col: number;
  // The matching line without its newline. A line longer than MAX_TEXT is cut
  // to a MAX_TEXT window around the match, `…` marking each cut side: one
  // minified 800 KB line used to arrive whole, ~200k tokens for a single hit.
  text: string;
}

export interface GrepOptions {
  // Restrict to matching paths (repo-relative, rooted dialect). A `!` prefix
  // NEGATES the glob: `!sub/**` excludes that tree; exclusion beats inclusion
  // regardless of list order, identically on both backends.
  globs?: string[];
  // Restrict to one directory OR file (repo-relative; `./x`, `x/` and an
  // absolute path inside the repo all mean `x`). ANDed with `globs` — scope
  // `src` with glob `**/*.md` is the markdown under src, not src plus every
  // markdown file.
  scope?: string;
  maxHits?: number; // cap AFTER sorting (default 200)
  ignoreCase?: boolean;
  // One hit per matching file — its first match — so maxHits caps FILES
  // (`grep -l`, with the first match as evidence instead of a bare path).
  filesWithMatches?: boolean;
  // The walk's universe knobs, honoured by both backends exactly as walk()
  // honours them (see WalkOptions): gitignore on by default, ignoreDirs
  // REPLACES the default set (`.git` stays skipped), maxFileBytes defaults to
  // 1 MiB.
  gitignore?: boolean;
  ignoreDirs?: string[];
  maxFileBytes?: number;
  // Wall-clock budget for the JavaScript engine (default 10 s). ripgrep's
  // engine is linear-time; JS RegExp backtracks, and `(a+)+b` on one 30-char
  // line takes minutes. The scan runs in a worker thread that is terminated at
  // the deadline; the result then says so (timedOut + a note) and carries the
  // hits of every file finished before it.
  timeoutMs?: number;
  // Force the JS backend even when ripgrep is available (tests, determinism).
  noRipgrep?: boolean;
}

export interface GrepResult {
  hits: SearchHit[];
  // More hits exist than were returned (the maxHits cap cut the sorted list).
  truncated: boolean;
  // Files with at least one matching line in the whole scoped universe, not
  // just among the returned hits. A lower bound when timedOut.
  filesMatched: number;
  // The JS engine hit its time budget: hits cover only the files (in path
  // order) scanned before the deadline.
  timedOut: boolean;
  // Human-readable, deterministic-in-wording notes a caller should surface:
  // truncation, a timeout, a pattern ripgrep rejected.
  notes: string[];
}

const DEFAULT_MAX_HITS = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_TEXT = 300;

// ---------------------------------------------------------------------------
// Pattern dialect
// ---------------------------------------------------------------------------

// Escapes JavaScript gives a meaning to. Without the u flag any OTHER
// `\<letter>` is an identity escape — `\A` is just "A" — while ripgrep (and
// every grep a user comes from) reads it as syntax, so accepting it would make
// the backends disagree in silence.
const JS_ESCAPE_LETTERS = new Set("bBdDwWsSfnrtvcxuk0123456789");
const HINTS: Record<string, string> = {
  A: "use ^",
  z: "use $",
  Z: "use $",
  Q: "escape the metacharacters instead",
  E: "escape the metacharacters instead",
  h: "use [ \\t]",
  p: "\\p{…} needs a pattern that is otherwise valid with the u flag",
  P: "\\P{…} needs a pattern that is otherwise valid with the u flag",
  "<": "use \\b",
  ">": "use \\b",
};

// Why a pattern that compiled without the u flag would be read differently by
// ripgrep or by the user's intent, or undefined when it is sound.
function foreignSyntax(p: string): string | undefined {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      const n = p[++i];
      if (n === undefined) return undefined;
      const bad = (what: string): string =>
        `\`\\${what}\` is not JavaScript regex syntax (the pattern dialect)${HINTS[n] ? `: ${HINTS[n]}` : ""}`;
      if (n === "<" || n === ">") return bad(n);
      if (!/[A-Za-z0-9]/.test(n)) continue;
      if (!JS_ESCAPE_LETTERS.has(n)) return bad(n);
      if (n === "x" && !/^[0-9A-Fa-f]{2}/.test(p.slice(i + 1))) return bad(p.slice(i, i + 2));
      if (n === "u" && !/^[0-9A-Fa-f]{4}/.test(p.slice(i + 1))) return bad(p.slice(i, i + 2));
      if (n === "c" && !/^[A-Za-z]/.test(p.slice(i + 1))) return bad("c");
      if (n === "k" && p[i + 1] !== "<") return bad("k");
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      else if (c === "[" && /^\[:\^?[a-z]+:\]/.test(p.slice(i))) {
        return "POSIX classes like [[:alpha:]] are not JavaScript regex syntax (the pattern dialect): use [A-Za-z] or \\p{L}";
      } else if ((c === "&" || c === "~") && p[i + 1] === c) {
        return `\`${c}${c}\` inside a class is set syntax in other dialects, a literal in JavaScript: escape it`;
      }
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (p[i + 1] === "^") i++;
      if (p[i + 1] === "]") i++; // a leading `]` is a member, not the close
    }
  }
  return undefined;
}

// The JS RegExp both backends match with. The u flag when the pattern is valid
// with it: it makes \p{…} work and treats astral characters as one, like
// ripgrep. Otherwise the legacy dialect — `foo() {` and `\"` are common in code
// searches and only valid there — unless the pattern leans on syntax that
// dialect reads as a literal while the user meant something else.
export function compilePattern(pattern: string, ignoreCase = false): RegExp {
  const i = ignoreCase ? "i" : "";
  try {
    return new RegExp(pattern, `u${i}`);
  } catch {
    const re = new RegExp(pattern, i); // throws the familiar syntax error when invalid in both
    const why = foreignSyntax(pattern);
    if (why) throw new SyntaxError(`Invalid regular expression: /${pattern}/: ${why}`);
    return re;
  }
}

// Inside a class, Rust's ASCII classes stand in for JS's ASCII \w \d.
const CLASS_ESCAPES: Record<string, string> = { w: "[:word:]", W: "[:^word:]", d: "[:digit:]", D: "[:^digit:]" };

// Translate a compiled JS pattern to ripgrep's Rust syntax with the SAME
// meaning, or return undefined when that cannot be guaranteed (the JS engine
// then runs — always correct, only slower). Lookaround, backreferences and
// control escapes are Rust errors anyway; `[]`/`[^]` mean "nothing"/"anything"
// in JS and a literal `]` in Rust.
export function toRipgrepRegex(re: RegExp): string | undefined {
  const p = re.source;
  const unicode = re.flags.includes("u");
  let out = "";
  let inClass = false;
  let classOpen = false; // just after `[` / `[^`
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\") {
      const n = p[++i];
      if (n === undefined) return undefined;
      classOpen = false;
      if (n in CLASS_ESCAPES) out += inClass ? CLASS_ESCAPES[n] : `(?-u:\\${n})`;
      else if (n === "b") out += inClass ? "\\x08" : "(?-u:\\b)";
      else if (n === "B") {
        if (inClass) return undefined;
        out += "(?-u:\\B)";
      } else if ("fnrtvsS".includes(n)) out += `\\${n}`;
      else if (n === "x") {
        const hex = p.slice(i + 1, i + 3);
        out += `\\x${hex}`;
        i += 2;
      } else if (n === "u") {
        const m = /^\{[0-9A-Fa-f]+\}|^[0-9A-Fa-f]{4}/.exec(p.slice(i + 1));
        if (!m) return undefined;
        const cp = parseInt(m[0].replace(/[{}]/g, ""), 16);
        if (cp >= 0xd800 && cp <= 0xdfff) return undefined; // a surrogate half: no Rust spelling
        out += `\\u{${cp.toString(16)}}`;
        i += m[0].length;
      } else if (n === "p" || n === "P") {
        if (!unicode) return undefined;
        const m = /^\{[^}]*\}/.exec(p.slice(i + 1));
        if (!m) return undefined;
        out += `\\${n}${m[0]}`;
        i += m[0].length;
      } else if (/[A-Za-z0-9]/.test(n)) return undefined; // \0, \1…, \c, \k: the JS engine
      else if (n.charCodeAt(0) > 0x7f) out += n; // an identity escape of a non-ASCII char
      else out += `\\${n}`; // ASCII punctuation: Rust accepts the escape with the same meaning
      continue;
    }
    if (inClass) {
      if (c === "]") {
        if (classOpen) return undefined;
        inClass = false;
        out += c;
      } else if (c === "[" || c === "&" || c === "~" || (c === "-" && p[i - 1] === "-")) {
        out += `\\${c}`; // literals in a JS class, set syntax in a Rust one
      } else out += c;
      classOpen = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      classOpen = true;
      out += c;
      if (p[i + 1] === "^") out += p[++i];
    } else if (c === ".") {
      out += "[^\\n\\r\\u{2028}\\u{2029}]"; // JS `.` stops at every line terminator
    } else if (c === "{") {
      // A quantifier passes through; any other `{` is a literal in the legacy
      // JS dialect and a syntax error in Rust.
      const m = /^\{\d+(?:,\d*)?\}/.exec(p.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length - 1;
      } else out += "\\{";
    } else if (c === "}" || c === "]") {
      out += `\\${c}`;
    } else if (c === "(" && p[i + 1] === "?") {
      const m = /^\(\?(?::|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(p.slice(i));
      if (!m) return undefined; // lookaround (Rust has none) or modifiers
      out += m[0];
      i += m[0].length - 1;
    } else out += c;
  }
  return inClass ? undefined : out;
}

// ---------------------------------------------------------------------------
// The universe: scope + globs
// ---------------------------------------------------------------------------

// The single keep-predicate both backends apply to repo-relative paths.
function keepFilter(root: string, opts: GrepOptions): ((rel: string) => boolean) | null {
  // Accept the same optionally-`/`-anchored spelling the rg path used to take
  // (the anchor may follow the `!` of a negated glob: `!/sub/**` ≡ `!sub/**`).
  const globs = compileGlobFilter(opts.globs?.map((g) => g.replace(/^(!?)\//, "$1")));
  const scope = scopeFilter(root, opts.scope);
  if (!scope) return globs;
  if (!globs) return scope;
  return (rel) => scope(rel) && globs(rel);
}

function scopeFilter(root: string, scope: string | undefined): ((rel: string) => boolean) | null {
  if (!scope) return null;
  let s = scope;
  if (isAbsolute(s)) {
    s = relative(root, s).split(sep).join("/");
    if (s === ".." || s.startsWith("../") || isAbsolute(s)) throw new Error(`--scope is outside the repository: ${scope}`);
  }
  s = s.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (s === "" || s === ".") return null;
  // The path itself (a file scope) or anything beneath it (a directory scope).
  return compileGlobs([s, `${s}/**`]);
}

// ---------------------------------------------------------------------------
// Shared hit shaping
// ---------------------------------------------------------------------------

// Self-contained on purpose: it is stringified into the JS backend's worker.
function clipLine(line: string, at: number, max: number): string {
  if (line.length <= max) return line;
  // Open a quarter-window before the match so the hit reads in context.
  let start = Math.max(0, Math.min(at - (max >> 2), line.length - max));
  let end = start + max;
  const low = (k: number): boolean => {
    const u = line.charCodeAt(k);
    return u >= 0xdc00 && u <= 0xdfff;
  };
  if (start > 0 && low(start)) start++; // never split a surrogate pair
  if (end < line.length && low(end)) end--;
  return (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
}

function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort((a, b) => byStr(a.file, b.file) || a.line - b.line);
}

// ---------------------------------------------------------------------------
// ripgrep backend
// ---------------------------------------------------------------------------

// Glob metacharacters in a directory NAME must not act as glob syntax.
const globLiteral = (s: string): string => s.replace(/[\\*?[\]{}!]/g, (c) => `\\${c}`);

// Flags that make ripgrep's file universe walk()'s: hidden files searched,
// .gitignore (and .git/info/exclude) honoured even outside a git worktree, but
// NOT the user/global/parent/.ignore layers the walker never reads; the same
// junk dirs, lockfiles, binary extensions and size cap; no user config file
// (RIPGREP_CONFIG_PATH could add --smart-case or globs behind our back).
function universeArgs(opts: GrepOptions): string[] {
  const args = [
    "--no-config",
    "--no-messages",
    "--color=never",
    "--hidden",
    "--no-require-git",
    "--no-ignore-global",
    "--no-ignore-parent",
    "--no-ignore-dot",
    "--max-filesize",
    String(opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES),
  ];
  if (opts.gitignore === false) args.push("--no-ignore-vcs");
  const dirs = opts.ignoreDirs ? new Set([".git", ...opts.ignoreDirs]) : IGNORE_DIRS;
  for (const d of [...dirs].sort(byStr)) args.push("--glob", `!**/${globLiteral(d)}/**`);
  args.push("--glob", "!**/.codeindex-edit-*/**"); // walk.ts: interrupted-edit scratch dirs
  // Lockfiles match at any depth, case-insensitively (the walker lowercases).
  for (const l of LOCKFILES) args.push("--iglob", `!**/${l}`);
  for (const ext of BINARY_EXT) args.push("--iglob", `!**/*${ext}`);
  args.push("--glob", "!*.min.js", "--glob", "!*.min.css");
  // The JS keep-predicate applies every user glob afterwards, so rg only gets
  // what can prune its walk without ever dropping a file that predicate keeps:
  // a tree exclusion (`!dir/**`) with no braces or classes, where the two glob
  // dialects agree. Anything else could over-exclude — rg reads `{a,b}` as
  // alternation and prunes a DIRECTORY matching `!x` — so it is not passed.
  // Positive globs never are: an rg whitelist glob overrides .gitignore and the
  // junk-dir exclusions above (`-g 'src/**'` searched src/node_modules).
  for (const g of opts.globs ?? []) {
    const body = g.slice(1).replace(/^\//, "");
    if (g.startsWith("!") && body.endsWith("/**") && !/[{}[\]\\!]/.test(body)) args.push("--glob", `!/${body}`);
  }
  if (opts.ignoreCase) args.push("--ignore-case");
  return args;
}

interface RgOutcome {
  hits: SearchHit[];
  filesMatched: number;
  truncated: boolean;
  notes: string[];
}

const RG_BUFFER = 256 * 1024 * 1024;

// Two phases, so the output ripgrep produces is bounded by what we return:
//   1. --files-with-matches: the matching files (small output), filtered by
//      the keep-predicate and sorted with byStr;
//   2. line search over those files in path order, in growing batches, until
//      maxHits + 1 hits are in hand. Hits sort by (file, line), so the hits of
//      a sorted prefix of files ARE the head of the full sorted list.
// A single pass used to collect every hit just to return 200 — on a 66k-file
// repo `grep e` overflowed the 64 MiB spawn buffer, and the whole rg run was
// then thrown away for a JS re-scan.
function rgBackend(
  root: string,
  rust: string,
  opts: GrepOptions,
  keep: ((rel: string) => boolean) | null,
  max: number,
): RgOutcome | { fallback: string } | undefined {
  const universe = universeArgs(opts);
  const p1 = sh("rg", [...universe, "--files-with-matches", "--null", "--regexp", rust, "./"], {
    cwd: root,
    maxBufferBytes: RG_BUFFER,
  });
  if (p1.missing) return undefined;
  // Exit 1 = no match. Exit 2 = an error, but when some output arrived it is
  // per-file trouble (an unreadable file) and the rest of the answer stands.
  if (p1.errorCode || (p1.status !== 0 && p1.status !== 1 && !p1.stdout)) {
    // rg's parse error is multi-line (the pattern, a caret, then the reason):
    // the reason is the line worth repeating.
    const lines = p1.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
    const why = lines.find((l) => /^error:/.test(l)) ?? lines[0] ?? p1.errorCode ?? `exit ${p1.status}`;
    const parse = /regex parse error|error parsing|not allowed|impossible to match/i.test(p1.stderr);
    return { fallback: `${parse ? "ripgrep rejected the pattern" : "ripgrep failed"} (${why}); searched with the slower JavaScript engine` };
  }
  const files = p1.stdout
    .split("\0")
    .filter(Boolean)
    .map((f) => f.replace(/^\.\//, ""))
    .filter((f) => !keep || keep(f))
    .sort(byStr);

  const want = max + 1; // one past the cap proves truncation
  const hits: SearchHit[] = [];
  const notes: string[] = [];
  const search = (batch: string[], remaining: number): void => {
    const res = sh(
      "rg",
      [
        "--no-config",
        "--no-messages",
        "--json",
        ...(opts.ignoreCase ? ["--ignore-case"] : []),
        // No file can contribute more than `remaining` hits to the answer;
        // stopping each file there bounds the output without changing it.
        "--max-count",
        String(opts.filesWithMatches ? 1 : remaining),
        "--regexp",
        rust,
        "--",
        ...batch.map((f) => `./${f}`),
      ],
      { cwd: root, maxBufferBytes: RG_BUFFER },
    );
    if (res.errorCode === "ENOBUFS" && batch.length > 1) {
      const half = batch.length >> 1;
      search(batch.slice(0, half), remaining);
      search(batch.slice(half), remaining);
      return;
    }
    if (res.errorCode) notes.push(`ripgrep could not search ${batch.length === 1 ? batch[0] : `${batch.length} files`} (${res.errorCode})`);
    for (const line of res.stdout.split("\n")) {
      if (!line.startsWith('{"type":"match"')) continue;
      const d = JSON.parse(line).data as RgMatch;
      const bytes = d.lines.text !== undefined ? Buffer.from(d.lines.text, "utf8") : Buffer.from(d.lines.bytes ?? "", "base64");
      const path = d.path.text ?? Buffer.from(d.path.bytes ?? "", "base64").toString("utf8");
      const full = bytes.toString("utf8").replace(/\n$/, "");
      const at = bytes.subarray(0, d.submatches[0]?.start ?? 0).toString("utf8").length;
      hits.push({ file: path.replace(/^\.\//, ""), line: d.line_number, col: at + 1, text: clipLine(full, at, MAX_TEXT) });
    }
  };
  // Batches double (few spawns even for a huge cap) under an argv budget —
  // Windows caps a whole command line at 32k characters.
  const argChars = process.platform === "win32" ? 24_000 : 512_000;
  for (let next = 0, size = 64; next < files.length && hits.length < want; size = Math.min(size * 2, 4096)) {
    let end = next;
    for (let chars = 0; end < files.length && end - next < size; end++) {
      chars += files[end]!.length + 3;
      if (chars > argChars && end > next) break;
    }
    search(files.slice(next, end), want - hits.length);
    next = end;
  }
  sortHits(hits);
  return { hits: hits.slice(0, max), filesMatched: files.length, truncated: hits.length > max, notes };
}

interface RgMatch {
  path: { text?: string; bytes?: string };
  lines: { text?: string; bytes?: string };
  line_number: number;
  submatches: { start: number }[];
}

// ---------------------------------------------------------------------------
// JavaScript backend
// ---------------------------------------------------------------------------

interface ScanJob {
  source: string;
  flags: string;
  files: [rel: string, abs: string][]; // in path order
  want: number; // hits to collect; past it, a file is only checked for "matches at all"
  firstOnly: boolean; // stop each file at its first match
  textMax: number;
  deadline: number; // epoch ms: a soft stop between files (the worker is also hard-stopped)
}
type ScanEvent = { i: number; hits: [line: number, col: number, text: string][] } | { done: true } | { stoppedAt: number };
interface ScanIo {
  readFile: (abs: string) => Buffer;
  clip: (line: string, at: number, max: number) => string;
  emit: (ev: ScanEvent) => void;
  progress: (i: number) => void;
}

// Self-contained on purpose: it runs inline OR stringified into a worker, so it
// may reference nothing outside its own body and its arguments.
function scanFiles(job: ScanJob, io: ScanIo): void {
  const re = new RegExp(job.source, job.flags);
  // ripgrep's view of a file's text: BOM-declared UTF-16 transcoded, a UTF-8
  // BOM dropped, a NUL anywhere else = binary (skipped), invalid UTF-8 bytes as
  // U+FFFD — not the index's latin-1 fallback, which rg cannot mirror.
  const decode = (buf: Buffer): string | undefined => {
    const n = buf.length;
    if (n >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2, 2 + ((n - 2) & ~1)).toString("utf16le");
    if (n >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.from(buf.subarray(2, 2 + ((n - 2) & ~1)));
      swapped.swap16();
      return swapped.toString("utf16le");
    }
    if (n >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
    if (buf.includes(0)) return undefined;
    return buf.toString("utf8");
  };
  let got = 0;
  for (let i = 0; i < job.files.length; i++) {
    if (Date.now() > job.deadline) {
      io.emit({ stoppedAt: i });
      return;
    }
    io.progress(i);
    let text: string | undefined;
    try {
      text = decode(io.readFile(job.files[i]![1]));
    } catch {
      text = undefined; // vanished or unreadable: rg skips it too
    }
    if (!text) continue;
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop(); // the terminator ends the last line; it does not start one
    const hits: [number, number, string][] = [];
    let matched = false;
    for (let n = 0; n < lines.length; n++) {
      const m = re.exec(lines[n]!);
      if (!m) continue;
      matched = true;
      if (got >= job.want) break; // cap reached: only "does it match" still counts
      got++;
      hits.push([n + 1, m.index + 1, io.clip(lines[n]!, m.index, job.textMax)]);
      if (job.firstOnly) break;
    }
    if (matched) io.emit({ i, hits });
  }
  io.emit({ done: true });
}

// The worker's whole program: scanFiles and clipLine are self-contained, so
// their source text is the implementation — no bundle to locate, the same
// code inline and threaded. `__name` is the one helper a transpiler may inject
// into a function body (esbuild's keepNames, which tsx turns on); a no-op
// keeps the stringified source runnable when the engine runs from source.
const WORKER_SOURCE =
  `var __name = (fn) => fn;\n` +
  `const { workerData } = require("node:worker_threads");\n` +
  `const { readFileSync } = require("node:fs");\n` +
  `const { port, sig, job } = workerData;\n` +
  `const s = new Int32Array(sig);\n` +
  `const clip = ${clipLine.toString()};\n` +
  `const emit = (ev) => { port.postMessage(ev); Atomics.add(s, 0, 1); Atomics.notify(s, 0); };\n` +
  `try {\n` +
  `  (${scanFiles.toString()})(job, { readFile: readFileSync, clip, emit, progress: (i) => Atomics.store(s, 1, i) });\n` +
  `} catch (e) { emit({ error: String(e && e.message || e) }); }\n`;

// Run the scan in a worker the main thread can abandon at the deadline. The
// call stays synchronous (grepRepo is a sync API, and the MCP server awaits
// nothing around it): the main thread sleeps in Atomics.wait between messages
// and drains them with receiveMessageOnPort. Where no worker can be spawned
// (the browser build) the scan runs inline, bounded only by its soft deadline.
function runScan(job: ScanJob, onEvent: (ev: ScanEvent) => void): { stoppedAt?: number } {
  let worker: Worker;
  let port: MessagePort;
  let sig: Int32Array;
  try {
    sig = new Int32Array(new SharedArrayBuffer(8)); // [messages posted, file in progress]
    const channel = new MessageChannel();
    port = channel.port1;
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { port: channel.port2, sig: sig.buffer, job },
      transferList: [channel.port2],
    });
    worker.unref();
  } catch {
    let stoppedAt: number | undefined;
    scanFiles(job, {
      readFile: (abs) => readFileSync(abs),
      clip: clipLine,
      emit: (ev) => ("stoppedAt" in ev ? (stoppedAt = ev.stoppedAt) : onEvent(ev)),
      progress: () => {},
    });
    return stoppedAt === undefined ? {} : { stoppedAt };
  }
  try {
    for (;;) {
      const seen = Atomics.load(sig, 0);
      const msg = receiveMessageOnPort(port) as { message: ScanEvent | { error: string } } | undefined;
      if (msg) {
        const ev = msg.message;
        if ("error" in ev) throw new Error(`grep worker failed: ${ev.error}`);
        if ("stoppedAt" in ev) return { stoppedAt: ev.stoppedAt };
        if ("done" in ev) return {};
        onEvent(ev);
        continue;
      }
      const left = job.deadline - Date.now();
      if (left <= 0) {
        // The file in progress bounds the answer; results the worker posted
        // for earlier files since the last receive still belong to it.
        const stoppedAt = Atomics.load(sig, 1);
        for (let m; (m = receiveMessageOnPort(port) as { message: ScanEvent } | undefined); ) {
          if ("i" in m.message && m.message.i < stoppedAt) onEvent(m.message);
        }
        return { stoppedAt };
      }
      // Short slices: a message posted between the load and the receive is
      // caught by the counter, and one still in flight by the next slice.
      Atomics.wait(sig, 0, seen, Math.min(left, 50));
    }
  } finally {
    void worker.terminate();
    port.close();
  }
}

function jsBackend(
  root: string,
  re: RegExp,
  opts: GrepOptions,
  keep: ((rel: string) => boolean) | null,
  max: number,
  deadline: number,
): RgOutcome & { timedOut: boolean } {
  const walked = walk(root, { gitignore: opts.gitignore, ignoreDirs: opts.ignoreDirs, maxFileBytes: opts.maxFileBytes });
  const files = walked.files
    .filter((f) => !keep || keep(f.rel))
    .map((f): [string, string] => [f.rel, f.abs])
    .sort((a, b) => byStr(a[0], b[0]));
  const job: ScanJob = {
    source: re.source,
    flags: re.flags,
    files,
    want: max + 1,
    firstOnly: opts.filesWithMatches === true,
    textMax: MAX_TEXT,
    deadline,
  };
  const hits: SearchHit[] = [];
  let filesMatched = 0;
  const { stoppedAt } = runScan(job, (ev) => {
    if (!("i" in ev)) return;
    filesMatched++;
    const file = files[ev.i]![0];
    for (const [line, col, text] of ev.hits) hits.push({ file, line, col, text });
  });
  const notes: string[] = [];
  const timedOut = stoppedAt !== undefined;
  if (timedOut) {
    notes.push(
      `the JavaScript regex engine ran out of its ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms budget in ${files[stoppedAt]?.[0] ?? "the last file"}: ` +
        `hits cover only the ${stoppedAt} file${stoppedAt === 1 ? "" : "s"} before it in path order — simplify the pattern, narrow scope/globs, or raise the budget (--timeout-ms)`,
    );
  }
  return { hits: sortHits(hits).slice(0, max), filesMatched, truncated: hits.length > max, notes, timedOut };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function grepRepoEx(root: string, pattern: string, opts: GrepOptions = {}): GrepResult {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // The pattern dialect is JS RegExp on BOTH backends: validate up front and
  // throw the same error regardless of which backend runs, instead of one
  // backend silently returning [] on syntax the other accepts.
  const re = compilePattern(pattern, opts.ignoreCase);
  const max = opts.maxHits ?? DEFAULT_MAX_HITS;
  const keep = keepFilter(root, opts);
  const notes: string[] = [];
  let out: (RgOutcome & { timedOut?: boolean }) | undefined;
  if (!opts.noRipgrep && have("rg")) {
    const rust = toRipgrepRegex(re);
    const rg = rust === undefined ? undefined : rgBackend(root, rust, opts, keep, max);
    if (rg && "fallback" in rg) notes.push(rg.fallback);
    else if (rg) out = rg;
    else if (rust === undefined) notes.push("the pattern uses JavaScript-only syntax (lookaround, backreference…); searched with the slower JavaScript engine");
  }
  out ??= jsBackend(root, re, opts, keep, max, deadline);
  notes.push(...out.notes);
  if (out.truncated) {
    const shown = opts.filesWithMatches ? `${max} matching files by path` : `${max} hits by (file, line)`;
    notes.push(
      `showing the first ${shown}; ${out.filesMatched} files match in all — raise maxHits (--max-hits) or narrow scope/globs for the rest`,
    );
  }
  return { hits: out.hits, truncated: out.truncated, filesMatched: out.filesMatched, timedOut: out.timedOut ?? false, notes };
}

export function grepRepo(root: string, pattern: string, opts: GrepOptions = {}): SearchHit[] {
  return grepRepoEx(root, pattern, opts).hits;
}
