import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

// Write {relpath: content} into a fresh temp repo and build its resolve context
// — for cases the pinned mini-repo fixture must not grow (compat.test.ts pins
// its output bytes).
function scratchCtx(files: Record<string, string>): ResolveContext {
  const root = mkdtempSync(join(tmpdir(), "ci-resolve-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return buildResolveContext(scanRepo(root));
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

describe("resolveImport — SFC/HTML candidates", () => {
  it("resolves an extensionless relative import to a .vue file", () => {
    const c = scratchCtx({
      "src/main.ts": 'import Widget from "./Widget";',
      "src/Widget.vue": "<template><div /></template>",
    });
    expect(resolveImport("src/main.ts", ".ts", "./Widget", c)).toEqual({
      kind: "resolved",
      target: "src/Widget.vue",
    });
  });
  it("resolves a tsconfig path alias to a .svelte target", () => {
    const c = scratchCtx({
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      "src/main.ts": 'import App from "@/App";',
      "src/App.svelte": "<h1>hi</h1>",
    });
    expect(resolveImport("src/main.ts", ".ts", "@/App", c)).toEqual({
      kind: "resolved",
      target: "src/App.svelte",
    });
  });
  it("keeps JS-family candidates ahead of SFC ones (.ts wins over .vue)", () => {
    const c = scratchCtx({
      "src/main.ts": 'import x from "./x";',
      "src/x.ts": "export default 1;",
      "src/x.vue": "<template />",
    });
    expect(resolveImport("src/main.ts", ".ts", "./x", c)).toEqual({
      kind: "resolved",
      target: "src/x.ts",
    });
  });
  it("keeps the deliberate .ts-before-.tsx order", () => {
    const c = scratchCtx({
      "src/main.ts": 'import y from "./y";',
      "src/y.ts": "export default 1;",
      "src/y.tsx": "export default 2;",
    });
    expect(resolveImport("src/main.ts", ".ts", "./y", c)).toEqual({
      kind: "resolved",
      target: "src/y.ts",
    });
  });
});

describe("resolveImport — SFC/HTML importers", () => {
  it("a .vue importer resolves a relative .ts import through the JS path", () => {
    const c = scratchCtx({
      "src/App.vue": '<script>import { u } from "./util";</script>',
      "src/util.ts": "export const u = 1;",
    });
    expect(resolveImport("src/App.vue", ".vue", "./util", c)).toEqual({
      kind: "resolved",
      target: "src/util.ts",
    });
  });
  it("a .svelte importer resolves a tsconfig alias", () => {
    const c = scratchCtx({
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      "src/Page.svelte": '<script>import { h } from "@/helpers";</script>',
      "src/helpers.ts": "export const h = 1;",
    });
    expect(resolveImport("src/Page.svelte", ".svelte", "@/helpers", c)).toEqual({
      kind: "resolved",
      target: "src/helpers.ts",
    });
  });
  it("an .html importer resolves a relative script import, and dangles a missing one", () => {
    const c = scratchCtx({
      "index.html": '<script type="module" src="./app.js"></script>',
      "app.ts": "export {};",
    });
    expect(resolveImport("index.html", ".html", "./app.js", c)).toEqual({
      kind: "resolved",
      target: "app.ts",
    });
    expect(resolveImport("index.html", ".html", "./nope.js", c)).toEqual({
      kind: "dangling",
      reason: "missing-module",
    });
  });
  it("a .vue importer keeps bare third-party specifiers external", () => {
    const c = scratchCtx({ "src/App.vue": '<script>import { ref } from "vue";</script>' });
    expect(resolveImport("src/App.vue", ".vue", "vue", c).kind).toBe("external");
  });
});

describe("tsconfig extends — bare in-repo target", () => {
  it("resolves extends \"base.json\" (no ./ prefix) against the config's dir, aliases included", () => {
    const c = scratchCtx({
      "web/base.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@w/*": ["src/*"] } } }',
      "web/tsconfig.json": '{ "extends": "base.json" }',
      "web/src/lib.ts": "export const l = 1;",
      "web/main.ts": 'import { l } from "@w/lib";',
    });
    expect(resolveImport("web/main.ts", ".ts", "@w/lib", c)).toEqual({
      kind: "resolved",
      target: "web/src/lib.ts",
    });
    expect(c.warnings).toEqual([]);
  });
  it("still treats a package extends (@tsconfig/node18) as external — no warning, own paths kept", () => {
    const c = scratchCtx({
      "tsconfig.json":
        '{ "extends": "@tsconfig/node18/tsconfig.json", "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      "src/thing.ts": "export const t = 1;",
      "src/main.ts": 'import { t } from "@/thing";',
    });
    expect(resolveImport("src/main.ts", ".ts", "@/thing", c)).toEqual({
      kind: "resolved",
      target: "src/thing.ts",
    });
    expect(c.warnings).toEqual([]);
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
