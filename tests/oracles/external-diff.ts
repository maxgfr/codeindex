// A THREE-WAY symbol differential against two INDEPENDENT indexers.
//
// WHY THIS EXISTS. Every symbol-quality number in this repo is scored against
// ground truth this project authored itself (tests/quality's labelled corpus).
// That is circular in exactly the way ast/tags.ts describes one level down: a
// construct nobody thought to label is missing from BOTH the extractor and the
// answer key, so the score is perfect and the gap is invisible. tags.ts fixed
// that for one grammar's own `queries/tags.scm`; this module fixes it for the
// whole index, by asking two tools that were written by other people:
//
//   universal-ctags   — syntactic like us, but ~40 languages and very mature.
//                       Gives BREADTH.
//   scip-typescript   — indexes through the REAL TypeScript compiler. On TS it
//                       is an AUTHORITY, not a heuristic. Gives DEPTH, and acts
//                       as the ARBITER on ctags.
//
// THE FIVE READINGS, and they must stay separate. Fusing them into one
// "accuracy" is the whole mistake this module exists to avoid:
//
//   agreeAll       all three agree — the core, uninformative.
//   ctagsOnly      ctags found it, we did not → a real hole, to instruct.
//   scipOnly       scip found it, we did not → a real hole AND authoritative,
//                  so the highest priority.
//   scipNotCtags   scip found it, ctags did not → CALIBRATES CTAGS. It says how
//                  much to trust a ctags gap on the other 39 languages, where
//                  no compiler-backed arbiter exists.
//   oursOnly       we found it, neither did → our expected SURPLUS.
//
// That last row is not an error rate and must never be reported as one. ctags
// and scip-typescript are DEFINITION indexers; interface members, fields, doc
// comments and relations cannot appear in their output at all, so anything we
// emit beyond a definition can only ever land here.
//
// OUT OF SCOPE. The comparison unit is (repo-relative file path, declaration
// name), because that is the most either external tool exposes uniformly.
// SymbolIndex.defs (src/types.ts) is keyed by BARE SYMBOL NAME and deliberately
// drops `signature`, `doc` and `parentPath`, so those two quality metrics cannot
// be scored here at all — they stay with the hand-labelled corpus.
//
// NOTHING in the indexing path imports this module. A missing or wrong-shaped
// external tool yields `{ available:false, reason }` and every diff returns
// `undefined` with a recorded `lastFailure()` — it never throws, so the suite
// skips instead of going red.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildIndexArtifacts } from "../../src/pipeline.js";
import { byStr } from "../../src/sort.js";
import { IGNORE_DIRS } from "../../src/walk.js";

export interface ToolStatus {
  name: string;
  available: boolean;
  reason?: string;
  version?: string;
  path?: string;
}

export interface ExternalDiff {
  repo: string;
  /** Distinct (file, name) pairs each tool found, all three inside `universe`. */
  ours: number;
  ctags: number;
  scip: number;
  /**
   * |ours ∩ ctags ∩ scip|. `diffCtags` has only two participants, so there it
   * carries |ours ∩ ctags| — the two-way core — not a three-way agreement.
   */
  agreeAll: number;
  /** Sorted and capped at SAMPLE_CAP; a truncated list carries a `+N more` tail. */
  ctagsOnly: string[];
  /**
   * `ctagsOnly` bucketed by the KIND ctags assigned, biggest first — the whole
   * of it, not the sample.
   *
   * Without this, a recall of 0.62 is unreadable: it cannot distinguish "misses
   * 38% of the declarations" from "declines 38% of things that are not
   * declarations". The kinds settle it — a column that is overwhelmingly
   * `constant` on a repo whose constants are function-body locals is a
   * definition gap, not a hole. Recorded rather than eyeballed from the sample,
   * which is capped and sorted by path.
   */
  ctagsOnlyByKind: Record<string, number>;
  scipOnly: string[];
  /** |scip \ ctags| — the ctags calibration number. */
  scipNotCtags: number;
  /** |ours \ (ctags ∪ scip)| — our surplus. Count only: it is large and expected. */
  oursOnly: number;
  /** SCIP symbols whose descriptor grammar we could not decode. Reported, never dropped. */
  unparsedScipSymbols: number;
  ctagsRecall: number; // |ours ∩ ctags| / |ctags|, 4dp
  scipRecall: number; // |ours ∩ scip| / |scip|, 4dp
  /** Files all participating tools looked at — the projection every count above is taken over. */
  universe: number;
}

