// Ground-truth-FREE oracles: properties of an extraction that can be verified
// against the source text itself, plus metamorphic properties of the extractor.
//
// WHY THIS EXISTS. tests/quality/harness.ts measures precision/recall against
// 217 hand-labelled symbols — written by this project, about this project's
// engine. That is circular by construction: a construct nobody thought to label
// is invisible to it, and a construct labelled WRONG is enshrined as truth. The
// tags audit (harness.auditTags) narrows the gap but shares the same blind spot,
// because a grammar's own tags query and our walk were both written by someone
// looking at the same handful of shapes.
//
// The checks here need no labels at all. Two families:
//
//   STRUCTURAL — the extraction must be self-consistent with the bytes it came
//   from. A symbol's name has to occur inside the span the symbol claims; a
//   member's span has to sit inside its parent's; identities have to be unique.
//   Nothing here knows or cares what SHOULD have been found — so it fires on
//   declarations no fixture mentions, which is exactly the defect class the
//   ratchet cannot see.
//
//   METAMORPHIC — transform the input in a way whose effect on the output is
//   known, and check it. Reversing the order of top-level declarations must not
//   change WHICH symbols exist; wrapping a file in a namespace must not lose
//   any; appending a second file must lose neither side's. A parser that is
//   accidentally position-dependent (a regex anchored on "the first class", a
//   walk that stops at the first `export`) passes every correctness test in the
//   suite and fails these.
//
// Reporting only — no assertions live here, so the same functions can be pointed
// at an arbitrary repo (`checkRepo`) to hunt, not just at the fixtures to gate.
//
// Pointed at this repo it currently reports 25 `span-missing-name` hits, all in
// `extractReexports` (src/lang/common.ts) and all left UNEXEMPTED on purpose,
// because whether they are defects is a human's call and hiding them would
// forfeit the only reason to run this:
//   * a multi-line `export { a, b } from "./m"` anchors EVERY name on the
//     statement's first line, so `src/mcp.ts:66` cites `export {` for a symbol
//     named `capResponse` seven lines below;
//   * an in-file alias (`export { DEFAULT_LIMIT as SEMANTIC_DEFAULT_LIMIT }`)
//     deliberately cites the renamed declaration's line, so the symbol's own
//     name provably does not occur at src/embed/search.ts:9;
//   * the `export * from './y'` inside common.ts's OWN doc comment at line 72
//     becomes a symbol — the barrel scan is a regex over raw text and does not
//     know it is reading a comment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeSymbol } from "../../src/types.js";
import { extractCode } from "../../src/extract/code.js";
import { extractReexports } from "../../src/lang/common.js";
import { scanRepo } from "../../src/scan.js";
import { grammarKeyForExt, grammarReady } from "../../src/ast/loader.js";
import { byStr } from "../../src/sort.js";

// Internal Map-key separator. Written as an ESCAPE, never as a literal NUL: a
// literal one makes git, grep and file(1) read this source as binary, and makes
// codeindex drop the file from its own index. Same character at runtime; see
// src/graph.ts, which learned this the hard way.
const SEP = "\u0000";

export interface Violation {
  kind: string;
  file: string;
  /** "Parent/name", or "name" for a top-level declaration. */
  symbol: string;
  detail: string;
}

export interface InvariantReport {
  filesChecked: number;
  symbolsChecked: number;
  /** Sorted by (kind, file, symbol, detail) — a total order, so two runs are byte-identical. */
  violations: Violation[];
}

const EMPTY: InvariantReport = { filesChecked: 0, symbolsChecked: 0, violations: [] };

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

/**
 * Languages whose members are declared OUT OF LINE — the parent link is a
 * semantic association (receiver type / impl target), not lexical containment,
 * so `parent-not-enclosing` does not apply to them.
 *
 * Evidence, from the labelled fixtures themselves:
 *   go    `type Scheduler struct` spans service.go:26-29, while its method
 *         `func (s *Scheduler) Start()` spans 38-45 — outside the struct, by
 *         the language's design. Go has no other way to write a method.
 *   rust  `pub struct Scheduler` spans service.rs:35-38; `pub fn new()` lives
 *         in the separate `impl Scheduler` block at 42-44.
 *
 * C/C++ out-of-line definitions (`void Foo::bar() {}`) are deliberately NOT
 * listed: the cpp walk emits `bar` with no parent at all, so no parent link
 * exists to exempt. Should that change, this oracle fires and someone
 * adjudicates it — which is the point.
 */
const OUT_OF_LINE_MEMBERS = new Set(["go", "rust"]);

