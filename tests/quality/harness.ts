// The extraction-quality harness: precision / recall / F1 of what the engine
// ACTUALLY extracts, measured against hand-labelled ground truth.
//
// WHY THIS EXISTS. The rest of the suite proves the engine is *correct and
// deterministic* — that a given input yields a given output, byte for byte. It
// cannot tell you whether the engine finds *enough*: a spec that never mentions
// `interface_body` silently indexes zero interface members and every test still
// passes. Recall gaps are invisible to correctness tests by construction.
//
// So this harness answers a different question: for a file a human has fully
// labelled, what fraction of the declarations does the engine find (recall),
// how much of what it reports is real (precision), and does it describe each
// one right (kind / exported / doc / full signature)?
//
// The numbers are frozen into baseline.json and enforced as a RATCHET by
// tests/quality.test.ts — a change that loses recall fails CI. Improving a
// score means updating the baseline in the same commit (see quality:update).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodeSymbol } from "../../src/types.js";
import { extractCode } from "../../src/extract/code.js";
import { byStr } from "../../src/sort.js";

// Where the labelled fixtures live. Under tests/fixtures/ so tsconfig's
// `exclude` keeps deliberately-exotic sources (a `.d.ts` of bare `declare`s,
// PHP, Scala…) out of `tsc --noEmit`, and vitest never collects them as tests.
const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, "..", "fixtures", "quality");
export const BASELINE_PATH = join(HERE, "baseline.json");

// One expected declaration. `name` + `parent` form the identity used for
// matching; every other field is an ATTRIBUTE scored only on symbols that
// matched, so "found it but mislabelled it" is a distinct, visible failure from
// "never found it".
export interface ExpectedSymbol {
  name: string;
  kind: string;
  parent?: string;
  /** Default true. */
  exported?: boolean;
  /** A doc comment is attached to this declaration. */
  doc?: boolean;
  /** Substring the COMPLETE signature must contain (proves a multi-line header was not truncated). */
  sig?: string;
}

export interface ExpectedRelation {
  kind: "extends" | "implements";
  from: string;
  to: string;
}

export interface ExpectedFile {
  /** EXHAUSTIVE for this file: anything the engine reports beyond this counts against precision. */
  symbols: ExpectedSymbol[];
  /** Callee names the file's call sites should yield (exhaustive over cross-symbol calls). */
  calls?: string[];
  relations?: ExpectedRelation[];
}

export interface ExpectedSet {
  lang: string;
  files: Record<string, ExpectedFile>;
}