/** How many entries `ctagsOnly` / `scipOnly` show before the `+N more` tail. */
export const SAMPLE_CAP = 40;

// ---------------------------------------------------------------------------
// Total spawn wrapper, mirroring scripts/bench/competitors.mjs `runCmd`: absence
// is a VALUE (`missing: true` on ENOENT), never an exception, so detection and
// measurement can both stay total.
// ---------------------------------------------------------------------------
interface CmdResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  ms: number;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return "";
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): CmdResult {
  const t0 = performance.now();
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 512 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, code: 0, stdout, stderr: "", missing: false, ms: performance.now() - t0 };
  } catch (e) {
    const err = e as { status?: unknown; stdout?: unknown; stderr?: unknown; code?: unknown; message?: unknown };
    return {
      ok: false,
      code: typeof err.status === "number" ? err.status : null,
      stdout: asText(err.stdout),
      stderr: asText(err.stderr) || String(err.message ?? e),
      missing: err.code === "ENOENT",
      ms: performance.now() - t0,
    };
  }
}

function whichPath(cmd: string): string | undefined {
  const r = runCmd("/usr/bin/which", [cmd]);
  const p = r.ok ? (r.stdout.trim().split("\n")[0] ?? "") : "";
  return p && existsSync(p) ? p : undefined;
}

function semver(s: string): string | undefined {
  const m = /(\d+\.\d+\.\d+)/.exec(s);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function detectCtags(): ToolStatus {
  const path = whichPath("ctags");
  if (!path) return { name: "ctags", available: false, reason: "not installed" };
  const version = runCmd(path, ["--version"]);
  // Exuberant ctags and BSD `ctags` both answer to the same name and neither
  // speaks --output-format=json; the bench probe screens them the same way.
  if (!/Universal Ctags/.test(version.stdout)) {
    return { name: "ctags", available: false, path, reason: "not Universal Ctags" };
  }
  // A build without libjansson ACCEPTS --output-format=json and then fails at
  // run time, so the flag alone proves nothing — the feature list does.
  if (!/^json\b/m.test(runCmd(path, ["--list-features"]).stdout)) {
    return { name: "ctags", available: false, path, reason: "built without the json feature" };
  }
  return { name: "ctags", available: true, path, version: semver(version.stdout) };
}

function detectScipTs(): ToolStatus {
  const path = whichPath("scip-typescript");
  if (!path) return { name: "scip-typescript", available: false, reason: "not installed" };
  const version = semver(runCmd(path, ["--version"]).stdout);
  if (!version) return { name: "scip-typescript", available: false, path, reason: "--version is not a semver" };
  if (!/--output/.test(runCmd(path, ["index", "--help"]).stdout)) {
    return { name: "scip-typescript", available: false, path, version, reason: "`index --help` lacks --output" };
  }
  return { name: "scip-typescript", available: true, path, version };
}

export function detectTools(): { ctags: ToolStatus; scipTs: ToolStatus } {
  return { ctags: detectCtags(), scipTs: detectScipTs() };
}

// ---------------------------------------------------------------------------
// Why the last diff returned undefined. The prescribed signatures return
// `ExternalDiff | undefined`, which cannot carry a reason — an install that
// failed must still be REPORTABLE, because "skipped, pnpm install exited 1" and
// "skipped, tool absent" are different facts.
// ---------------------------------------------------------------------------
let failure: string | undefined;

export function lastFailure(): string | undefined {
  return failure;
}

function fail<T>(reason: string): T | undefined {
  failure = reason;
  return undefined;
}

// ---------------------------------------------------------------------------
// ctags — language maps
//
// The maps decide which files ctags LOOKED AT, which is not the same as the
// files it emitted tags for, and the difference is load-bearing. A barrel
// `index.ts` of pure re-exports yields zero ctags tags; if "looked at" meant
// "tagged", that file would drop out of the projection and take scip's finding
// there with it — silently hiding a gap we are trying to measure.
// ---------------------------------------------------------------------------
export interface CtagsMaps {
  /** Lower-cased, dot-prefixed: `.ts`, `.rs`, … */
  extensions: Set<string>;
  /** Whole-name patterns: `Makefile`, `CMakeLists.txt`, … */
  filenames: Set<string>;
  /** Glob patterns with character classes (`*.[68][68][kKsSxX]`), deliberately not modelled. */
  unsupportedPatterns: number;
}

/**
 * Parse `ctags --list-maps`: one line per language, `Name<spaces>pat pat …`.
 * A language with no patterns (BibLaTeX, CPreProcessor) contributes nothing.
 */
export function parseCtagsMaps(stdout: string): CtagsMaps {
  const extensions = new Set<string>();
  const filenames = new Set<string>();
  let unsupportedPatterns = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    // The language name is the first whitespace-run-delimited token; `C#`, `C++`
    // and `Cargo [disabled]` all survive this because only the tail is read.
    const patterns = line.split(/\s+/).slice(1);
    for (const p of patterns) {
      if (!p) continue;
      if (/[[\]?]/.test(p)) {
        unsupportedPatterns++;
        continue;
      }
      if (p.startsWith("*.")) {
        const ext = p.slice(1).toLowerCase();
        if (ext.includes("*")) unsupportedPatterns++;
        else extensions.add(ext);
      } else if (p.includes("*")) {
        unsupportedPatterns++;
      } else {
        filenames.add(p);
      }
    }
  }
  return { extensions, filenames, unsupportedPatterns };
}