/** 1-based inclusive slice of `lines`, clamped. A spanless symbol spans its anchor line alone. */
function spanText(lines: readonly string[], line: number, endLine: number): string {
  return lines.slice(Math.max(0, line - 1), endLine).join("\n");
}

/**
 * The name was SYNTHESIZED from the file path, not read from the source, so it
 * cannot appear in the span.
 *
 * WHY: src/ast/extract.ts names an anonymous `export default function/class/
 * arrow` after the file stem (`Button.tsx` → `Button`), so a module's default
 * export is a referencable symbol instead of nothing. The name is provably
 * absent from the file — it was taken from the path.
 *
 * Detected structurally, not by extension: the name must equal the file stem AND
 * the claimed span must actually contain `export default`. A `Button.tsx` that
 * really does declare `class Button` never reaches here (its name is in the span),
 * and a wrong span over unrelated code is still reported.
 */
function isFileStemDefaultExport(rel: string, name: string, span: string): boolean {
  const stem = (rel.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
  return name === stem && /\bexport\s+default\b/.test(span);
}

/**
 * The name is a COMPOSITE the extractor joined from several source tokens, so
 * the joined form never appears literally — but every part does.
 *
 * WHY: a Terraform block's identity is its label list — `resource "aws_instance"
 * "worker"` is addressed as `aws_instance.worker`, which is how Terraform itself
 * names it (src/ast/specs.ts), and the two labels are separate `string_lit`
 * nodes with a quote and a space between them. Lua reaches the same shape from
 * the other direction: a table function is named `M.alias`.
 *
 * This is not a loosened check — it is the SAME check applied at the granularity
 * at which the name was composed. Every segment must still be present in the
 * span, so a composite over a wrong span is still reported.
 */
function isComposedName(name: string, span: string): boolean {
  if (!name.includes(".")) return false;
  const parts = name.split(".");
  return parts.length > 1 && parts.every((p) => p.length > 0 && span.includes(p));
}

/**
 * The name is a PLACEHOLDER for a member the language leaves anonymous, so there
 * is no identifier in the source for it to match.
 *
 * WHY: a TypeScript interface can declare a call signature `(x: T): R`, a
 * construct signature `new (x: T): R` and an index signature `[k: string]: T`.
 * All three are real, referencable members of the type — and none of them has a
 * name. src/ast/specs.ts names them after the FORM they take rather than
 * dropping them, which is what finally made a `.d.ts` index completely.
 *
 * Narrow on both sides: only these three synthetic spellings are accepted, and
 * only when the span really is the corresponding declaration. An index-signature
 * placeholder must additionally carry the key name the source declares, so
 * `[header]` over a span that never mentions `header` is still reported.
 */
function isAnonymousMemberPlaceholder(name: string, span: string): boolean {
  if (name === "(call)") return /\([^)]*\)\s*:/.test(span);
  if (name === "(construct)") return /\bnew\s*\(/.test(span);
  const index = /^\[(\w+)\]$/.exec(name);
  return index !== null && span.includes("[") && span.includes(index[1]!);
}

/**
 * Every structural invariant, over symbols supplied by the CALLER.
 *
 * Split out from `checkFile` so the invariants can be tested against
 * hand-constructed bad symbol sets — proving each one CAN fire without needing
 * an extractor that is actually broken.
 */
export function checkSymbols(rel: string, content: string, symbols: readonly CodeSymbol[]): Violation[] {
  const lines = content.split(/\r?\n/);
  const out: Violation[] = [];
  const at = (s: { name: string; parent?: string }): string => (s.parent ? `${s.parent}/${s.name}` : s.name);

  // Spans of every symbol, keyed by name, for the parent lookup below. A name
  // can carry several spans (C# `partial class`, an overload set), so the parent
  // test below is satisfied by ANY of them.
  const spansByName = new Map<string, { line: number; endLine: number }[]>();
  for (const s of symbols) {
    if (s.endLine === undefined) continue;
    const list = spansByName.get(s.name);
    if (list) list.push({ line: s.line, endLine: s.endLine });
    else spansByName.set(s.name, [{ line: s.line, endLine: s.endLine }]);
  }

  const seen = new Set<string>();

  for (const s of symbols) {
    // (2) end-before-start. Checked first: every span-derived test below reads
    // `[line, endLine]`, and an inverted span would silently read as empty.
    if (s.endLine !== undefined && s.endLine < s.line) {
      out.push({
        kind: "end-before-start",
        file: rel,
        symbol: at(s),
        detail: `endLine ${s.endLine} < line ${s.line}`,
      });
    }

    // (1) span-missing-name. A spanless symbol is checked against its anchor
    // line alone — that is the only line the index will ever cite for it, so it
    // is the line that has to hold up.
    const end = s.endLine !== undefined && s.endLine >= s.line ? s.endLine : s.line;
    const span = spanText(lines, s.line, end);
    if (
      !span.includes(s.name) &&
      !isFileStemDefaultExport(rel, s.name, span) &&
      !isComposedName(s.name, span) &&
      !isAnonymousMemberPlaceholder(s.name, span)
    ) {
      out.push({
        kind: "span-missing-name",
        file: rel,
        symbol: at(s),
        detail: `${s.kind} name absent from lines ${s.line}-${end}: ${JSON.stringify(clip(span))}`,
      });
    }

    // (4) duplicate-identity.
    const id = `${s.file}${SEP}${s.parent ?? ""}${SEP}${s.name}${SEP}${s.line}`;
    if (seen.has(id)) {
      out.push({
        kind: "duplicate-identity",
        file: rel,
        symbol: at(s),
        detail: `(file, parent, name, line) repeated at line ${s.line} (kind ${s.kind})`,
      });
    }
    seen.add(id);

    // (5) parent-path-inconsistent.
    if (s.parentPath !== undefined) {
      if (s.parent === undefined || !s.parentPath.endsWith(s.parent)) {
        out.push({
          kind: "parent-path-inconsistent",
          file: rel,
          symbol: at(s),
          detail: `parentPath ${JSON.stringify(s.parentPath)} does not end with parent ${JSON.stringify(s.parent ?? null)}`,
        });
      } else if (!s.parentPath.includes("/")) {
        // A single-segment parentPath would only repeat `parent`; the extractor
        // omits it in that case, so its presence means real nesting depth.
        out.push({
          kind: "parent-path-inconsistent",
          file: rel,
          symbol: at(s),
          detail: `parentPath ${JSON.stringify(s.parentPath)} has no "/" — it only repeats parent`,
        });
      }
    }

    // (3) parent-not-enclosing. A parent ABSENT from this file is not a
    // violation: `impl Foo` where `Foo` is declared in another module, a Go
    // method whose receiver type lives in a sibling file, a TS member of a type
    // merged across files. The index records the association it can see; the
    // declaration it points at is simply not here to compare against.
    if (s.parent === undefined || s.endLine === undefined) continue;
    const parents = spansByName.get(s.parent);
    if (!parents) continue;
    const childEnd = s.endLine;
    if (parents.some((p) => p.line <= s.line && childEnd <= p.endLine)) continue;
    const straddles = parents.some((p) => s.line <= p.endLine && p.line <= childEnd);
    if (straddles) {
      // Partial overlap is a bug in EVERY language — a declaration either nests
      // inside another or sits beside it; it cannot half-cover one. So this
      // fires even for the out-of-line languages below.
      out.push({
        kind: "parent-span-straddles",
        file: rel,
        symbol: at(s),
        detail: `child ${s.line}-${childEnd} partially overlaps parent ${s.parent} at ${fmtSpans(parents)}`,
      });
    } else if (!OUT_OF_LINE_MEMBERS.has(s.lang)) {
      out.push({
        kind: "parent-not-enclosing",
        file: rel,
        symbol: at(s),
        detail: `child ${s.line}-${childEnd} outside parent ${s.parent} at ${fmtSpans(parents)}`,
      });
    }
  }

  return out;
}

/** Structural invariants over one already-extracted file. */
export function checkFile(rel: string, content: string): InvariantReport {
  const symbols = extractCode(rel, extOf(rel), content).symbols;
  return {
    filesChecked: 1,
    symbolsChecked: symbols.length,
    violations: sortViolations(checkSymbols(rel, content, symbols)),
  };
}

/** Same, over a whole scanned repo (reads each file from disk). */
export function checkRepo(root: string): InvariantReport {
  const reports: InvariantReport[] = [];
  // Re-extracting from the bytes rather than reading `FileRecord.symbols` keeps
  // checkRepo and checkFile checking IDENTICAL inputs; the record's symbols come
  // from the same extractCode call, so nothing is lost by re-running it.
  for (const f of scanRepo(root).files) {
    if (f.kind !== "code") continue;
    reports.push(checkFile(f.rel, readFileSync(join(root, f.rel), "utf8")));
  }
  return merge(reports);
}

// ---------------------------------------------------------------------------
// Metamorphic checks
// ---------------------------------------------------------------------------

// GATED ON EXTENSION, because two of the three transforms are only syntactically
// legal in TypeScript: `export namespace Wrapped {}` is a TS construct (a syntax
// error in a .js file), and the appended `export function zzUnique(): void {}`
// carries a type annotation. Applied to JavaScript they would measure the
// parser's error recovery, not the extractor. Reordering top-level blocks is
// syntax-neutral, so it runs on both.
const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);

