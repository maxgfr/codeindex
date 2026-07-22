import { describe, expect, it } from "vitest";
import { buildCallerIndex } from "../src/callers.js";
import type { RepoScan } from "../src/scan.js";
import type { CodeSymbol, FileRecord } from "../src/types.js";

// Hand-built scans (calls.test.ts style): recall mode only changes the JS/TS
// import gate and adds the per-site confidence label, so minimal FileRecords
// isolate exactly those differences.
function sym(name: string, file: string, o: Partial<CodeSymbol> = {}): CodeSymbol {
  return { name, kind: o.kind ?? "function", file, line: o.line ?? 1, exported: o.exported ?? true, lang: o.lang ?? "typescript" };
}

function file(
  rel: string,
  o: { lang?: string; ext?: string; symbols?: CodeSymbol[]; calls?: { name: string; line: number }[] } = {},
): FileRecord {
  return {
    rel,
    ext: o.ext ?? ".ts",
    size: 0,
    lines: 1,
    hash: "h",
    kind: "code",
    lang: o.lang ?? "typescript",
    headings: [],
    symbols: o.symbols ?? [],
    refs: [],
    ...(o.calls ? { calls: o.calls } : {}),
  };
}

function scanOf(files: FileRecord[]): RepoScan {
  return { root: "/repo", files, languages: {}, docText: new Map(), mtimes: new Map(), capped: false };
}

// A JS/TS call with NO corroborating import whose callee name is defined in
// exactly one other file — the case the recall relaxation exists for.
const uniqueNoImport = () =>
  scanOf([
    file("src/a.ts", { calls: [{ name: "foo", line: 3 }] }),
    file("src/b.ts", { symbols: [sym("foo", "src/b.ts")] }),
  ]);

describe("buildCallerIndex recall mode (issue #7)", () => {
  it("default mode still drops a JS/TS bare call with no import evidence", () => {
    expect(buildCallerIndex(uniqueNoImport(), new Set()).size).toBe(0);
  });

  it("recall mode binds it when the name is unique repo-wide, labeled unique-name", () => {
    const index = buildCallerIndex(uniqueNoImport(), new Set(), { recall: true });
    expect(index.get("foo")).toEqual({
      def: sym("foo", "src/b.ts"),
      callers: [{ file: "src/a.ts", line: 3, confidence: "unique-name" }],
    });
  });

  it("recall mode labels an import-corroborated binding corroborated", () => {
    const index = buildCallerIndex(uniqueNoImport(), new Set(["src/a.ts|src/b.ts"]), { recall: true });
    expect(index.get("foo")!.callers).toEqual([{ file: "src/a.ts", line: 3, confidence: "corroborated" }]);
  });

  it("recall mode still drops a JS/TS name that is NOT unique repo-wide (no import)", () => {
    const scan = scanOf([
      file("src/a.ts", { calls: [{ name: "foo", line: 3 }] }),
      file("src/b.ts", { symbols: [sym("foo", "src/b.ts")] }),
      file("src/c.ts", { symbols: [sym("foo", "src/c.ts")] }),
    ]);
    expect(buildCallerIndex(scan, new Set(), { recall: true }).size).toBe(0);
  });

  it("recall mode labels same-file (shadowing) bindings corroborated", () => {
    const scan = scanOf([
      file("src/a.ts", { symbols: [sym("foo", "src/a.ts", { exported: false })], calls: [{ name: "foo", line: 7 }] }),
    ]);
    const index = buildCallerIndex(scan, new Set(), { recall: true });
    expect(index.get("foo")!.callers).toEqual([{ file: "src/a.ts", line: 7, confidence: "corroborated" }]);
  });

  it("recall mode labels a non-JS/TS unique-name inference unique-name", () => {
    const scan = scanOf([
      file("pkg/a.py", { lang: "python", ext: ".py", calls: [{ name: "helper", line: 2 }] }),
      file("pkg/b.py", { lang: "python", ext: ".py", symbols: [sym("helper", "pkg/b.py", { lang: "python" })] }),
    ]);
    const index = buildCallerIndex(scan, new Set(), { recall: true });
    expect(index.get("helper")!.callers).toEqual([{ file: "pkg/a.py", line: 2, confidence: "unique-name" }]);
  });

  it("default output is byte-unchanged: no opts, {}, and {recall: false} all serialize identically, without confidence", () => {
    const scan = () =>
      scanOf([
        file("src/a.ts", { calls: [{ name: "foo", line: 3 }, { name: "bar", line: 4 }] }),
        file("src/b.ts", { symbols: [sym("foo", "src/b.ts"), sym("bar", "src/b.ts")] }),
        file("pkg/c.py", { lang: "python", ext: ".py", calls: [{ name: "snake", line: 1 }] }),
        file("pkg/d.py", { lang: "python", ext: ".py", symbols: [sym("snake", "pkg/d.py", { lang: "python" })] }),
      ]);
    const pairs = () => new Set(["src/a.ts|src/b.ts"]);
    const serialize = (index: ReturnType<typeof buildCallerIndex>): string =>
      JSON.stringify([...index.entries()]);

    const base = serialize(buildCallerIndex(scan(), pairs()));
    expect(serialize(buildCallerIndex(scan(), pairs(), {}))).toBe(base);
    expect(serialize(buildCallerIndex(scan(), pairs(), { recall: false }))).toBe(base);
    expect(base).not.toContain("confidence");

    // And the recall run over the same scan differs ONLY by the labels here
    // (every binding already resolves), never by which sites are recorded.
    const recall = buildCallerIndex(scan(), pairs(), { recall: true });
    const plain = buildCallerIndex(scan(), pairs());
    expect([...recall.keys()]).toEqual([...plain.keys()]);
    for (const key of plain.keys()) {
      expect(recall.get(key)!.callers.map(({ file: f, line }) => ({ file: f, line }))).toEqual(plain.get(key)!.callers);
    }
  });
});
