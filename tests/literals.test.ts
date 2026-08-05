import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { findLiteralDuplications } from "../src/literals.js";
import { collectLiteralsRegex, extractCode } from "../src/extract/code.js";
import { scanRepo } from "../src/scan.js";
import type { FileRecord } from "../src/types.js";
import type { RepoScan } from "../src/scan.js";

// Hand-built scans: findLiteralDuplications reads only `literals` and
// `symbols` off each record, so a minimal scan isolates each tier's semantics
// without a parse in the loop.
function rec(rel: string, o: Partial<FileRecord> = {}): FileRecord {
  return {
    rel,
    ext: ".ts",
    size: 1,
    lines: 10,
    hash: rel,
    kind: "code",
    lang: "typescript",
    headings: [],
    symbols: [],
    refs: [],
    ...o,
  };
}

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/x", files, walk: { files: [], excluded: 0, capped: false } } as unknown as RepoScan;
}

const PATH = "/declaration/parcours-conformite";

function holder(name: string, line: number, signature: string) {
  return { name, kind: "const", file: "x", line, endLine: line, exported: true, lang: "typescript", signature };
}

describe("literal duplication tiers", () => {
  it("reports a value nothing holds as uncentralized", () => {
    const scan = scanOf([
      rec("a.ts", { literals: [{ value: PATH, line: 1, kind: "string" }] }),
      rec("b.ts", { literals: [{ value: PATH, line: 2, kind: "string" }] }),
      rec("c.ts", { literals: [{ value: PATH, line: 3, kind: "string" }] }),
    ]);
    const { duplications } = findLiteralDuplications(scan);
    expect(duplications).toHaveLength(1);
    expect(duplications[0]).toMatchObject({ tier: "uncentralized", files: 3, count: 3 });
    expect(duplications[0]!.holders).toEqual([]);
  });

  it("reports a held value that others rewrite as bypassed", () => {
    const scan = scanOf([
      rec("const.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("BASE_PATH", 1, `export const BASE_PATH = "${PATH}";`)],
      }),
      rec("b.ts", { literals: [{ value: PATH, line: 2, kind: "string" }] }),
      rec("c.ts", { literals: [{ value: PATH, line: 3, kind: "string" }] }),
    ]);
    const [dup] = findLiteralDuplications(scan).duplications;
    expect(dup).toMatchObject({ tier: "bypassed" });
    expect(dup!.holders.map((h) => h.holder)).toEqual(["BASE_PATH"]);
    expect(dup!.literals.map((l) => l.file)).toEqual(["b.ts", "c.ts"]);
  });

  it("reports two constants holding one value as competing", () => {
    const scan = scanOf([
      rec("one.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("BASE_PATH", 1, `export const BASE_PATH = "${PATH}";`)],
      }),
      rec("two.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("COMPLIANCE_PATH", 1, `export const COMPLIANCE_PATH = "${PATH}";`)],
      }),
      rec("use.ts", { literals: [{ value: PATH, line: 9, kind: "string" }] }),
    ]);
    const [dup] = findLiteralDuplications(scan).duplications;
    expect(dup).toMatchObject({ tier: "competing" });
    expect(dup!.holders.map((h) => h.holder)).toEqual(["BASE_PATH", "COMPLIANCE_PATH"]);
  });

  it("does not report a constant nobody bypasses", () => {
    const scan = scanOf([
      rec("const.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("BASE_PATH", 1, `export const BASE_PATH = "${PATH}";`)],
      }),
      rec("b.ts", { literals: [{ value: "/other/thing", line: 2, kind: "string" }] }),
    ]);
    expect(findLiteralDuplications(scan).duplications).toEqual([]);
  });

  // The failure that inverts the whole report: an arrow function returning a
  // path is a CONSUMER of the value, not a source of truth for it. Counting it
  // as a holder turns every bypass into a phantom "competing" finding.
  it("treats a function-valued const as a call site, not a holder", () => {
    const scan = scanOf([
      rec("real.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("BASE_PATH", 1, `export const BASE_PATH = "${PATH}";`)],
      }),
      rec("fn1.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("getPath", 1, `export const getPath = () => "${PATH}";`)],
      }),
      rec("fn2.ts", {
        literals: [{ value: PATH, line: 1, kind: "string" }],
        symbols: [holder("makeHref", 1, `export const makeHref = async (x: string) => "${PATH}";`)],
      }),
      // `signature` is capped at the declaration HEADER, so a multi-line
      // handler arrives without its `=>`. It is still a function.
      rec("fn3.ts", {
        literals: [{ value: PATH, line: 4, kind: "string" }],
        symbols: [{ ...holder("onStart", 1, "onStart = async ()"), endLine: 9, exported: false }],
      }),
    ]);
    const [dup] = findLiteralDuplications(scan).duplications;
    expect(dup).toMatchObject({ tier: "bypassed" });
    expect(dup!.holders.map((h) => h.holder)).toEqual(["BASE_PATH"]);
  });

  // A lookup table IS a source of truth — the distinction is function vs value,
  // not scalar vs compound.
  it("treats an exported table as a holder", () => {
    const scan = scanOf([
      rec("routes.ts", {
        literals: [{ value: PATH, line: 2, kind: "string" }],
        symbols: [
          { ...holder("ROUTES", 1, "export const ROUTES = {"), endLine: 3 },
        ],
      }),
      rec("a.ts", { literals: [{ value: PATH, line: 1, kind: "string" }] }),
      rec("b.ts", { literals: [{ value: PATH, line: 1, kind: "string" }] }),
    ]);
    const [dup] = findLiteralDuplications(scan).duplications;
    expect(dup!.holders.map((h) => h.holder)).toEqual(["ROUTES"]);
  });

  it("never merges a number with the string of the same digits", () => {
    const scan = scanOf([
      rec("a.ts", { literals: [{ value: "2027", line: 1, kind: "number" }] }),
      rec("b.ts", { literals: [{ value: "2027", line: 1, kind: "number" }] }),
      rec("c.ts", { literals: [{ value: "2027", line: 1, kind: "string" }] }),
      rec("d.ts", { literals: [{ value: "2027", line: 1, kind: "string" }] }),
    ]);
    const dups = findLiteralDuplications(scan, { minCount: 2 }).duplications;
    expect(dups.map((d) => d.kind).sort()).toEqual(["number", "string"]);
  });

  it("excludes test files by default and includes them on request", () => {
    const files = [
      rec("src/a.ts", { literals: [{ value: PATH, line: 1, kind: "string" }] }),
      rec("src/__tests__/a.test.ts", { literals: [{ value: PATH, line: 1, kind: "string" }] }),
      rec("src/b.test.ts", { literals: [{ value: PATH, line: 1, kind: "string" }] }),
    ];
    expect(findLiteralDuplications(scanOf(files), { minCount: 2 }).duplications).toEqual([]);
    const withTests = findLiteralDuplications(scanOf(files), { minCount: 2, includeTests: true });
    expect(withTests.duplications[0]).toMatchObject({ files: 3 });
  });

  it("groups path-like values into one namespace family", () => {
    const mk = (v: string, n: number) =>
      Array.from({ length: n }, (_, i) => rec(`f${v}${i}.ts`, { literals: [{ value: v, line: 1, kind: "string" }] }));
    const scan = scanOf([
      ...mk("/declaration/etape/1", 3),
      ...mk("/declaration/parcours/x", 3),
      ...mk("/autre/chose", 3),
    ]);
    const { families } = findLiteralDuplications(scan);
    expect(families.map((f) => f.prefix)).toEqual(["/declaration"]);
    expect(families[0]!.members).toHaveLength(2);
  });

  it("orders competing before bypassed before uncentralized", () => {
    const scan = scanOf([
      rec("u1.ts", { literals: [{ value: "/u/x", line: 1, kind: "string" }] }),
      rec("u2.ts", { literals: [{ value: "/u/x", line: 1, kind: "string" }] }),
      rec("c1.ts", {
        literals: [{ value: "/c/x", line: 1, kind: "string" }],
        symbols: [holder("C1", 1, 'export const C1 = "/c/x";')],
      }),
      rec("c2.ts", {
        literals: [{ value: "/c/x", line: 1, kind: "string" }],
        symbols: [holder("C2", 1, 'export const C2 = "/c/x";')],
      }),
      rec("b1.ts", {
        literals: [{ value: "/b/x", line: 1, kind: "string" }],
        symbols: [holder("B1", 1, 'export const B1 = "/b/x";')],
      }),
      rec("b2.ts", { literals: [{ value: "/b/x", line: 1, kind: "string" }] }),
    ]);
    const tiers = findLiteralDuplications(scan, { minCount: 2 }).duplications.map((d) => d.tier);
    expect(tiers).toEqual(["competing", "bypassed", "uncentralized"]);
  });
});

