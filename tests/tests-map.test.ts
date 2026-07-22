import { describe, it, expect } from "vitest";
import { isTestPath, computeTestMap, testsForModule, untestedModules } from "../src/tests-map.js";
import type { Edge, FileNode, Graph, ModuleNode, Tier } from "../src/types.js";

const mod = (slug: string, members: string[], tier: Tier = 1, symbols = 1): ModuleNode => ({
  id: slug,
  kind: "module",
  slug,
  path: slug,
  title: slug,
  summary: "",
  tier,
  members,
  symbols,
  degIn: 0,
  degOut: 0,
});

const file = (rel: string, module: string, fileKind: FileNode["fileKind"] = "code"): FileNode => ({
  id: rel,
  kind: "file",
  rel,
  fileKind,
  lang: "ts",
  module,
  symbols: 1,
  lines: 1,
  degIn: 0,
  degOut: 0,
});

const edge = (from: string, to: string, kind: Edge["kind"] = "import"): Edge => ({ from, to, kind, weight: 1 });

const graphOf = (modules: ModuleNode[], files: FileNode[], fileEdges: Edge[]): Graph => ({
  schemaVersion: 4,
  version: "0.0.0",
  fileCount: files.length,
  languages: {},
  files,
  modules,
  fileEdges,
  moduleEdges: [],
});

describe("isTestPath", () => {
  const yes = [
    "src/find.test.ts",
    "src/find.spec.tsx",
    "app/__tests__/helper.js",
    "pkg/test_scan.py",
    "pkg/scan_test.py",
    "server/main_test.go",
    "src/test/java/FooTest.java",
    "app/FooTests.kt",
    "spec/models/user_spec.rb",
    "crate/tests/integration.rs",
    "src/FooTest.php",
    "App/FooTests.cs",
    "lib/foo_test.exs",
    "e2e/login.py",
  ];
  const no = [
    "src/find.ts",
    "src/testing-utils.ts", // "testing" is not a test dir segment
    "docs/tests.md",
    "pkg/contest.py", // substring, not a basename match
    "src/protester.go",
    "examples/demo.py", // examples are tier-2 material but NOT tests
    "fixtures/sample_test_data.json",
  ];
  for (const rel of yes) {
    it(`matches ${rel}`, () => {
      expect(isTestPath(rel)).toBe(true);
    });
  }
  for (const rel of no) {
    it(`does not match ${rel}`, () => {
      expect(isTestPath(rel)).toBe(false);
    });
  }
});

describe("computeTestMap", () => {
  it("maps sources and modules to the tests importing them; docs and mentions do not count", () => {
    const g = graphOf(
      [mod("src", ["src/a.ts", "src/a.test.ts"]), mod("lib", ["lib/b.ts"]), mod("docs", ["docs/x.md"], 2)],
      [
        file("src/a.ts", "src"),
        file("src/a.test.ts", "src"),
        file("lib/b.ts", "lib"),
        file("docs/x.md", "docs", "doc"),
      ],
      [
        edge("src/a.test.ts", "src/a.ts"), // same-module test — the canonical case
        edge("docs/x.md", "lib/b.ts", "mention"), // a doc naming a symbol is not test evidence
        edge("src/a.test.ts", "docs/x.md", "doc-link"),
      ],
    );
    const tm = computeTestMap(g);
    expect([...tm.testFiles]).toEqual(["src/a.test.ts"]);
    expect(tm.testedByFile.get("src/a.ts")).toEqual(["src/a.test.ts"]);
    expect(tm.testedByFile.has("lib/b.ts")).toBe(false);
    expect(tm.testedByModule.get("src")).toEqual(["src/a.test.ts"]);
    expect(tm.testedByModule.has("lib")).toBe(false);
  });

  it("counts call and use edges as coverage but skips dangling and test→test edges", () => {
    const g = graphOf(
      [mod("src", ["src/a.ts", "src/b.ts"]), mod("t", ["tests/x.test.ts", "tests/util.ts"], 2)],
      [
        file("src/a.ts", "src"),
        file("src/b.ts", "src"),
        file("tests/x.test.ts", "t"),
        file("tests/util.ts", "t"), // inside tests/ → itself test material
      ],
      [
        edge("tests/x.test.ts", "src/a.ts", "call"),
        edge("tests/x.test.ts", "tests/util.ts"), // test → test helper: not coverage
        { ...edge("tests/x.test.ts", "src/b.ts", "use"), dangling: true },
      ],
    );
    const tm = computeTestMap(g);
    expect(tm.testedByFile.get("src/a.ts")).toEqual(["tests/x.test.ts"]);
    expect(tm.testedByFile.has("src/b.ts")).toBe(false);
    expect(tm.testedByFile.has("tests/util.ts")).toBe(false);
  });
});

describe("testsForModule / untestedModules", () => {
  const g = graphOf(
    [
      mod("core", ["core/a.ts"]),
      mod("web", ["web/b.ts"]),
      mod("docs", ["docs/x.md"], 1, 0), // doc-only: no symbols → never "untested"
      mod("tail", ["scripts/s.ts"], 2), // tier 2 → out of scope
    ],
    [
      file("core/a.ts", "core"),
      file("web/b.ts", "web"),
      file("docs/x.md", "docs", "doc"),
      file("scripts/s.ts", "tail"),
      file("core/a.test.ts", "core"),
    ],
    [edge("core/a.test.ts", "core/a.ts")],
  );

  it("returns the covering tests for a module, empty for uncovered ones", () => {
    expect(testsForModule(g, "core")).toEqual(["core/a.test.ts"]);
    expect(testsForModule(g, "web")).toEqual([]);
  });

  it("lists only tier<=1 code modules without coverage as untested", () => {
    expect(untestedModules(g).map((m) => m.slug)).toEqual(["web"]);
  });
});

describe("tests-map in the pipeline", () => {
  it("stamps testFile/testedBy onto the built graph", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildIndexArtifacts } = await import("../src/pipeline.js");

    const repo = mkdtempSync(join(tmpdir(), "ci-tm-repo-"));
    mkdirSync(join(repo, "src", "b"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), 'export function alpha(): number {\n  return 1;\n}\n');
    writeFileSync(join(repo, "src", "a.test.ts"), 'import { alpha } from "./a";\nexport const t = alpha();\n');
    writeFileSync(join(repo, "src", "b", "c.ts"), 'export function beta(): number {\n  return 2;\n}\n');

    const { graph } = buildIndexArtifacts(repo);
    expect(graph.files.find((f) => f.rel === "src/a.test.ts")!.testFile).toBe(true);
    expect(graph.files.find((f) => f.rel === "src/a.ts")!.testFile).toBeUndefined();
    const srcMod = graph.modules.find((m) => m.members.includes("src/a.ts"))!;
    expect(srcMod.testedBy).toEqual(["src/a.test.ts"]);
    const bMod = graph.modules.find((m) => m.members.includes("src/b/c.ts"))!;
    expect(bMod.testedBy).toBeUndefined();
  });
});