function ctagsLooksAt(rel: string, maps: CtagsMaps): boolean {
  const base = basename(rel);
  if (maps.filenames.has(base)) return true;
  const dot = base.lastIndexOf(".");
  return dot > 0 && maps.extensions.has(base.slice(dot).toLowerCase());
}

// ---------------------------------------------------------------------------
// ctags — JSON tag stream
// ---------------------------------------------------------------------------
export interface CtagsTag {
  name: string;
  path: string; // repo-relative, posix
  line: number;
  kind: string;
}

/**
 * `--output-format=json` emits one object per line. Parsed defensively: a blank
 * or malformed line is COUNTED, not thrown on, because a single unparsable line
 * must not be able to turn a whole measurement into a crash — nor to vanish.
 */
export function parseCtagsJson(stdout: string): { tags: CtagsTag[]; malformed: number } {
  const tags: CtagsTag[] = [];
  let malformed = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (!obj || typeof obj !== "object") {
      malformed++;
      continue;
    }
    const o = obj as Record<string, unknown>;
    if (o["_type"] !== undefined && o["_type"] !== "tag") continue; // ctags also emits `ptag` metadata lines
    const name = o["name"];
    const path = o["path"];
    if (typeof name !== "string" || !name || typeof path !== "string" || !path) {
      malformed++;
      continue;
    }
    tags.push({
      name,
      path: normalizeRel(path),
      line: typeof o["line"] === "number" ? o["line"] : 0,
      kind: typeof o["kind"] === "string" ? o["kind"] : "",
    });
  }
  return { tags, malformed };
}

