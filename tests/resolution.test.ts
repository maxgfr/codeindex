// The resolution report (`codeindex resolution`, MCP `resolution_report`):
// per-language resolved/external/dangling/unsupported accounting, top lists,
// notes for languages the graph cannot be trusted on, and the config warnings
// the resolver used to collect without any surface reading them.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolutionReport } from "../src/resolution.js";
import { scanRepo } from "../src/scan.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-resolution-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const REPO_FILES = {
  // Missing closing brace: the resolver skips it, and nothing used to say so.
  "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["src/*"] } }\n',
  "package.json": JSON.stringify({ name: "demo", workspaces: ["packages/*"] }),
  "packages/bad/package.json": '{"name": "bad",, }',
  "src/a.ts": [
    'import { b } from "./b";',
    'import { gone } from "./gone";',
    'import fp from "lodash/fp";',
    'import get from "lodash/get";',
    'import React from "react";',
    'import { x } from "@scope/pkg/deep";',
    "export const a = b + gone + fp + get + React + x;",
  ].join("\n"),
  "src/b.ts": 'import { gone } from "./gone";\nexport const b = gone;\n',
  "src/c.ts": 'import { gone } from "./gone";\nexport const c = 1;\n',
  "src/Main.kt": "package a\nimport b.Util\nfun main() { Util.x() }\n",
  "docs/guide.md": "# Guide\n\nSee [a](../src/a.ts), [missing](./nope.md), [the sources](../src/) and [site](https://example.com/x).\n",
  "config.json": '{ "k": 1 }\n',
};

describe("resolutionReport", () => {
  const root = scratchRepo(REPO_FILES);
  const report = resolutionReport(scanRepo(root));
  const row = (lang: string) => report.languages.find((l) => l.lang === lang)!;

  it("accounts for every ref of a language as resolved, external, dangling or unsupported", () => {
    const ts = row("typescript");
    expect(ts).toMatchObject({ files: 3, filesWithRefs: 3, refs: 8, resolved: 1, external: 4, dangling: 3, unsupported: 0 });
    expect(ts.danglingByReason).toEqual({ "missing-module": 3 });
    // One spec dangling from three files: counted once per importer, the
    // example is the first importer in path order.
    expect(ts.topDangling).toEqual([{ spec: "./gone", reason: "missing-module", count: 3, example: "src/a.ts" }]);
    // Subpath imports group under their package.
    expect(ts.topExternal).toEqual([
      { name: "lodash", count: 2 },
      { name: "@scope/pkg", count: 1 },
      { name: "react", count: 1 },
    ]);
    expect(ts.note).toMatch(/more imports dangle than resolve/);
    for (const l of report.languages) expect(l.refs).toBe(l.resolved + l.external + l.dangling + l.unsupported);
    expect(report.totals.refs).toBe(report.languages.reduce((n, l) => n + l.refs, 0));
  });

  it("resolves markdown links with the doc-link resolver", () => {
    const md = row("markdown");
    // The URL never becomes a ref; a link to a real directory is external.
    expect(md).toMatchObject({ refs: 3, resolved: 1, external: 1, dangling: 1 });
    expect(md.topExternal).toEqual([{ name: "../src/", count: 1 }]);
    expect(md.topDangling).toEqual([{ spec: "./nope.md", reason: "missing-target", count: 1, example: "docs/guide.md" }]);
  });

  it("says when a code language yields no import edges, and skips config-only languages", () => {
    expect(row("kotlin")).toMatchObject({ files: 1, refs: 0, note: "no imports extracted from 1 file — this language gets no import edges" });
    expect(report.languages.map((l) => l.lang)).not.toContain("json");
  });

  it("surfaces the resolver's and the workspace detector's config warnings", () => {
    // The first entry carries JSON.parse's own reason, worded per Node version.
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings[0]).toMatch(/^malformed packages\/bad\/package\.json: \S/);
    expect(report.warnings.slice(1)).toEqual([
      "unparseable packages/bad/package.json — skipped for workspace resolution",
      "unparseable tsconfig.json — its path aliases were ignored",
    ]);
  });

  it("labels imports from a language with no resolver as unsupported", () => {
    const scan = scanRepo(root);
    scan.files.find((f) => f.rel === "src/Main.kt")!.refs.push({ kind: "import", spec: "b.Util" });
    const kt = resolutionReport(scan, { lang: "kotlin" }).languages;
    expect(kt).toHaveLength(1);
    expect(kt[0]).toMatchObject({ refs: 1, unsupported: 1, external: 0, note: "no import resolver for this language — its 1 import never become edges" });
  });

  it("filters to one language, caps the top lists, and rejects an unknown language", () => {
    const only = resolutionReport(scanRepo(root), { lang: "typescript", limit: 1 });
    expect(only.languages.map((l) => l.lang)).toEqual(["typescript"]);
    expect(only.languages[0]!.topExternal).toEqual([{ name: "lodash", count: 2 }]);
    expect(only.totals.refs).toBe(8);
    expect(() => resolutionReport(scanRepo(root), { lang: "cobol" })).toThrow(/no indexed files in language "cobol" — one of: .*typescript/);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(resolutionReport(scanRepo(root)))).toBe(JSON.stringify(report));
  });
});

describe("CLI surfaces", () => {
  it("`resolution` prints the report; `index` prints the resolver's warnings to stderr", () => {
    const root = scratchRepo(REPO_FILES);
    const res = spawnSync(process.execPath, [CLI, "resolution", "--repo", root, "--lang", "typescript", "--limit", "2"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { languages: { lang: string; topExternal: unknown[] }[]; warnings: string[] };
    expect(out.languages.map((l) => l.lang)).toEqual(["typescript"]);
    expect(out.languages[0]!.topExternal).toHaveLength(2);
    expect(out.warnings).toContain("unparseable tsconfig.json — its path aliases were ignored");

    const idx = spawnSync(process.execPath, [CLI, "index", "--repo", root, "--out", join(root, ".codeindex")], { encoding: "utf8" });
    expect(idx.status).toBe(0);
    expect(idx.stderr).toContain("codeindex: warning: unparseable tsconfig.json — its path aliases were ignored\n");
    expect(idx.stderr).toContain("codeindex: warning: unparseable packages/bad/package.json — skipped for workspace resolution\n");
  });
});