/** The trivial second file the concat transform appends. */
const SECOND_FILE = "export function zzUnique(): void {}\n";

// Extraction caps, CITED rather than inferred, because a capped result makes
// every name-set comparison here meaningless: which names survive a cap depends
// on their POSITION in the file, so any transform that moves declarations
// changes the answer without anything being wrong.
//   src/extract/code.ts   MAX_FILE_SYMBOLS = 2000
//   src/lang/common.ts    extractReexports stops at `out.length < 60`
// Found the hard way: src/engine.ts is a 200-name barrel, and reversing its
// blocks reported ~170 "lost" symbols that were only ever cap casualties.
const MAX_FILE_SYMBOLS = 2000;
const REEXPORT_CAP = 60;

/** Metamorphic checks: transform the source, compare symbol sets. */
export function checkMetamorphic(rel: string, content: string): InvariantReport {
  const ext = extOf(rel);
  const ts = TS_EXTS.has(ext);
  if (!ts && !JS_EXTS.has(ext)) return EMPTY;
  // Regex-tier extraction is line-anchored by construction, so re-indenting a
  // file or reordering its blocks moves matches for reasons that say nothing
  // about extraction quality. Only run against the AST tier the CLI ships.
  const key = grammarKeyForExt(ext);
  if (!key || !grammarReady(key)) return EMPTY;

  const info = extractCode(rel, ext, content);
  if (info.truncated || info.symbols.length >= MAX_FILE_SYMBOLS) return EMPTY;
  if (extractReexports(rel, content, info.symbols).length >= REEXPORT_CAP) return EMPTY;

  const base = new Set(info.symbols.map((s) => s.name));
  if (!base.size) return EMPTY; // nothing to preserve; every transform trivially holds

  const violations: Violation[] = [];

  // (1) reorder-loses-symbols.
  const blocks = topLevelBlocks(content);
  const reordered = reorderedSource(content);
  if (blocks && reordered !== undefined) {
    const got = nameSet(rel, reordered);
    // A transform that destroyed the parse is NOT a violation of the extractor:
    // report nothing rather than a false positive, which here would be worse
    // than a miss — it would send someone hunting a bug in the engine that
    // lives in this file's own text surgery.
    if (got.size) {
      for (const lost of missing(base, got)) {
        violations.push({
          kind: "reorder-loses-symbols",
          file: rel,
          symbol: lost,
          detail: `present in the original, absent after reversing the order of ${blocks.length} top-level blocks`,
        });
      }
      // The reverse direction matters too: a name that only appears once the
      // declarations move is a position-dependent extraction bug.
      for (const gained of missing(got, base)) {
        violations.push({
          kind: "reorder-loses-symbols",
          file: rel,
          symbol: gained,
          detail: "absent from the original, present after reversing the order of top-level blocks",
        });
      }
    }
  }

  if (ts) {
    // (2) wrap-loses-symbols. Extra names are fine — `Wrapped` itself is one.
    const got = nameSet(rel, wrappedSource(content));
    if (got.size) {
      for (const lost of missing(base, got)) {
        violations.push({
          kind: "wrap-loses-symbols",
          file: rel,
          symbol: lost,
          detail: "present at top level, absent once the file is nested in `export namespace Wrapped`",
        });
      }
    }

    // (3) concat-loses-symbols. The union of both files' names must survive.
    const got2 = nameSet(rel, concatenatedSource(content));
    if (got2.size) {
      const want = new Set([...base, ...nameSet("zzSecond.ts", SECOND_FILE)]);
      for (const lost of missing(want, got2)) {
        violations.push({
          kind: "concat-loses-symbols",
          file: rel,
          symbol: lost,
          detail: "present in one of the two files, absent from their concatenation",
        });
      }
    }
  }

  return { filesChecked: 1, symbolsChecked: base.size, violations: sortViolations(violations) };
}

