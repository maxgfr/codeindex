// Two independent answers to "what does this file declare", and their
// disagreement.
//
// WHY THIS EXISTS. The engine ships TWO symbol extractors covering the same
// languages: the tree-sitter walk (ast/extract.ts, driven by the hand-written
// node-type tables in ast/specs.ts) and the line-based regex rules (lang/*.ts).
// In production only one of them runs per file — extract/code.ts takes the AST
// tier when a grammar is loaded and falls back to the regex tier otherwise — so
// for every language that has a grammar the regex rules are never exercised on
// the indexing path at all. That makes them free to spend as an ORACLE.
//
// A hand-written table has a failure mode no test of the table can catch: a
// construct nobody listed simply does not exist, and the suite stays green. That
// is how TypeScript interface members, Rust trait method signatures and `.d.ts`
// declarations went unindexed. ast/tags.ts nets that failure mode from OUTSIDE
// the repo, using each grammar author's own `queries/tags.scm`; this module nets
// it from a source we already own and already maintain. A declaration the CRUDER
// tier finds and the richer tier does not is, at minimum, a question the AST
// tables have to answer.
//
// WHAT THE OUTPUT IS. `astMissing` is a list of CANDIDATES TO ADJUDICATE, never
// a list of confirmed bugs. The regex tier is a line scanner with no notion of
// comments or strings (lang/common.ts `scan`), so it also invents declarations:
// `function f() {}` sitting inside a block comment is a symbol to it, and the
// honest resolution of that entry is "regex-tier false positive, no AST hole".
// Somebody has to look at each one — which is why the languages with the most
// candidates are reported FIRST. Worth reading rather than dismissing: on this
// repo the split came out roughly 11 real gaps to 1 phantom (see tierDiffRepo).
//
// The reverse direction is expected, not interesting, and reported as a bare
// count: the AST tier sees members, fields, nesting, visibility and docs that
// one-regex-per-line structurally cannot, so it is richer by design.
//
// Nothing in the indexing path imports this. It needs no external tool, no
// ground truth and no labelling — both tiers already ship.
import { join } from "node:path";
import type { CodeSymbol } from "../../src/types.js";
import { extractAst } from "../../src/ast/extract.js";
import { extractSymbols, extToLang } from "../../src/lang/registry.js";
import { extractReexports } from "../../src/lang/common.js";
import { scanRepo } from "../../src/scan.js";
import { readText } from "../../src/walk.js";
import { byStr } from "../../src/sort.js";

export interface TierGap {
  lang: string;
  file: string;
  name: string;
  regexKind: string; // kind the regex tier assigned
}

export interface TierDiffReport {
  filesChecked: number;
  /** Declarations the REGEX tier found and the AST tier did not — candidate holes in the AST tables. */
  astMissing: TierGap[]; // sorted (lang, file, name)
  /** Count only: the AST tier is richer by design (members, fields, docs), so this is expected. */
  regexMissingCount: number;
  /** Per-language: how many names each tier found, for context on the gap counts. */
  byLang: { lang: string; astCount: number; regexCount: number; astMissing: number }[];
}

interface LangTally {
  astCount: number;
  regexCount: number;
  astMissing: number;
}

// Accumulator so one file and a whole repo share one comparison, byte for byte:
// tierDiffRepo must not be able to disagree with tierDiffFile about the same
// file.
interface Acc {
  filesChecked: number;
  gaps: TierGap[];
  regexMissingCount: number;
  byLang: Map<string, LangTally>;
}

function newAcc(): Acc {
  return { filesChecked: 0, gaps: [], regexMissingCount: 0, byLang: new Map() };
}

function tallyOf(acc: Acc, lang: string): LangTally {
  let t = acc.byLang.get(lang);
  if (!t) {
    t = { astCount: 0, regexCount: 0, astMissing: 0 };
    acc.byLang.set(lang, t);
  }
  return t;
}

// name → the kind reported for its FIRST occurrence. The regex tier emits in
// line order, so "first" is the topmost declaration of that name — the one a
// reader adjudicating the gap will look at. A later homonym cannot change the
// reported kind, which keeps the report stable under an unrelated edit further
// down the file.
function kindByName(symbols: CodeSymbol[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of symbols) if (!out.has(s.name)) out.set(s.name, s.kind);
  return out;
}

