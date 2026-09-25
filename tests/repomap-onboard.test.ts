// What the repo map and the onboarding brief choose to show: production code
// ranked as production code sees it, and each file's public surface before its
// members and values.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderRepoMap } from "../src/repomap.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-repomap-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const ENGINE = [
  ...Array.from({ length: 6 }, (_, i) => `export const T_${i} = ${i};`),
  "export class Engine {",
  "  handlers: string[] = [];",
  "  _cache = new Map<string, number>();",
  ...["run", "use", "group", "handle", "close"].map((m) => `  ${m}(): void {}`),
  "}",
  "export function createEngine(): Engine {",
  "  return new Engine();",
  "}",
  "",
].join("\n");

// src/harness.ts is imported by four tests and nothing else; src/engine.ts by
// two production files. The stored PageRank counts the test edges.
const FILES = {
  "src/engine.ts": ENGINE,
  "src/harness.ts": "export function runHarness(): number {\n  return 1;\n}\n",
  "src/app.ts": 'import { createEngine } from "./engine";\nexport const app = createEngine();\n',
  "src/cli.ts": 'import { createEngine } from "./engine";\nexport const cli = createEngine();\n',
  ...Object.fromEntries(
    [1, 2, 3, 4].map((i) => [`tests/t${i}.test.ts`, `import { runHarness } from "../src/harness";\nexport const t${i} = runHarness();\n`]),
  ),
};

describe("repo map", () => {
  const { scan, graph } = buildIndexArtifacts(repo(FILES));
  const map = renderRepoMap(scan, graph, { budgetTokens: 2000 });
  const blocks = map.split("\n\n").slice(1, -1);

  it("ranks production files by production edges and never shows a test", () => {
    const pr = new Map(graph.files.map((f) => [f.rel, f.pagerank ?? 0]));
    expect(pr.get("src/harness.ts")!).toBeGreaterThan(pr.get("src/engine.ts")!); // the stored rank
    expect(blocks[0]!.split("\n")[0]).toBe("src/engine.ts:");
    expect(map).not.toContain("tests/");
    expect(map).toMatch(/\(4 of 4 code files shown/);
  });

  it("spends a file's slots on its public types and functions, then methods, then values", () => {
    expect(blocks[0]).toBe(
      [
        "src/engine.ts:",
        "  1: T_0 = 0",
        "  7: class Engine",
        "  10: run(): void",
        "  11: use(): void",
        "  12: group(): void",
        "  13: handle(): void",
        "  14: close(): void",
        "  16: function createEngine(): Engine",
        "  … 7 more",
      ].join("\n"),
    );
  });

  it("can leave out its title for a caller embedding it", () => {
    const body = (m: string): string => m.replace(/^# repo map — \d+ files\n/, "").replace(/\n\(\d+ of .*\n$/, "");
    const bare = renderRepoMap(scan, graph, { budgetTokens: 2000, bare: true });
    expect(bare.startsWith("\nsrc/engine.ts:")).toBe(true);
    expect(body(bare)).toBe(body(map));
  });
});
