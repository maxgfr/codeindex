// What the repo map and the onboarding brief choose to show: production code
// ranked as production code sees it, and each file's public surface before its
// members and values.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderRepoMap } from "../src/repomap.js";
import { onboardBrief, taglineFromReadme } from "../src/onboard.js";

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

describe("onboard tagline", () => {
  it("skips a release banner under an H2 and takes the description after the rule", () => {
    // gin's README, abridged.
    const readme = [
      "# Gin Web Framework",
      '<img align="right" src="logo.png">',
      "[![Build](https://x/badge.svg)](https://x)\n[![Go Report](https://y/badge.svg)](https://y)",
      "## 📰 Gin 1.12.0 is now available!",
      "We're excited to announce the release of **[Gin 1.12.0](https://gin-gonic.com/blog)**! This release brings new features.",
      "---",
      "Gin is a high-performance HTTP web framework written in [Go](https://go.dev/). It provides a Martini-like API.",
      "## Getting started",
      "Install it with go get.",
    ].join("\n\n");
    expect(taglineFromReadme(readme)).toBe("Gin is a high-performance HTTP web framework written in Go. It provides a Martini-like API.");
  });

  it("takes the paragraph under the H1, resolving reference links, and never a code block", () => {
    const readme = [
      '<div align="center"><img src="flask.svg"></div>',
      "# Flask",
      "```sh\n# install it\n\npip install flask and then read the long documentation\n```",
      "Flask is a lightweight [WSGI] web application framework.\nIt is designed to make getting started quick.",
      "[WSGI]: https://wsgi.readthedocs.io/",
    ].join("\n\n");
    expect(taglineFromReadme(readme)).toBe("Flask is a lightweight WSGI web application framework. It is designed to make getting started quick.");
  });

  it("falls back to the first paragraph when every one sits under a section", () => {
    expect(taglineFromReadme("# tool\n\n## Overview\n\ntool turns YAML into JSON without a runtime.\n\n## Usage\n\nRun it on a file, any file.")).toBe(
      "tool turns YAML into JSON without a runtime.",
    );
    expect(taglineFromReadme("Project\n=======\n\nA reStructuredText project described in one line.\n")).toBe(
      "A reStructuredText project described in one line.",
    );
  });
});

describe("onboard brief", () => {
  it("embeds the repo map under Key files without its own H1", () => {
    const root = repo({ ...FILES, "README.md": "# engine\n\nAn engine that runs things, and harnesses that test it.\n" });
    const { scan, graph } = buildIndexArtifacts(root);
    const { brief } = onboardBrief(scan, graph, { remember: false });
    expect(brief).toContain("\nAn engine that runs things, and harnesses that test it.\n");
    expect(brief).toMatch(/## Key files\n\nsrc\/engine\.ts:\n/);
    expect(brief).not.toContain("# repo map");
  });
});
