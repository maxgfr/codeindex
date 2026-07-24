// Per-scan derived-structure cache (src/derived.ts): repeat queries on ONE
// scan must be byte-equal to each other AND to a fresh-scan run (memoization
// is invisible in output), and consumer mutations of returned objects must
// never poison the cache.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan.js";
import { findReferences } from "../src/query.js";
import { findDeadCode } from "../src/deadcode.js";
import { searchIndex } from "../src/bm25.js";
import { computeImportPairs } from "../src/callers.js";
import { riskHotspots } from "../src/complexity.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ci-derived-"));
  writeFileSync(
    join(root, "widget.ts"),
    "export class Widget {\n  size(): number {\n    return 1;\n  }\n}\n\nexport function makeWidget(): Widget {\n  return new Widget();\n}\n\nexport function neverCalled(): number {\n  return 2;\n}\n",
  );
  writeFileSync(join(root, "app.ts"), 'import { makeWidget } from "./widget";\nexport const w = makeWidget();\n');
  writeFileSync(join(root, "README.md"), "Use `makeWidget` to build widgets.\n");
  return root;
}

describe("per-scan derived cache", () => {
  it("repeat findReferences / searchIndex / findDeadCode on one scan are byte-equal to a fresh-scan run", () => {
    const root = makeRepo();
    const scan = scanRepo(root);

    const refs1 = findReferences(scan, "makeWidget");
    const search1 = searchIndex(scan, "make widget");
    const fuzzy1 = searchIndex(scan, "makeWidgt"); // df==0 term → trigram path
    const dead1 = findDeadCode(scan);

    // Non-trivial fixtures, so byte-equality below is not vacuous.
    expect(refs1.callSites).toEqual([{ file: "app.ts", line: 2 }]);
    expect(search1[0]!.file).toBe("widget.ts");
    expect(fuzzy1[0]!.fuzzyTerms).toBeDefined();
    expect(dead1.map((d) => d.name)).toContain("neverCalled");

    // Second round on the SAME scan object: every structure now comes from the
    // WeakMap cache — output must be byte-identical.
    expect(JSON.stringify(findReferences(scan, "makeWidget"))).toBe(JSON.stringify(refs1));
    expect(JSON.stringify(searchIndex(scan, "make widget"))).toBe(JSON.stringify(search1));
    expect(JSON.stringify(searchIndex(scan, "makeWidgt"))).toBe(JSON.stringify(fuzzy1));
    expect(JSON.stringify(findDeadCode(scan))).toBe(JSON.stringify(dead1));

    // A FRESH scan (cold cache) of the same tree produces the same bytes — the
    // cache only removes recomputation, never changes a value.
    const fresh = scanRepo(root);
    expect(JSON.stringify(findReferences(fresh, "makeWidget"))).toBe(JSON.stringify(refs1));
    expect(JSON.stringify(searchIndex(fresh, "make widget"))).toBe(JSON.stringify(search1));
    expect(JSON.stringify(searchIndex(fresh, "makeWidgt"))).toBe(JSON.stringify(fuzzy1));
    expect(JSON.stringify(findDeadCode(fresh))).toBe(JSON.stringify(dead1));
  });

  it("mutating findReferences(...).callSites does not poison the cache", () => {
    const scan = scanRepo(makeRepo());
    const first = findReferences(scan, "makeWidget");
    expect(first.callSites).toEqual([{ file: "app.ts", line: 2 }]);

    first.callSites.length = 0;
    first.callSites.push({ file: "hacked.ts", line: 999 });

    const second = findReferences(scan, "makeWidget");
    expect(second.callSites).toEqual([{ file: "app.ts", line: 2 }]);
    expect(second.referencingFiles).toContain("app.ts");
  });

  it("computeImportPairs returns a fresh Set per call — mutations stay with the caller", () => {
    const scan = scanRepo(makeRepo());
    const first = computeImportPairs(scan);
    expect(first.has("app.ts|widget.ts")).toBe(true);

    first.clear();
    first.add("evil.ts|widget.ts");

    const second = computeImportPairs(scan);
    expect(second.has("app.ts|widget.ts")).toBe(true);
    expect(second.has("evil.ts|widget.ts")).toBe(false);
    expect(second).not.toBe(first);
  });

  it("repeat riskHotspots calls on one scan are byte-equal (memoized per-file complexity)", () => {
    const root = makeRepo();
    const scan = scanRepo(root);
    const churn = new Map([["widget.ts", 3]]);
    const first = riskHotspots(scan, churn);
    expect(first.length).toBeGreaterThan(0);
    expect(JSON.stringify(riskHotspots(scan, churn))).toBe(JSON.stringify(first));
    expect(JSON.stringify(riskHotspots(scanRepo(root), churn))).toBe(JSON.stringify(first));
  });
});