// The span join is what makes the feature tier-independent; if the two
// extraction tiers disagreed, a repo would report different findings depending
// on whether a wasm grammar happened to be on disk.
describe("extraction tier parity", () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "ci-literals-"));
    const write = (rel: string, body: string) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    write("src/constants.ts", `export const BASE_PATH = "${PATH}";\nexport const THRESHOLD = 5;\n`);
    write("src/one.ts", `export const a = () => "${PATH}";\n`);
    write("src/two.ts", `export const b = () => "${PATH}";\n`);
    write("rules.json", `{\n  "compliancePath": "${PATH}",\n  "gapAlertPercent": 5\n}\n`);
    return dir;
  }

  // The two collectors must agree on VALUES. A grammar being present or absent
  // on the machine must not change which duplications a repo reports.
  it("the AST and regex collectors agree on the values they keep", () => {
    const src = [
      `export const BASE_PATH = "${PATH}";`,
      "export const THRESHOLD = 5;",
      `export const go = () => "${PATH}/confirmation";`,
      "const n = 4096;",
    ].join("\n");
    const ast = extractCode("a.ts", ".ts", src).literals ?? [];
    const regex = collectLiteralsRegex(src) ?? [];
    const shape = (ls: typeof ast) =>
      [...ls].map((l) => `${l.kind} ${l.value} @${l.line}`).sort();
    expect(shape(ast)).toEqual(shape(regex));
    // And it is not vacuously equal — both actually found the path.
    expect(shape(ast)).toContain(`string ${PATH} @1`);
  });

  it("reads values out of config files, not just code", () => {
    const dups = findLiteralDuplications(scanRepo(fixture()), { minCount: 2 }).duplications;
    const path = dups.find((d) => d.value === PATH);
    expect(path?.literals.map((l) => l.file)).toContain("rules.json");
    // The cross-boundary threshold: a number declared once in TypeScript and
    // again in a rules JSON, which no compiler compares.
    const threshold = dups.find((d) => d.kind === "number" && d.value === "5");
    expect(threshold).toMatchObject({ tier: "bypassed" });
    expect(threshold!.holders.map((h) => h.holder)).toEqual(["THRESHOLD"]);
    expect(threshold!.literals.map((l) => l.file)).toEqual(["rules.json"]);
  });
});
