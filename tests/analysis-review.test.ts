import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { findDeadCode } from "../src/deadcode.js";
import { complexityOfSource, riskHotspots } from "../src/complexity.js";
import { BETWEENNESS_MAX_NODES, pagerankOf } from "../src/centrality.js";
import { buildArtifactsFromScan } from "../src/pipeline.js";
import { renderRepoMap } from "../src/repomap.js";
import { findReferences } from "../src/query.js";
import { explainQuery } from "../src/bm25.js";
import { keywords, subtokens } from "../src/util.js";
import type { Edge } from "../src/types.js";

// The analysis and search fixes of the 2026-10 review, one case per defect.

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-analysis-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
const dead = (root: string) => findDeadCode(scanRepo(root));

describe("dead code", () => {
  it("a Go doc comment is not a use of the function it documents", () => {
    const root = repo({
      "go.mod": "module example.com/lib\n\ngo 1.22\n",
      "internal/strutil/strutil.go":
        "package strutil\n\n// Reverse returns s reversed.\nfunc Reverse(s string) string {\n\treturn s\n}\n\nfunc PadLeft(s string) string {\n\treturn s\n}\n",
    });
    const d = dead(root);
    expect(d.find((s) => s.name === "Reverse")?.tier).toBe("unreferenced");
    expect(d.find((s) => s.name === "PadLeft")?.tier).toBe("unreferenced");
  });

  it("a Go library's exported API is a root; a main package's is not", () => {
    const root = repo({
      "go.mod": "module example.com/lib\n\ngo 1.22\n",
      "strutil/strutil.go": "package strutil\n\nfunc PadLeft(s string) string {\n\treturn s\n}\n",
      "cmd/app/app.go": "package main\n\nfunc Helper() {}\n\nfunc main() {}\n",
    });
    const names = dead(root).map((s) => s.name);
    expect(names).not.toContain("PadLeft");
    expect(names).toContain("Helper");
  });

  it("a published Gradle library's public types are roots; an application's are not", () => {
    const api = "package acme;\n\npublic class Api {\n  public void run() {}\n}\n";
    const lib = repo({ "build.gradle": "plugins {\n  id 'java-library'\n}\n", "src/main/java/acme/Api.java": api });
    const app = repo({ "build.gradle": "plugins {\n  id 'application'\n}\n", "src/main/java/acme/Api.java": api });
    expect(dead(lib).map((s) => s.name)).not.toContain("Api");
    expect(dead(app).map((s) => s.name)).toContain("Api");
  });
});

describe("complexity", () => {
  it("counts a language's branch words, not identifiers that share them", () => {
    expect(complexityOfSource("const match = re.exec(s);\nconst when = 1;\nconst cased = match;\n", "typescript")).toBe(1);
    expect(complexityOfSource("match x {\n    _ => 1,\n}\n", "rust")).toBe(2);
    expect(complexityOfSource("match = re.match(s)\nmatch x:\n    case 1:\n        pass\n    case _:\n        pass\n", "python")).toBe(3);
    expect(complexityOfSource("case x\nwhen 1 then a\nwhen 2 then b\nend\n", "ruby")).toBe(3);
  });

  it("risk ranks only the files the window changed", () => {
    const root = repo({ "a.ts": "export function a(x: number) {\n  if (x) return 1;\n  return 2;\n}\n", "b.ts": "export function b(x: number) {\n  if (x) return 1;\n  if (x > 1) return 3;\n  return 2;\n}\n" });
    expect(riskHotspots(scanRepo(root), new Map([["a.ts", 3]])).map((r) => r.file)).toEqual(["a.ts"]);
  });
});

