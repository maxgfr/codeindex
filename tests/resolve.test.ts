import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";
import {
  buildResolveContext,
  resolveDocLink,
  resolveImport,
  type ResolveContext,
} from "../src/resolve.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

function ctx(): ResolveContext {
  return buildResolveContext(scanRepo(REPO));
}

describe("resolveDocLink", () => {
  const c = ctx();
  it("resolves a relative markdown link to a real file", () => {
    expect(resolveDocLink("README.md", "docs/guide.md", c)).toEqual({
      kind: "resolved",
      target: "docs/guide.md",
    });
  });
  it("resolves a parent-relative link", () => {
    expect(resolveDocLink("docs/guide.md", "../README.md", c)).toEqual({
      kind: "resolved",
      target: "README.md",
    });
  });
  it("flags a broken link as dangling, without throwing", () => {
    expect(resolveDocLink("docs/guide.md", "./missing.md", c)).toEqual({
      kind: "dangling",
      reason: "missing-target",
    });
  });
  it("treats URLs and pure anchors as external (no edge)", () => {
    expect(resolveDocLink("README.md", "https://example.com", c).kind).toBe("external");
    expect(resolveDocLink("README.md", "#section", c).kind).toBe("external");
  });
});

describe("resolveImport — JS/TS", () => {
  const c = ctx();
  it("resolves a relative .js specifier to its .ts source", () => {
    expect(resolveImport("src/client.ts", ".ts", "./util.js", c)).toEqual({
      kind: "resolved",
      target: "src/util.ts",
    });
  });
  it("resolves a tsconfig path alias", () => {
    expect(resolveImport("src/client.ts", ".ts", "@/helpers", c)).toEqual({
      kind: "resolved",
      target: "src/helpers.ts",
    });
  });
  it("treats a bare third-party specifier as external", () => {
    expect(resolveImport("src/client.ts", ".ts", "react", c).kind).toBe("external");
  });
  it("flags a missing relative import as dangling", () => {
    expect(resolveImport("src/client.ts", ".ts", "./nope.js", c)).toEqual({
      kind: "dangling",
      reason: "missing-module",
    });
  });
  it("treats an asset import (.svg) as external, never dangling", () => {
    expect(resolveImport("src/client.ts", ".ts", "../logo.svg", c).kind).toBe("external");
    expect(resolveImport("src/client.ts", ".ts", "./icon.png", c).kind).toBe("external");
  });
});

describe("resolveDocLink — directories", () => {
  const c = ctx();
  it("treats a link to a real directory (no README) as external, not dangling", () => {
    expect(resolveDocLink("README.md", "gopkg", c).kind).toBe("external");
    expect(resolveDocLink("README.md", "./gopkg/sub", c).kind).toBe("external");
  });
});

describe("resolveImport — Python", () => {
  const c = ctx();
  it("resolves a relative import", () => {
    expect(resolveImport("pkg/core.py", ".py", ".util", c)).toEqual({
      kind: "resolved",
      target: "pkg/util.py",
    });
  });
  it("resolves a same-package absolute import", () => {
    expect(resolveImport("pkg/core.py", ".py", "pkg.util", c)).toEqual({
      kind: "resolved",
      target: "pkg/util.py",
    });
  });
  it("treats an unknown absolute import as external (likely third-party)", () => {
    expect(resolveImport("pkg/core.py", ".py", "requests", c).kind).toBe("external");
  });
});

describe("resolveImport — Go", () => {
  const c = ctx();
  it("resolves an intra-module import to a representative file", () => {
    expect(resolveImport("gopkg/main.go", ".go", "example.com/mini/gopkg/sub", c)).toEqual({
      kind: "resolved",
      target: "gopkg/sub/sub.go",
    });
  });
  it("treats a stdlib import as external", () => {
    expect(resolveImport("gopkg/main.go", ".go", "fmt", c).kind).toBe("external");
  });
});