function normalizeRel(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

interface Side {
  pairs: Set<string>;
  files: Set<string>;
}

// The comparison unit, (file, name), joined on NUL. A separator that can occur
// inside a name — ':' is legal in a ctags Yaml/Asciidoc name and inside a SCIP
// escaped identifier — would split the key in the wrong place and silently
// compare the wrong things. NUL cannot occur in either half.
const SEP = "\u0000";
const pairKey = (file: string, name: string): string => file + SEP + name;
const pairFile = (key: string): string => key.slice(0, key.indexOf(SEP));
const pairShow = (key: string): string => key.replace(SEP, ":");

function runCtags(
  repoDir: string,
  bin: string,
): { pairs: Set<string>; maps: CtagsMaps; malformed: number; kinds: Map<string, string> } | undefined {
  const maps = parseCtagsMaps(runCmd(bin, ["--list-maps", ...LANGMAP]).stdout);
  if (maps.extensions.size === 0) return fail("ctags --list-maps produced no extension maps");
  // `-f -` keeps the tag stream on stdout: the default sink is a `tags` FILE,
  // and this must never write into the pinned clone.
  const args = [
    "-R",
    "--output-format=json",
    "--fields=+n",
    "-f",
    "-",
    ...LANGMAP,
    ...[...IGNORE_DIRS].map((d) => `--exclude=${d}`),
    ".",
  ];
  const r = runCmd(bin, args, { cwd: repoDir, timeoutMs: 600_000 });
  // ctags exits non-zero on unreadable files while still emitting every tag it
  // did read, so stdout — not the exit code — decides whether this is usable.
  if (!r.stdout.trim()) {
    return fail(`ctags produced no tags (code ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  }
  const { tags, malformed } = parseCtagsJson(r.stdout);
  const pairs = new Set<string>();
  // First kind wins: one (file, name) pair can carry several tags (an overload,
  // a re-declaration), and the pair is what the diff counts. Taking the first
  // keeps the histogram's total equal to the pair count instead of exceeding it.
  const kinds = new Map<string, string>();
  for (const t of tags) {
    const key = pairKey(t.path, t.name);
    pairs.add(key);
    if (!kinds.has(key)) kinds.set(key, t.kind);
  }
  return { pairs, maps, malformed, kinds };
}

// ctags' TypeScript parser handles .tsx/.mts/.cts perfectly well — measured: 16
// tags off a JSX-heavy component — but the DEFAULT map routes only `*.ts` to it,
// so every .tsx file is skipped in silence. Leaving that alone would not measure
// ctags' parser, it would measure a file-extension table: on create-t3-turbo it
// erases 22 of 70 TS files, on socialgouv/code-du-travail-numerique 834 of 2249.
// The three-way projection would then shrink to whatever ctags happens to map,
// dragging scipOnly — the highest-priority reading — down with it.
const LANGMAP = ["--langmap=TypeScript:+.tsx.mts.cts"];

// ---------------------------------------------------------------------------
// SCIP — a dependency-free protobuf reader
//
// The `scip` CLI is not available, so the index is decoded here. Same minimal
// varint/length-delimited approach as tests/scip.test.ts; every field number is
// the one src/render/scip.ts WRITES, which is itself copied verbatim from the
// pinned scip.proto.
// ---------------------------------------------------------------------------
interface Field {
  field: number;
  varint?: number;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p++];
    if (b === undefined) throw new Error("truncated varint");
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, p];
}

function decodeMessage(buf: Uint8Array, start = 0, end = buf.length): Field[] {
  const out: Field[] = [];
  let p = start;
  while (p < end) {
    let tag: number;
    [tag, p] = readVarint(buf, p);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, p] = readVarint(buf, p);
      out.push({ field, varint: v });
    } else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      if (p + len > end) throw new Error("length-delimited field overruns its parent");
      out.push({ field, bytes: buf.subarray(p, p + len) });
      p += len;
    } else if (wire === 5) {
      p += 4; // fixed32 — unused by scip.proto, skipped rather than trusted
    } else if (wire === 1) {
      p += 8; // fixed64 — ditto
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

const firstOf = (fields: Field[], n: number): Field | undefined => fields.find((f) => f.field === n);
const allOf = (fields: Field[], n: number): Field[] => fields.filter((f) => f.field === n);
const strOf = (f: Field | undefined): string => (f?.bytes ? new TextDecoder().decode(f.bytes) : "");

const F_INDEX_DOCUMENTS = 2;
const F_DOC_RELPATH = 1;
const F_DOC_OCCURRENCES = 2;
const F_OCC_SYMBOL = 2;
const F_OCC_ROLES = 3;
const ROLE_DEFINITION = 0x1;

// ---------------------------------------------------------------------------
// SCIP — symbol strings
//
// scip-typescript 0.4.0 leaves SymbolInformation.display_name EMPTY (measured:
// 800 of 800 on create-t3-turbo), so the name has to come out of the symbol
// string itself. Grammar, from the `Symbol` message comment:
//
//   <symbol>  ::= <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' {<descriptor>}
//   <symbol>  ::= 'local ' <local-id>
//   namespace ::= <name> '/'    type ::= <name> '#'    term   ::= <name> '.'
//   meta      ::= <name> ':'    macro ::= <name> '!'   method ::= <name> '(' <disambiguator> ').'
//   type-parameter ::= '[' <name> ']'                  parameter ::= '(' <name> ')'
//
// A name is a simple identifier ([A-Za-z0-9_+-$]+) or a backtick-escaped one
// with backticks doubled — `src/`base-url.ts`/getBaseUrl.` and
// ``src/`[id].tsx`/Post().`` are both real output.
// ---------------------------------------------------------------------------
export type DescriptorKind =
  | "namespace"
  | "type"
  | "term"
  | "meta"
  | "macro"
  | "method"
  | "type-parameter"
  | "parameter";

export interface Descriptor {
  name: string;
  kind: DescriptorKind;
}

/**
 * What a SCIP symbol string denotes.
 *
 * `declaration` is a NAMED declaration: the final descriptor is a
 * namespace/type/term/method/macro and nothing in its chain is a parameter, a
 * type parameter or a meta descriptor.
 *
 * `anonymous-scope` is the deliberate exclusion. scip-typescript spends a
 * `meta` descriptor on every object-literal and type-literal key, disambiguated
 * by an appended integer — `src/`schema.ts`/title1:`, `onDelete0:`,
 * `initAuth().(options)typeLiteral0:baseUrl.`. Those are members of anonymous
 * inline literals, not declarations any definition indexer publishes, and the
 * trailing integer is not part of the source identifier. Counting them would
 * bury the readings that matter under object-literal keys (237 of 800 symbols on
 * create-t3-turbo); guessing the integer off is how a wrong name gets compared.
 * Parameters and type parameters are excluded for the same reason.
 *
 * `local` is `local <id>`: nameless by construction (264 of 800), so there is no
 * name to compare.
 *
 * `unparsed` is the honest fallback — reported via `unparsedScipSymbols`, never
 * dropped, because a silent drop would FAKE agreement.
 */
export type ScipSymbol =
  | { kind: "declaration"; name: string; descriptors: Descriptor[] }
  | { kind: "anonymous-scope" }
  | { kind: "local" }
  | { kind: "unparsed" };

const SIMPLE_ID_CHAR = /[A-Za-z0-9_+\-$]/;

// A backtick-escaped identifier: `` inside means a literal backtick.
function readEscapedName(s: string, i: number): [string, number] | undefined {
  let p = i + 1;
  let out = "";
  for (;;) {
    if (p >= s.length) return undefined; // unterminated
    if (s[p] === "`") {
      if (s[p + 1] === "`") {
        out += "`";
        p += 2;
        continue;
      }
      return [out, p + 1];
    }
    out += s[p];
    p++;
  }
}

function readName(s: string, i: number): [string, number] | undefined {
  if (s[i] === "`") return readEscapedName(s, i);
  let p = i;
  while (p < s.length && SIMPLE_ID_CHAR.test(s[p]!)) p++;
  return p > i ? [s.slice(i, p), p] : undefined;
}

function parseDescriptors(s: string): Descriptor[] | undefined {
  const out: Descriptor[] = [];
  let p = 0;
  while (p < s.length) {
    const c = s[p];
    if (c === "[") {
      const close = s.indexOf("]", p + 1);
      if (close < 0) return undefined;
      out.push({ name: s.slice(p + 1, close), kind: "type-parameter" });
      p = close + 1;
      continue;
    }
    if (c === "(") {
      const close = s.indexOf(")", p + 1);
      if (close < 0) return undefined;
      out.push({ name: s.slice(p + 1, close), kind: "parameter" });
      p = close + 1;
      continue;
    }
    const read = readName(s, p);
    if (!read) return undefined;
    const [name, afterName] = read;
    const suffix = s[afterName];
    if (suffix === "/") out.push({ name, kind: "namespace" });
    else if (suffix === "#") out.push({ name, kind: "type" });
    else if (suffix === ".") out.push({ name, kind: "term" });
    else if (suffix === ":") out.push({ name, kind: "meta" });
    else if (suffix === "!") out.push({ name, kind: "macro" });
    else if (suffix === "(") {
      // <method> ::= <name> '(' <disambiguator> ').' — the ')' MUST be followed
      // by '.', which is what separates a method from a parameter descriptor.
      const close = s.indexOf(")", afterName + 1);
      if (close < 0 || s[close + 1] !== ".") return undefined;
      out.push({ name, kind: "method" });
      p = close + 2;
      continue;
    } else return undefined;
    p = afterName + 1;
  }
  return out.length > 0 ? out : undefined;
}

// Skip <scheme> <manager> <package-name> <version>: four space-delimited fields,
// each possibly `.` for empty or backtick-escaped (so it may itself hold spaces).
function skipPackageFields(s: string): number | undefined {
  let p = 0;
  for (let field = 0; field < 4; field++) {
    if (s[p] === "`") {
      const read = readEscapedName(s, p);
      if (!read) return undefined;
      p = read[1];
    } else {
      const sp = s.indexOf(" ", p);
      if (sp < 0) return undefined;
      p = sp;
    }
    if (s[p] !== " ") return undefined;
    p++;
  }
  return p;
}

const ANONYMOUS_SCOPES = new Set<DescriptorKind>(["meta", "parameter", "type-parameter"]);

export function parseScipSymbol(symbol: string): ScipSymbol {
  if (!symbol) return { kind: "unparsed" };
  if (symbol.startsWith("local ")) return { kind: "local" };
  const start = skipPackageFields(symbol);
  if (start === undefined) return { kind: "unparsed" };
  const descriptors = parseDescriptors(symbol.slice(start));
  if (!descriptors) return { kind: "unparsed" };
  if (descriptors.some((d) => ANONYMOUS_SCOPES.has(d.kind))) return { kind: "anonymous-scope" };
  const last = descriptors[descriptors.length - 1]!;
  return { kind: "declaration", name: last.name, descriptors };
}

/**
 * A Document's own module symbol — the descriptor chain ends at the file itself
 * (`src/utils/`base-url.ts`/`). It names a file, not a declaration in it. A real
 * `declare module 'x'` augmentation ends in a namespace too, which is why this
 * compares against the basename rather than just rejecting trailing namespaces.
 */
export function isFileNamespace(sym: ScipSymbol, relativePath: string): boolean {
  if (sym.kind !== "declaration") return false;
  const last = sym.descriptors[sym.descriptors.length - 1]!;
  return last.kind === "namespace" && last.name === basename(relativePath);
}

// ---------------------------------------------------------------------------
// SCIP — running scip-typescript
// ---------------------------------------------------------------------------

// scip-typescript type-checks for real, so it needs the target repo's
// dependencies on disk. Only ever installs INSIDE the pinned clone under
// tests/.e2e-cache, and never runs lifecycle scripts.
function ensureDeps(repoDir: string): boolean {
  if (existsSync(join(repoDir, "node_modules"))) return true;
  const attempts: [string, string[]][] = [];
  if (existsSync(join(repoDir, "pnpm-lock.yaml"))) attempts.push(["pnpm", ["install", "--ignore-scripts"]]);
  if (existsSync(join(repoDir, "yarn.lock"))) attempts.push(["yarn", ["install", "--ignore-scripts"]]);
  attempts.push(["npm", ["install", "--ignore-scripts", "--legacy-peer-deps"]]);
  const tried: string[] = [];
  for (const [tool, args] of attempts) {
    const bin = whichPath(tool);
    if (!bin) {
      tried.push(`${tool}: not installed`);
      continue;
    }
    const r = runCmd(bin, args, { cwd: repoDir, timeoutMs: 900_000 });
    if (r.ok || existsSync(join(repoDir, "node_modules"))) return true;
    tried.push(`${tool} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  }
  failure = `dependency install failed — ${tried.join(" | ")}`;
  return false;
}

function workspaceFlags(repoDir: string): string[] {
  const flags: string[] = [];
  if (existsSync(join(repoDir, "pnpm-workspace.yaml"))) flags.push("--pnpm-workspaces");
  else if (existsSync(join(repoDir, "yarn.lock")) && hasWorkspacesField(repoDir)) flags.push("--yarn-workspaces");
  if (!existsSync(join(repoDir, "tsconfig.json"))) flags.push("--infer-tsconfig");
  return flags;
}

function hasWorkspacesField(repoDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as { workspaces?: unknown };
    return pkg.workspaces !== undefined;
  } catch {
    return false;
  }
}

function runScipTs(repoDir: string, bin: string): { side: Side; unparsed: number } | undefined {
  if (!ensureDeps(repoDir)) return undefined;
  const out = join(mkdtempSync(join(tmpdir(), "codeindex-oracle-scip-")), "index.scip");
  const r = runCmd(bin, ["index", "--cwd", repoDir, "--no-progress-bar", "--output", out, ...workspaceFlags(repoDir)], {
    cwd: repoDir,
    timeoutMs: 900_000,
  });
  if (!existsSync(out)) {
    return fail(`scip-typescript wrote no index (code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  }
  // A monorepo where some package has no tsconfig makes scip-typescript print a
  // `-` line and carry on, so a non-zero exit does NOT mean the index is
  // unusable. What decides is whether it decodes to at least one Document.
  let documents: Field[];
  try {
    documents = allOf(decodeMessage(new Uint8Array(readFileSync(out))), F_INDEX_DOCUMENTS);
  } catch (e) {
    return fail(`SCIP decode failed: ${(e as Error).message}`);
  }
  if (documents.length === 0) {
    return fail(`scip-typescript index has no documents (code ${r.code}): ${r.stdout.trim().slice(-400)}`);
  }

  const side: Side = { pairs: new Set(), files: new Set() };
  let unparsed = 0;
  for (const docField of documents) {
    let doc: Field[];
    try {
      doc = decodeMessage(docField.bytes!);
    } catch (e) {
      return fail(`SCIP Document decode failed: ${(e as Error).message}`);
    }
    const rel = normalizeRel(strOf(firstOf(doc, F_DOC_RELPATH)));
    if (!rel) continue;
    // Every Document is a file scip-typescript LOOKED AT, including one it found
    // nothing in beyond the module symbol — that is the projection we want.
    side.files.add(rel);
    for (const occField of allOf(doc, F_DOC_OCCURRENCES)) {
      let occ: Field[];
      try {
        occ = decodeMessage(occField.bytes!);
      } catch {
        unparsed++;
        continue;
      }
      if (((firstOf(occ, F_OCC_ROLES)?.varint ?? 0) & ROLE_DEFINITION) === 0) continue;
      const parsed = parseScipSymbol(strOf(firstOf(occ, F_OCC_SYMBOL)));
      if (parsed.kind === "unparsed") {
        unparsed++;
        continue;
      }
      if (parsed.kind !== "declaration") continue;
      if (isFileNamespace(parsed, rel)) continue;
      side.pairs.add(pairKey(rel, parsed.name));
    }
  }
  return { side, unparsed };
}

// ---------------------------------------------------------------------------
// Assembling a diff
// ---------------------------------------------------------------------------

function restrict(pairs: Set<string>, universe: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const p of pairs) if (universe.has(pairFile(p))) out.add(p);
  return out;
}

// Sorted, capped, and — when it had to cut — carrying its own overflow count, so
// a reader can never mistake a truncated sample for the whole gap.
function sample(missing: Set<string>): string[] {
  const sorted = [...missing].sort(byStr).map(pairShow);
  if (sorted.length <= SAMPLE_CAP) return sorted;
  return [...sorted.slice(0, SAMPLE_CAP), `+${sorted.length - SAMPLE_CAP} more (cap ${SAMPLE_CAP})`];
}

const ratio = (num: number, den: number): number => (den === 0 ? 0 : Number((num / den).toFixed(4)));

// ctagsOnly bucketed by ctags' own kind, biggest first. Ties break on the kind
// name so the record is stable across runs — a histogram that reorders on every
// measurement would show a diff where nothing moved.
function kindHistogram(missing: Set<string>, kinds: Map<string, string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const p of missing) {
    // NOT "unknown": ctags emits that as a kind of its own (62 tags on flask,
    // all import aliases), so reusing the word would make a lookup failure here
    // indistinguishable from ctags' own label. Unreachable by construction —
    // every pair was keyed from a tag — and kept only so it cannot become a
    // silent miscount if that ever stops being true.
    const k = kinds.get(p) || "unlabelled";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))) out[k] = n;
  return out;
}

