import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanRepo } from "../src/scan.js";
import { buildResolveContext, resolveImport } from "../src/resolve.js";
import { buildIndexArtifacts } from "../src/pipeline.js";

// Monorepo hardening: package.json `exports` maps, Nx-style root tsconfig.base.json,
// multiple go.mod files with `replace` directives.

const EXPORTS = fileURLToPath(new URL("./fixtures/exports-monorepo", import.meta.url));
const NX = fileURLToPath(new URL("./fixtures/nx-monorepo", import.meta.url));
const MIXED = fileURLToPath(new URL("./fixtures/mixed-monorepo", import.meta.url));
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ui-mono-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("workspace exports maps", () => {
  const ctx = buildResolveContext(scanRepo(EXPORTS));
  it("resolves the bare specifier through a conditional exports map (dist→src remap)", () => {
    expect(resolveImport("packages/app/src/main.ts", ".ts", "@x/lib", ctx)).toEqual({
      kind: "resolved",
      target: "packages/lib/src/index.ts",
    });
  });
  it("resolves an exact subpath export", () => {
    expect(resolveImport("packages/app/src/main.ts", ".ts", "@x/lib/utils", ctx)).toEqual({
      kind: "resolved",
      target: "packages/lib/src/utils.ts",
    });
  });
  it("resolves a wildcard subpath export", () => {
    expect(resolveImport("packages/app/src/main.ts", ".ts", "@x/lib/features/auth", ctx)).toEqual({
      kind: "resolved",
      target: "packages/lib/src/features/auth.ts",
    });
  });
  it("keeps an unmapped subpath external — no false dangling", () => {
    expect(resolveImport("packages/app/src/main.ts", ".ts", "@x/lib/nonexistent", ctx).kind).toBe("external");
  });
  it("keeps third-party imports external", () => {
    expect(resolveImport("packages/app/src/main.ts", ".ts", "react", ctx).kind).toBe("external");
  });

  it("prefers source-ish conditions over `types`", () => {
    const root = scratchRepo({
      "package.json": '{ "name": "root", "private": true }',
      "packages/lib/package.json":
        '{ "name": "@c/lib", "exports": { ".": { "types": "./src/decl.d.ts", "import": "./src/main.ts" } } }',
      "packages/lib/src/main.ts": "export const m = 1;",
      "packages/lib/src/decl.d.ts": "export declare const m: number;",
      "packages/app/use.ts": 'import { m } from "@c/lib";',
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("packages/app/use.ts", ".ts", "@c/lib", c)).toEqual({
      kind: "resolved",
      target: "packages/lib/src/main.ts",
    });
  });

  it("handles the string shorthand form of `exports`", () => {
    const root = scratchRepo({
      "packages/lib/package.json": '{ "name": "@c/str", "exports": "./entry/main.ts" }',
      "packages/lib/entry/main.ts": "export const s = 1;",
      "app.ts": 'import { s } from "@c/str";',
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("app.ts", ".ts", "@c/str", c)).toEqual({
      kind: "resolved",
      target: "packages/lib/entry/main.ts",
    });
  });

  it("resolves a non-conventional entry via the `main` field when `exports` is absent", () => {
    const root = scratchRepo({
      "packages/lib/package.json": '{ "name": "@c/main", "main": "./source/entry.ts" }',
      "packages/lib/source/entry.ts": "export const e = 1;",
      "app.ts": 'import { e } from "@c/main";',
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("app.ts", ".ts", "@c/main", c)).toEqual({
      kind: "resolved",
      target: "packages/lib/source/entry.ts",
    });
  });

  it("falls back to convention probing when the exports map points nowhere real", () => {
    const root = scratchRepo({
      "packages/lib/package.json": '{ "name": "@c/liar", "exports": { ".": "./dist/generated.js" } }',
      "packages/lib/src/index.ts": "export const i = 1;",
      "app.ts": 'import { i } from "@c/liar";',
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("app.ts", ".ts", "@c/liar", c)).toEqual({
      kind: "resolved",
      target: "packages/lib/src/index.ts",
    });
  });
});

describe("Nx-style root tsconfig.base.json", () => {
  const ctx = buildResolveContext(scanRepo(NX));
  it("resolves an @org alias from inside a project that extends the base", () => {
    expect(resolveImport("apps/web/src/main.ts", ".ts", "@org/data", ctx)).toEqual({
      kind: "resolved",
      target: "libs/data/src/index.ts",
    });
    expect(resolveImport("apps/web/src/main.ts", ".ts", "@org/data/models", ctx)).toEqual({
      kind: "resolved",
      target: "libs/data/src/models.ts",
    });
  });
  it("resolves the alias from a root-level file with no enclosing tsconfig.json", () => {
    expect(resolveImport("seed.ts", ".ts", "@org/data", ctx)).toEqual({
      kind: "resolved",
      target: "libs/data/src/index.ts",
    });
  });
  it("still resolves when a root tsconfig.json extends the base (no doubled scope)", () => {
    const root = scratchRepo({
      "tsconfig.base.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@b/*": ["libs/*"] } } }',
      "tsconfig.json": '{ "extends": "./tsconfig.base.json" }',
      "libs/x.ts": "export const x = 1;",
      "main.ts": 'import { x } from "@b/x";',
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("main.ts", ".ts", "@b/x", c)).toEqual({ kind: "resolved", target: "libs/x.ts" });
  });
  it("ignores a NESTED tsconfig.base.json that nothing extends (root-only rule)", () => {
    const root = scratchRepo({
      "pkg/tsconfig.base.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@n/*": ["src/*"] } } }',
      "pkg/src/y.ts": "export const y = 1;",
      "pkg/main.ts": 'import { y } from "@n/y";',
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("pkg/main.ts", ".ts", "@n/y", c).kind).toBe("external");
  });
});

