// Controlled product tasks with a hand-checked answer key. These do not feed
// the compiler-derived competitor benchmark or claim type-aware precision.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { buildCallerIndex } from "../src/callers.js";
import { impactOf } from "../src/traverse.js";
import { searchIndex } from "../src/bm25.js";

const root = mkdtempSync(join(tmpdir(), "codeindex-usefulness-"));
for (const [file, text] of Object.entries({
  "shipping.ts": "export function calculateShipping(weight: number) {\n  return weight * 2;\n}\n",
  "checkout.ts": 'import { calculateShipping } from "./shipping";\nexport function checkoutOrder() {\n  return calculateShipping(3);\n}\n',
  "route.ts": 'import { checkoutOrder } from "./checkout";\nexport function handleCheckout() {\n  return checkoutOrder();\n}\n',
  "unrelated.ts": "// calculateShipping is mentioned in this comment, without a dependency.\nexport function otherFeature() { return 4; }\n",
})) writeFileSync(join(root, file), text);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { scan, graph } = buildIndexArtifacts(root);

describe("agent questions on a controlled shipping-change scenario", () => {
  it("who calls calculateShipping: names the direct call, not transitive users or comments", () => {
    const entry = buildCallerIndex(scan).get("calculateShipping");
    expect(entry?.def.file).toBe("shipping.ts");
    expect(entry?.callers).toEqual([{ file: "checkout.ts", line: 3 }]);
  });

  it("what is affected by changing shipping: includes the two-hop route", () => {
    expect(impactOf(graph, "shipping.ts")?.files.map(({ rel, depth }) => ({ rel, depth }))).toEqual([
      { rel: "checkout.ts", depth: 1 }, { rel: "route.ts", depth: 2 },
    ]);
    expect(impactOf(graph, "shipping.ts", 1)?.files.map((f) => f.rel)).toEqual(["checkout.ts"]);
    expect(impactOf(graph, "missing.ts")).toBeUndefined();
  });

  it("which files to inspect for a calculateShipping change: search finds the implementation then the graph finds consumers", () => {
    const results = searchIndex(scan, "calculateShipping");
    expect(results[0]?.file).toBe("shipping.ts");
    expect(results[0]?.symbolHits).toContainEqual({ name: "calculateShipping", kind: "function", line: 1 });
    const target = results[0]!.file;
    const inspect = [target, ...impactOf(graph, target)!.files.map((f) => f.rel)];
    expect(inspect).toEqual(["shipping.ts", "checkout.ts", "route.ts"]);
    expect(searchIndex(scan, "aSymbolThatDoesNotExist")).toEqual([]);
  });
});