export interface Score {
  expected: number;
  found: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface LangReport {
  lang: string;
  symbols: Score;
  /** Of the matched symbols, the fraction whose `kind` is the expected one. */
  kindAccuracy: number;
  /** Of the matched symbols, the fraction whose `exported` is the expected one. */
  exportedAccuracy: number;
  /** Of the symbols expected to carry a doc comment, the fraction that do. */
  docCoverage: number;
  /** Of the symbols expected to carry a complete signature, the fraction that do. */
  sigCoverage: number;
  calls: Score;
  relations: Score;
  /** Diagnostics for the report — never part of the ratchet. */
  missing: string[];
  spurious: string[];
  wrongKind: string[];
  missingDoc: string[];
  missingSig: string[];
}

const ZERO: Score = { expected: 0, found: 0, matched: 0, precision: 1, recall: 1, f1: 1 };

// Precision/recall/F1 with the empty-set convention that makes a ratchet sane:
// nothing expected AND nothing found is a perfect 1 (not 0/0), because a
// language whose fixture declares no relations must not drag its own baseline
// down forever.
function score(expected: Set<string>, found: Set<string>): Score {
  if (!expected.size && !found.size) return { ...ZERO };
  let matched = 0;
  for (const k of expected) if (found.has(k)) matched++;
  const precision = found.size ? matched / found.size : expected.size ? 0 : 1;
  const recall = expected.size ? matched / expected.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    expected: expected.size,
    found: found.size,
    matched,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
  };
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

// Identity of a declaration: its immediate name path. Two same-named methods on
// different classes are distinct; an unqualified homonym is distinct from both —
// which is exactly the precision property the Rust `impl` / Go receiver fixes
// are meant to restore.
function idOf(s: { name: string; parent?: string }): string {
  return s.parent ? `${s.parent}/${s.name}` : s.name;
}

// A "complete signature" is whichever of the two signature fields is longest:
// `signature` is the first line (unchanged for compat), `signatureFull` the
// whole header when it spans more. Reading both keeps the harness honest
// before AND after the Phase 1 change instead of hard-coding one field.
function fullSignature(s: CodeSymbol & { signatureFull?: string }): string {
  const a = s.signature ?? "";
  const b = s.signatureFull ?? "";
  return b.length > a.length ? b : a;
}

interface ExtractedFile {
  symbols: CodeSymbol[];
  callNames: Set<string>;
  relations: Set<string>;
}

function extractFixtureFile(dir: string, rel: string): ExtractedFile {
  const abs = join(dir, rel);
  const content = readFileSync(abs, "utf8");
  const ext = rel.slice(rel.lastIndexOf("."));
  const info = extractCode(rel, ext, content) as ReturnType<typeof extractCode> & {
    relations?: { kind: string; from: string; to: string }[];
  };
  return {
    symbols: info.symbols,
    callNames: new Set((info.calls ?? []).map((c) => c.name)),
    // `relations` does not exist yet (Phase 2 adds it). Absent → an empty set,
    // so a fixture that expects relations scores 0 recall rather than crashing:
    // the harness measures the gap instead of hiding it.
    relations: new Set((info.relations ?? []).map((r) => `${r.kind} ${r.from} ${r.to}`)),
  };
}

export function scoreLang(lang: string): LangReport {
  const dir = join(FIXTURES_DIR, lang);
  const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as ExpectedSet;

  const expSyms = new Set<string>();
  const foundSyms = new Set<string>();
  const expCalls = new Set<string>();
  const foundCalls = new Set<string>();
  const expRels = new Set<string>();
  const foundRels = new Set<string>();

  // Attribute tallies, over MATCHED symbols only.
  let kindOk = 0;
  let kindTotal = 0;
  let expOk = 0;
  let expTotal = 0;
  let docOk = 0;
  let docTotal = 0;
  let sigOk = 0;
  let sigTotal = 0;
  const wrongKind: string[] = [];
  const missingDoc: string[] = [];
  const missingSig: string[] = [];

  for (const rel of Object.keys(expected.files).sort(byStr)) {
    const spec = expected.files[rel]!;
    const got = extractFixtureFile(dir, rel);

    // Index what the engine found, first-wins per identity (mirrors how the
    // symbol index itself dedups).
    const bySymId = new Map<string, CodeSymbol>();
    for (const s of got.symbols) if (!bySymId.has(idOf(s))) bySymId.set(idOf(s), s);
    for (const id of bySymId.keys()) foundSyms.add(`${rel}:${id}`);

    for (const e of spec.symbols) {
      const id = idOf(e);
      expSyms.add(`${rel}:${id}`);
      const hit = bySymId.get(id);
      if (e.doc) {
        docTotal++;
        if (hit && typeof (hit as CodeSymbol & { doc?: string }).doc === "string") docOk++;
        else missingDoc.push(`${rel}:${id}`);
      }
      if (e.sig) {
        sigTotal++;
        if (hit && fullSignature(hit).includes(e.sig)) sigOk++;
        else missingSig.push(`${rel}:${id} → ${JSON.stringify(hit ? fullSignature(hit) : "")}`);
      }
      if (!hit) continue;
      kindTotal++;
      if (hit.kind === e.kind) kindOk++;
      else wrongKind.push(`${rel}:${id} → ${hit.kind} (expected ${e.kind})`);
      expTotal++;
      if (hit.exported === (e.exported ?? true)) expOk++;
    }

    for (const c of spec.calls ?? []) expCalls.add(`${rel}:${c}`);
    for (const c of got.callNames) foundCalls.add(`${rel}:${c}`);
    for (const r of spec.relations ?? []) expRels.add(`${rel}:${r.kind} ${r.from} ${r.to}`);
    for (const r of got.relations) foundRels.add(`${rel}:${r}`);
  }

  const missing = [...expSyms].filter((k) => !foundSyms.has(k)).sort(byStr);
  const spurious = [...foundSyms].filter((k) => !expSyms.has(k)).sort(byStr);

  return {
    lang,
    symbols: score(expSyms, foundSyms),
    kindAccuracy: kindTotal ? round(kindOk / kindTotal) : 1,
    exportedAccuracy: expTotal ? round(expOk / expTotal) : 1,
    docCoverage: docTotal ? round(docOk / docTotal) : 1,
    sigCoverage: sigTotal ? round(sigOk / sigTotal) : 1,
    // Calls are recall-oriented by design (a stray name resolves to nothing
    // downstream), so precision is reported but the fixtures list the callees
    // exhaustively — a spurious call is still visible.
    calls: score(expCalls, foundCalls),
    relations: score(expRels, foundRels),
    missing,
    spurious,
    wrongKind: wrongKind.sort(byStr),
    missingDoc: missingDoc.sort(byStr),
    missingSig: missingSig.sort(byStr),
  };
}

/** Every labelled language, in directory order. */
export function languages(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(FIXTURES_DIR, d.name, "expected.json")))
    .map((d) => d.name)
    .sort(byStr);
}