describe("centrality", () => {
  it("PageRank reaches its fixed point on a slowly mixing graph", () => {
    const n = 50;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const edges = ids.map((s, i) => ({ from: s, to: ids[(i + 1) % n], kind: "import", weight: 1 }) as Edge);
    edges.push({ from: "n0", to: "n25", kind: "import", weight: 50 } as Edge);
    // The fixed point, by iterating far past convergence.
    const idx = new Map(ids.map((s, i) => [s, i]));
    const outW = new Array<number>(n).fill(0);
    for (const e of edges) outW[idx.get(e.from)!]! += e.weight;
    let pr = new Array<number>(n).fill(1 / n);
    for (let k = 0; k < 5_000; k++) {
      const next = new Array<number>(n).fill(0.15 / n);
      for (const e of edges) next[idx.get(e.to)!]! += (0.85 * pr[idx.get(e.from)!]! * e.weight) / outW[idx.get(e.from)!]!;
      pr = next;
    }
    const got = pagerankOf(ids, edges);
    // 100 iterations stopped 1.4e-9 short; converged, it is within the 1e-10 threshold.
    expect(Math.max(...ids.map((s, i) => Math.abs(got.get(s)! - pr[i]!)))).toBeLessThan(1e-10);
  });

  it("a skipped betweenness pass is said in the build's notes", { timeout: 120_000 }, () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= BETWEENNESS_MAX_NODES; i++) files[`m${i}/a.md`] = "# a\n";
    const { notes, graph } = buildArtifactsFromScan(scanRepo(repo(files)));
    expect(graph.modules.length).toBeGreaterThan(BETWEENNESS_MAX_NODES);
    expect(notes?.some((n) => n.startsWith("betweenness skipped"))).toBe(true);
  });
});

describe("repo map", () => {
  it("skips a top file too large for the budget instead of stopping there", () => {
    const big = Array.from({ length: 200 }, (_, i) => `export function bigFunctionNumber${i}(argumentOne: string, argumentTwo: number): string { return argumentOne; }`).join("\n");
    const root = repo({
      "src/big.ts": big + "\n",
      "src/small.ts": "export function tiny(): number {\n  return 1;\n}\n",
      "src/a.ts": 'import { bigFunctionNumber0 } from "./big";\nimport { tiny } from "./small";\nexport const a = bigFunctionNumber0("x", 1) + tiny();\n',
      "src/b.ts": 'import { bigFunctionNumber1 } from "./big";\nexport const b = bigFunctionNumber1("x", 1);\n',
      "src/c.ts": 'import { bigFunctionNumber2 } from "./big";\nexport const c = bigFunctionNumber2("x", 1);\n',
    });
    const scan = scanRepo(root);
    const map = renderRepoMap(scan, buildArtifactsFromScan(scan).graph, { budgetTokens: 80 });
    expect(map).not.toContain("src/big.ts:");
    expect(map).toContain("src/small.ts:");
  });
});

describe("references and search", () => {
  it("finds a doc that mentions a name beginning with $", () => {
    const root = repo({ "src/http.js": "export const $http = {};\n", "README.md": "Use `$http` to call the API.\n" });
    expect(findReferences(scanRepo(root), "$http").referencingFiles).toContain("README.md");
  });

  it("a qualified name exists only if every part does", () => {
    const root = repo({ "README.md": "# readme\n\nThe readme.\n", "src/a.ts": "export const a = 1;\n" });
    const { explain } = explainQuery(scanRepo(root), "README.qqqzzzmissing");
    expect(explain.wholeIdentifier).toEqual({ term: "README.qqqzzzmissing", df: 0 });
    expect(explain.verdict).toBe("weak");
  });

  it("a trigram bridge scoring exactly 0.9 is labelled trigram, not stem", () => {
    const root = repo({ "src/a.ts": "export const xxxyxxzxz = 1;\n" });
    const { explain } = explainQuery(scanRepo(root), "xxxyxxz");
    expect(explain.terms[0]?.bridge).toMatchObject({ via: "trigram", to: ["xxxyxxzxz"], dice: 0.9 });
  });

  it("tokenizes letters of every script", () => {
    expect(subtokens("конфигурация")).toEqual(["конфигурация"]);
    expect(subtokens("日本語")).toEqual(["日本語"]);
    expect(subtokens("Œuvre")).toEqual(["œuvre"]);
    expect(subtokens("parseÉcoleNormale")).toEqual(["parseecolenormale", "parse", "ecole", "normale"]);
    expect(keywords("où est København")).toEqual(["ou", "est", "København"]);
  });
});