// The three transforms, as pure string→string functions. Exported so the
// comparison they feed can be exercised on a source whose name set really does
// move (see the barrel-cap test), without needing an extractor that is broken.

/** The file with its top-level declaration blocks in reverse order. */
export function reorderedSource(content: string): string | undefined {
  const blocks = topLevelBlocks(content);
  return blocks ? `${[...blocks].reverse().join("\n\n")}\n` : undefined;
}

/** The file nested one level deeper, inside `export namespace Wrapped`. */
export function wrappedSource(content: string): string {
  return `export namespace Wrapped {\n${indent(content)}\n}\n`;
}

/** The file followed by a second, trivial one. */
export function concatenatedSource(content: string): string {
  return `${content.endsWith("\n") ? content : `${content}\n`}\n${SECOND_FILE}`;
}

/**
 * Top-level declaration blocks: blank-line-separated chunks, re-joined until the
 * accumulated text is a complete unit (brackets balanced, not inside a string or
 * comment).
 *
 * The regrouping is not decoration. Splitting on blank lines alone cuts
 * DECLARATIONS in half — service.ts:29-37 is one `abstract class Transport`
 * whose body holds blank lines at 31 and 35 — and reversing those halves yields
 * garbage that no extractor could be blamed for.
 *
 * Nor is the string/comment awareness. `const HELP = \`…\`` in src/engine-cli.ts
 * is a 400-line template literal full of blank lines and unpaired brackets from
 * the help text; a naive bracket count cut it up and reported `HELP` as a lost
 * symbol — a false accusation produced entirely by this function.
 *
 * Returns undefined when the decomposition cannot be trusted: an unterminated
 * tail, or more closers than openers (a bracket inside a regex literal, which
 * the scanner deliberately does not try to lex). Skipping beats guessing.
 */