export function scoreAll(): LangReport[] {
  return languages().map(scoreLang);
}

// The ratcheted numbers only — diagnostics (missing/spurious/wrongKind) stay
// out, so the baseline file diffs cleanly and reviewing a change to it means
// reviewing a change in QUALITY, not a reshuffled list of names.
export interface LangBaseline {
  symbolsPrecision: number;
  symbolsRecall: number;
  symbolsF1: number;
  kindAccuracy: number;
  exportedAccuracy: number;
  docCoverage: number;
  sigCoverage: number;
  callsF1: number;
  relationsF1: number;
}

export function baselineOf(r: LangReport): LangBaseline {
  return {
    symbolsPrecision: r.symbols.precision,
    symbolsRecall: r.symbols.recall,
    symbolsF1: r.symbols.f1,
    kindAccuracy: r.kindAccuracy,
    exportedAccuracy: r.exportedAccuracy,
    docCoverage: r.docCoverage,
    sigCoverage: r.sigCoverage,
    callsF1: r.calls.f1,
    relationsF1: r.relations.f1,
  };
}

export const RATCHETED_METRICS = [
  "symbolsPrecision",
  "symbolsRecall",
  "symbolsF1",
  "kindAccuracy",
  "exportedAccuracy",
  "docCoverage",
  "sigCoverage",
  "callsF1",
  "relationsF1",
] as const satisfies readonly (keyof LangBaseline)[];

function pct(n: number): string {
  return `${(n * 100).toFixed(1).padStart(5)}%`;
}

export function formatReport(reports: LangReport[]): string {
  const rows = [
    "lang        symP   symR   symF1  kind   export doc    sig    calls  rels",
    "----------- ------ ------ ------ ------ ------ ------ ------ ------ ------",
  ];
  for (const r of reports) {
    const b = baselineOf(r);
    rows.push(
      [
        r.lang.padEnd(11),
        pct(b.symbolsPrecision),
        pct(b.symbolsRecall),
        pct(b.symbolsF1),
        pct(b.kindAccuracy),
        pct(b.exportedAccuracy),
        pct(b.docCoverage),
        pct(b.sigCoverage),
        pct(b.callsF1),
        pct(b.relationsF1),
      ].join(" "),
    );
  }
  const mean = (pick: (b: LangBaseline) => number): number =>
    reports.length ? reports.reduce((a, r) => a + pick(baselineOf(r)), 0) / reports.length : 1;
  rows.push(
    "----------- ------ ------ ------ ------ ------ ------ ------ ------ ------",
    [
      "MEAN".padEnd(11),
      pct(mean((b) => b.symbolsPrecision)),
      pct(mean((b) => b.symbolsRecall)),
      pct(mean((b) => b.symbolsF1)),
      pct(mean((b) => b.kindAccuracy)),
      pct(mean((b) => b.exportedAccuracy)),
      pct(mean((b) => b.docCoverage)),
      pct(mean((b) => b.sigCoverage)),
      pct(mean((b) => b.callsF1)),
      pct(mean((b) => b.relationsF1)),
    ].join(" "),
  );
  return rows.join("\n");
}