function assemble(
  repo: string,
  universe: Set<string>,
  ours: Set<string>,
  ctags: Set<string>,
  scip: Set<string>,
  unparsedScipSymbols: number,
  twoWay: boolean,
  ctagsKinds: Map<string, string> = new Map(),
): ExternalDiff {
  const inOursAndCtags = [...ctags].filter((p) => ours.has(p));
  const inOursAndScip = [...scip].filter((p) => ours.has(p));
  const ctagsMissing = new Set([...ctags].filter((p) => !ours.has(p)));
  return {
    repo,
    ours: ours.size,
    ctags: ctags.size,
    scip: scip.size,
    agreeAll: twoWay
      ? inOursAndCtags.length
      : inOursAndCtags.filter((p) => scip.has(p)).length,
    ctagsOnly: sample(ctagsMissing),
    ctagsOnlyByKind: kindHistogram(ctagsMissing, ctagsKinds),
    scipOnly: sample(new Set([...scip].filter((p) => !ours.has(p)))),
    scipNotCtags: [...scip].filter((p) => !ctags.has(p)).length,
    oursOnly: [...ours].filter((p) => !ctags.has(p) && !scip.has(p)).length,
    unparsedScipSymbols,
    ctagsRecall: ratio(inOursAndCtags.length, ctags.size),
    scipRecall: ratio(inOursAndScip.length, scip.size),
    universe: universe.size,
  };
}

