import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";
import { extractMarkdown } from "../src/extract/markdown.js";
import { extractCode } from "../src/extract/code.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

describe("scanRepo", () => {
  const scan = scanRepo(REPO);
  const byRel = new Map(scan.files.map((f) => [f.rel, f]));

  it("classifies code, docs and config", () => {
    expect(byRel.get("src/client.ts")?.kind).toBe("code");
    expect(byRel.get("README.md")?.kind).toBe("doc");
    expect(byRel.get("docs/guide.md")?.kind).toBe("doc");
    expect(byRel.get("tsconfig.json")?.kind).toBe("config");
    expect(byRel.get("go.mod")?.kind).toBe("config");
  });

  it("extracts a markdown title, summary and local links", () => {
    const readme = byRel.get("README.md")!;
    expect(readme.title).toBe("Mini Repo");
    expect(readme.summary).toContain("polyglot");
    const links = readme.refs.map((r) => r.spec);
    expect(links).toContain("docs/guide.md");
    expect(links).toContain("docs/api.md");
  });

  it("extracts code symbols and import specifiers", () => {
    const client = byRel.get("src/client.ts")!;
    expect(client.symbols.find((s) => s.name === "HttpClient")).toMatchObject({
      kind: "class",
      exported: true,
    });
    const specs = client.refs.map((r) => r.spec);
    expect(specs).toContain("./util.js");
    expect(specs).toContain("@/helpers");
  });

  it("produces a deterministic (sorted) file list and a language histogram", () => {
    const rels = scan.files.map((f) => f.rel);
    expect([...rels]).toEqual([...rels].sort());
    expect(scan.languages.typescript).toBeGreaterThan(0);
    expect(scan.languages.python).toBeGreaterThan(0);
    expect(scan.languages.go).toBeGreaterThan(0);
  });
});

describe("extractMarkdown", () => {
  it("ignores links inside fenced code blocks", () => {
    const md = "# T\n\n```\n[x](./inside.md)\n```\n\n[y](./outside.md)\n";
    const info = extractMarkdown(md);
    const specs = info.refs.map((r) => r.spec);
    expect(specs).toContain("./outside.md");
    expect(specs).not.toContain("./inside.md");
  });
  it("drops external links and anchors", () => {
    const info = extractMarkdown("[a](https://x.com) [b](#frag) [c](./rel.md)");
    const specs = info.refs.map((r) => r.spec);
    expect(specs).toEqual(["./rel.md"]);
  });
});

describe("extractCode", () => {
  it("reads the top doc-comment as a summary", () => {
    const info = extractCode("x.ts", ".ts", "// The widget factory. Builds widgets.\nexport function make() {}");
    expect(info.summary).toBe("The widget factory.");
  });
  it("skips eslint/pragma directive comments", () => {
    const onlyDirective = extractCode("x.ts", ".ts", "/* eslint @typescript-eslint/naming-convention: 0 */\nexport const x = 1;");
    expect(onlyDirective.summary).toBeUndefined();
    const directiveThenProse = extractCode("x.ts", ".ts", "// eslint-disable-next-line\n// Parses the config file.\nexport function p() {}");
    expect(directiveThenProse.summary).toBe("Parses the config file.");
  });
});

describe("extractMarkdown — badges", () => {
  it("does not use a badge/image-only line as the summary", () => {
    const info = extractMarkdown("# Project\n\n[![Quality Status](https://x/badge.svg)](https://x/ci)\n\nThe real description of the project.");
    expect(info.summary).toBe("The real description of the project.");
    expect(info.summary).not.toContain("Quality");
  });
});