function diffInto(acc: Acc, rel: string, ext: string, content: string): void {
  // `imports: false` mirrors extract/code.ts: it suppresses only the extra
  // traversal that computes `refs`/`pkg`, which this comparison never reads.
  // Symbols are byte-identical either way.
  const ast = extractAst(rel, ext, content, { imports: false });
  // No grammar loaded for this extension means there IS no AST tier here — the
  // regex tier is what production uses, so there is nothing to be missing from.
  // Not counted in filesChecked either: a file nobody compared must not inflate
  // the denominator.
  if (!ast) return;
  // A capped AST result dropped declarations it did find (ast/extract.ts
  // MAX_SYMBOLS). Every drop would read as a table hole, so the file is not
  // comparable — the cap is the finding, and `truncated` already reports it.
  if (ast.truncated) return;

  // scan.ts labels every file with extToLang, so a language named here is the
  // same string the index's own histogram uses. Extensions outside that table
  // (.sol, .tf, .zig) land in "other" — they have no regex extractor either, so
  // they contribute no gaps to confuse.
  const lang = extToLang(ext);
  const regexKinds = kindByName(extractSymbols(rel, ext, content));
  const astNames = new Set(ast.symbols.map((s) => s.name));

  // extractReexports is NOT part of either tier: extract/code.ts runs it on top
  // of whichever tier produced `symbols`, and lang/registry.ts's extractSymbols
  // runs it too so direct consumers see the same barrels. Its name set depends
  // only on `content` (localSymbols only decide a symbol's kind and line), so
  // the names it contributes are identical on both sides in production — and
  // charging them to the AST tier here would manufacture a gap for every
  // `export { a as b } from "./x"` in the repo.
  const shared = new Set(extractReexports(rel, content, ast.symbols).map((s) => s.name));

  acc.filesChecked++;
  const tally = tallyOf(acc, lang);
  tally.astCount += astNames.size;
  tally.regexCount += regexKinds.size;

  // Compared by NAME only. The two tiers legitimately disagree on kind naming
  // ("const" vs "variable") and on where a declaration's span starts (the walk
  // opens at the decorated/exported node, the line rules at the matched line),
  // so a comparison on kind or line would report every symbol as a gap and say
  // nothing about recall.
  for (const [name, regexKind] of regexKinds) {
    if (astNames.has(name) || shared.has(name)) continue;
    acc.gaps.push({ lang, file: rel, name, regexKind });
    tally.astMissing++;
  }
  for (const name of astNames) if (!regexKinds.has(name)) acc.regexMissingCount++;
}

function finish(acc: Acc): TierDiffReport {
  return {
    filesChecked: acc.filesChecked,
    astMissing: acc.gaps.sort((a, b) => byStr(a.lang, b.lang) || byStr(a.file, b.file) || byStr(a.name, b.name)),
    regexMissingCount: acc.regexMissingCount,
    // Worst first: the whole value of the report is which language's table to go
    // read, and a table sorted alphabetically buries that under whichever
    // language happens to start with "c". `byStr` breaks ties so equal gap
    // counts still order identically on every machine.
    byLang: [...acc.byLang]
      .map(([lang, t]) => ({ lang, astCount: t.astCount, regexCount: t.regexCount, astMissing: t.astMissing }))
      .sort((a, b) => b.astMissing - a.astMissing || byStr(a.lang, b.lang)),
  };
}

/** Both tiers over one source, as a one-file report. Empty when no grammar covers `ext`. */
export function tierDiffFile(rel: string, ext: string, content: string): TierDiffReport {
  const acc = newAcc();
  diffInto(acc, rel, ext, content);
  return finish(acc);
}

/**
 * Both tiers over every code file under `root`.
 *
 * `scanRepo` is the enumerator rather than a bare walk so the file set is
 * exactly the one the index would build — same ignore rules, same size limits,
 * same code/doc/config classification — and so `rel`/`ext` come from the engine
 * instead of being re-derived here.
 *
 * MEASURED, codeindex on itself (225 code files, ~100 candidates — the count
 * tracks the repo, so treat it as an order of magnitude, not a ratchet). Zero
 * candidates in python, rust, java, go, cpp, csharp, elixir, kotlin, php, ruby
 * and scala; all of them in TS/JS. Of the 99 classified by hand, 91 fell in the
 * first bucket and 8 in the second:
 *
 *   REAL     A declaration one block deeper than a function body. `walk`
 *            (ast/extract.ts) descends into a non-declaration node only when that
 *            node's OWN type is in `spec.containers`; the JS/TS set lists
 *            `statement_block` explicitly "for nested declarations — route
 *            handlers, hooks, helper closures", but lists neither the statements
 *            that OWN a block (try, if, for, for-of) nor an arrow passed as a call
 *            argument — including `app.get("/x", (req, res) => …)`, the very case
 *            that comment names. The descent stops one node short of the block it
 *            is reaching for. Self-referential cost: the engine does not index
 *            `walk`, `emit`, `docOf`, `walkChildren`, `walkBody`,
 *            `collectRelations` or `visibilityOf` — the seven closures
 *            ast/extract.ts is built from, all declared inside its `try {`.
 *   PHANTOM  `scan` has no notion of a template literal, so the TypeScript
 *            snippets tests/lang.test.ts feeds to the extractors are read as that
 *            file's own declarations.
 *
 * The labelled fixtures and tests/fixtures/mini-repo yield zero of either, which
 * is why tests/oracles-tier-diff.test.ts can assert empty there. That is a
 * measurement, not a guarantee: this oracle is blind wherever the regex rules
 * are — they have no rule for a class member, so they can never catch a missing
 * one, which is exactly the gap ast/tags.ts covers from the other side.
 */
export function tierDiffRepo(root: string): TierDiffReport {
  const acc = newAcc();
  for (const f of scanRepo(root).files) {
    if (f.kind !== "code") continue;
    // readText returns "" for a file that vanished or cannot be decoded; both
    // tiers then find nothing and the file reports no gap, which is the right
    // answer for content neither tier ever saw.
    diffInto(acc, f.rel, f.ext, readText(join(root, f.rel)));
  }
  return finish(acc);
}