// Our side. `symbols.defs` supplies the (file, name) pairs; the file UNIVERSE
// comes from `scan.files` instead, because a file we extracted NOTHING from has
// no entry in `defs` — projecting on `defs` would drop exactly the files where
// our recall is zero, the worst possible blind spot for this measurement.
function ourSide(repoDir: string): Side {
  const { scan, symbols } = buildIndexArtifacts(repoDir);
  const files = new Set<string>();
  for (const f of scan.files) if (f.kind === "code") files.add(normalizeRel(f.rel));
  const pairs = new Set<string>();
  for (const [name, defs] of Object.entries(symbols.defs)) {
    for (const d of defs) pairs.add(pairKey(normalizeRel(d.file), name));
  }
  return { pairs, files };
}

/**
 * Two-way differential against universal-ctags alone, over the files BOTH tools
 * looked at (our code files ∩ the extensions ctags maps to a language).
 *
 * scip did not participate, so `scip`, `scipOnly`, `scipNotCtags`, `scipRecall`
 * and `unparsedScipSymbols` are all zero — absence, not agreement.
 */
export function diffCtags(repoDir: string, repoSlug: string): ExternalDiff | undefined {
  failure = undefined;
  const { ctags } = detectTools();
  if (!ctags.available) return fail(`ctags unavailable: ${ctags.reason}`);
  const ours = ourSide(repoDir);
  const ct = runCtags(repoDir, ctags.path!);
  if (!ct) return undefined;
  const universe = new Set([...ours.files].filter((f) => ctagsLooksAt(f, ct.maps)));
  if (universe.size === 0) return fail("no file is both a code file for us and mapped by ctags");
  return assemble(
    repoSlug,
    universe,
    restrict(ours.pairs, universe),
    restrict(ct.pairs, universe),
    new Set<string>(),
    0,
    true,
    ct.kinds,
  );
}