describe("multiple go modules + replace directives", () => {
  const ctx = buildResolveContext(scanRepo(MIXED));
  it("resolves an import rewritten by a replace directive", () => {
    expect(resolveImport("services/api/main.go", ".go", "example.com/shared/util", ctx)).toEqual({
      kind: "resolved",
      target: "shared-go/util/util.go",
    });
  });
  it("resolves an intra-module import in a nested module", () => {
    expect(resolveImport("services/api/main.go", ".go", "example.com/api/internal", ctx)).toEqual({
      kind: "resolved",
      target: "services/api/internal/server.go",
    });
  });
  it("resolves a cross-module import to the other module's source", () => {
    expect(resolveImport("tools/cli/main.go", ".go", "example.com/api/internal", ctx)).toEqual({
      kind: "resolved",
      target: "services/api/internal/server.go",
    });
  });
  it("keeps stdlib imports external", () => {
    expect(resolveImport("services/api/main.go", ".go", "fmt", ctx).kind).toBe("external");
  });

  it("parses the block form of replace and ignores module-path replacements", () => {
    const root = scratchRepo({
      "go.mod": [
        "module example.com/app",
        "",
        "go 1.21",
        "",
        "replace (",
        "\texample.com/local => ./vendor-local",
        "\texample.com/forked => github.com/someone/forked v1.2.3",
        ")",
      ].join("\n"),
      "main.go": 'package main\n\nimport "example.com/local/x"\n',
      "vendor-local/x/x.go": "package x\n",
    });
    const c = buildResolveContext(scanRepo(root));
    expect(resolveImport("main.go", ".go", "example.com/local/x", c)).toEqual({
      kind: "resolved",
      target: "vendor-local/x/x.go",
    });
    // The module-path replacement has no in-repo target — stays external.
    expect(resolveImport("main.go", ".go", "example.com/forked/y", c).kind).toBe("external");
  });

  it("builds the mixed TS+Go+Python repo with zero dangling edges", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "ui-mixed-")), ".ultraindex");
    const { graph } = buildIndexArtifacts(MIXED);
    expect(graph.fileEdges.filter((e) => e.dangling)).toEqual([]);
    // The replace-directive edge is present in the graph, not just resolvable.
    expect(
      graph.fileEdges.some((e) => e.from === "services/api/main.go" && e.to === "shared-go/util/util.go"),
    ).toBe(true);
  });
});