export function topLevelBlocks(content: string): string[] | undefined {
  const chunks = content.split(/\n[ \t]*\n/);
  const out: string[] = [];
  let acc = "";
  for (const chunk of chunks) {
    acc = acc ? `${acc}\n\n${chunk}` : chunk;
    const depth = bracketDepth(acc);
    if (depth === undefined || depth > 0) continue; // mid-string / mid-comment / open declaration
    if (depth < 0) return undefined;
    if (acc.trim()) out.push(acc);
    acc = "";
  }
  if (acc.trim()) return undefined;
  return out.length ? out : undefined;
}

/**
 * Net bracket depth of `text`, ignoring anything inside a string literal or a
 * comment — or undefined when the text ENDS inside one, which is the signal that
 * this is not yet a complete unit.
 */
function bracketDepth(text: string): number | undefined {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) return depth; // a line comment to EOF closes at EOF
      i = nl + 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = closingQuote(text, i, ch);
      if (close < 0) return undefined;
      i = close + 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    i++;
  }
  return depth;
}

function closingQuote(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === quote) return i;
    // Only a template literal may span lines. Bailing on a newline stops an
    // apostrophe the scanner mistook for a quote from swallowing the rest of the
    // file — the caller reads -1 as "not trustworthy" and skips.
    if (quote !== "`" && c === "\n") return -1;
  }
  return -1;
}

function indent(content: string): string {
  return content
    .split(/\r?\n/)
    .map((l) => (l ? `  ${l}` : l))
    .join("\n");
}

function nameSet(rel: string, content: string): Set<string> {
  return new Set(extractCode(rel, extOf(rel), content).symbols.map((s) => s.name));
}

function missing(want: Set<string>, got: Set<string>): string[] {
  return [...want].filter((n) => !got.has(n)).sort(byStr);
}

// ---------------------------------------------------------------------------
// Report plumbing
// ---------------------------------------------------------------------------

/** Combine per-file reports into one, preserving the total order on violations. */
export function merge(reports: readonly InvariantReport[]): InvariantReport {
  return {
    filesChecked: reports.reduce((a, r) => a + r.filesChecked, 0),
    symbolsChecked: reports.reduce((a, r) => a + r.symbolsChecked, 0),
    violations: sortViolations(reports.flatMap((r) => r.violations)),
  };
}

// (kind, file, symbol) is the documented order; `detail` breaks the remaining
// ties so the sort is TOTAL and two runs are byte-identical regardless of the
// sort's stability guarantees.
export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort(
    (a, b) =>
      byStr(a.kind, b.kind) || byStr(a.file, b.file) || byStr(a.symbol, b.symbol) || byStr(a.detail, b.detail),
  );
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.kind}  ${v.file}  ${v.symbol}\n      ${v.detail}`).join("\n");
}

function extOf(rel: string): string {
  const i = rel.lastIndexOf(".");
  return i < 0 ? "" : rel.slice(i);
}

function clip(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function fmtSpans(spans: readonly { line: number; endLine: number }[]): string {
  return spans.map((p) => `${p.line}-${p.endLine}`).join(", ");
}