/**
 * The compiler's declarations alone, as (file, name) pairs.
 *
 * Exposed so the ANSWER-quality corpus can be derived from the same authority
 * the extraction differential already trusts, without re-running ctags for a
 * comparison it does not need. Returns undefined — with lastFailure() set —
 * exactly like the differentials.
 */
export function scipDeclarations(repoDir: string): { file: string; name: string }[] | undefined {
  failure = undefined;
  const { scipTs } = detectTools();
  if (!scipTs.available) return fail(`scip-typescript unavailable: ${scipTs.reason}`);
  const sc = runScipTs(repoDir, scipTs.path!);
  if (!sc) return undefined;
  return [...sc.side.pairs].map((key) => ({ file: pairFile(key), name: key.slice(key.indexOf(SEP) + 1) }));
}

/**
 * The full three-way differential.
 *
 * THE PROJECTION. Every count is taken over the files ALL THREE tools looked at:
 * our `code` files, ∩ scip-typescript's Documents, ∩ the paths ctags maps to a
 * language. "Looked at" — not "found something in" — for all three, so a file a
 * tool drew a blank on stays in and the blank counts against it. Without this,
 * comparing a TS-only indexer against our whole-repo index manufactures a gap
 * out of every Go and Markdown file in the repo.
 *
 * Returns `undefined` — with `lastFailure()` set — when a tool is missing, the
 * dependency install fails, or scip-typescript produces nothing decodable.
 */
export function diffThreeWay(repoDir: string, repoSlug: string): ExternalDiff | undefined {
  failure = undefined;
  const { ctags, scipTs } = detectTools();
  if (!ctags.available) return fail(`ctags unavailable: ${ctags.reason}`);
  if (!scipTs.available) return fail(`scip-typescript unavailable: ${scipTs.reason}`);
  const ours = ourSide(repoDir);
  const ct = runCtags(repoDir, ctags.path!);
  if (!ct) return undefined;
  const sc = runScipTs(repoDir, scipTs.path!);
  if (!sc) return undefined;
  const universe = new Set([...ours.files].filter((f) => sc.side.files.has(f) && ctagsLooksAt(f, ct.maps)));
  if (universe.size === 0) return fail("no file was looked at by all three tools");
  return assemble(
    repoSlug,
    universe,
    restrict(ours.pairs, universe),
    restrict(ct.pairs, universe),
    restrict(sc.side.pairs, universe),
    sc.unparsed,
    false,
    ct.kinds,
  );
}
