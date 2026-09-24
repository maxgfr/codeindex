// Workspace detection gaps (pnpm flow lists, multi-line Gradle includes and
// type-safe accessors, nested Maven aggregators, go.work-less multi-module Go
// repos), JSONC manifests, surfaced warnings, and the declared-vs-imported
// dependency check (`workspaces --check`).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkWorkspaceDeps, detectWorkspaces, workspaceReport } from "../src/workspaces.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import type { Edge } from "../src/types.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-ws-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

const summary = (root: string): string[] =>
  detectWorkspaces(root).packages.map((p) => `${p.kind}:${p.name}${p.dependsOn ? ` -> ${p.dependsOn.join(",")}` : ""}`);

describe("pnpm-workspace.yaml sequence styles", () => {
  const members = {
    "packages/a/package.json": JSON.stringify({ name: "a" }),
    "tools/t/package.json": JSON.stringify({ name: "t" }),
    "tools/skip/package.json": JSON.stringify({ name: "skip" }),
  };

  it("reads a one-line flow list, quotes and negations included", () => {
    const root = scratchRepo({ ...members, "pnpm-workspace.yaml": `packages: ["packages/*", 'tools/*', "!tools/skip"] # flow\n` });
    expect(summary(root)).toEqual(["pnpm:a", "pnpm:t"]);
  });

  it("reads a flow list spanning lines", () => {
    const root = scratchRepo({ ...members, "pnpm-workspace.yaml": 'packages: [\n  "packages/*",  # libs\n  "tools/t"\n]\ncatalog:\n  x: 1\n' });
    expect(summary(root)).toEqual(["pnpm:a", "pnpm:t"]);
  });

  it("reads block entries at the key's own column, and stops at the next key", () => {
    const root = scratchRepo({ ...members, "pnpm-workspace.yaml": "packages:\n- 'packages/*'\n\n- tools/t # the cli\nonlyBuiltDependencies:\n  - tools/skip\n" });
    expect(summary(root)).toEqual(["pnpm:a", "pnpm:t"]);
  });
});

describe("Gradle settings includes", () => {
  it("collects every project of a multi-line include(...) and type-safe accessor edges", () => {
    const root = scratchRepo({
      "settings.gradle.kts": 'rootProject.name = "demo"\ninclude(\n  ":libs:core",\n  ":app", // the app\n)\ninclude(":platform:api")\n/* include(":old") */\nincludeBuild("build-logic")\n',
      "libs/core/build.gradle.kts": "plugins { `java-library` }\n",
      "platform/api/build.gradle.kts": "dependencies { api(projects.libs.core) }\n",
      "app/build.gradle.kts": "dependencies {\n  implementation(project(path = \":libs:core\"))\n  implementation(projects.platform.api)\n}\n",
      "old/build.gradle.kts": "",
      "build-logic/build.gradle.kts": "",
    });
    expect(summary(root)).toEqual(["gradle:app -> libs/core,platform/api", "gradle:libs/core", "gradle:platform/api -> libs/core"]);
    expect(detectWorkspaces(root).topoOrder).toEqual(["libs/core", "platform/api", "app"]);
  });

  it("continues a Groovy include after a trailing comma and camelCases accessor segments", () => {
    const root = scratchRepo({
      "settings.gradle": "include ':app',\n        ':shared-utils'\n",
      "shared-utils/build.gradle": "",
      "app/build.gradle": "dependencies { implementation projects.sharedUtils }\n",
    });
    expect(summary(root)).toEqual(["gradle:app -> shared-utils", "gradle:shared-utils"]);
  });
});

describe("Maven reactor modules", () => {
  it("recurses into nested aggregators, relative to the pom that lists them", () => {
    const root = scratchRepo({
      "pom.xml": "<project><artifactId>root</artifactId><modules><module>parent</module><module>svc</module><!-- <module>gone</module> --></modules></project>",
      "parent/pom.xml": "<project><artifactId>parent-agg</artifactId><modules><module>child-a</module><module>../libs/child-b/pom.xml</module></modules></project>",
      "parent/child-a/pom.xml": "<project><artifactId>child-a</artifactId></project>",
      "libs/child-b/pom.xml": "<project><artifactId>child-b</artifactId></project>",
      "gone/pom.xml": "<project><artifactId>gone</artifactId></project>",
      "svc/pom.xml":
        "<project><artifactId>svc</artifactId><dependencies><dependency><artifactId>child-b</artifactId></dependency></dependencies></project>",
    });
    expect(summary(root)).toEqual(["maven:child-b", "maven:parent-agg", "maven:child-a", "maven:svc -> child-b"]);
    expect(detectWorkspaces(root).topoOrder).toEqual(["child-a", "child-b", "parent-agg", "svc"]);
  });
});

describe("Go modules without go.work", () => {
  it("lists every nested go.mod as a module, with replace edges", () => {
    const info = detectWorkspaces(join(FIXTURES, "mixed-monorepo"));
    expect(info.packages.map((p) => `${p.dir}=${p.name}`)).toEqual([
      "services/api=example.com/api",
      "shared-go=example.com/shared",
      "tools/cli=example.com/cli",
    ]);
    expect(info.packages[0]!.dependsOn).toEqual(["example.com/shared"]);
    expect(info.topoOrder.indexOf("example.com/shared")).toBeLessThan(info.topoOrder.indexOf("example.com/api"));
  });

  it("skips vendor, testdata, fixtures and _-prefixed dirs, and the root module itself", () => {
    const root = scratchRepo({
      "go.mod": "module example.com/root\n",
      "svc/go.mod": "module example.com/svc\n",
      "vendor/x/go.mod": "module example.com/vendored\n",
      "svc/testdata/go.mod": "module example.com/td\n",
      "tests/fixtures/repo/go.mod": "module example.com/fixture\n",
      "_scratch/go.mod": "module example.com/scratch\n",
    });
    expect(summary(root)).toEqual(["go:example.com/svc"]);
  });

  it("leaves module discovery to go.work when there is one", () => {
    const root = scratchRepo({
      "go.work": "go 1.22\n\nuse ./a\n",
      "a/go.mod": "module example.com/a\n",
      "b/go.mod": "module example.com/b\n",
    });
    expect(summary(root)).toEqual(["go:example.com/a"]);
  });
});

describe("manifest parsing and warnings", () => {
  it("accepts JSONC manifests like the resolver does, and still names a broken one", () => {
    const root = scratchRepo({
      "package.json": '{\n  // monorepo root\n  "name": "root",\n  "workspaces": ["packages/*"],\n}\n',
      "packages/good/package.json": '{ "name": "good", /* ok */ "dependencies": { "bad": "*", }, }',
      "packages/bad/package.json": '{"name": "bad",, }',
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => p.name)).toEqual(["packages/bad", "good"]);
    expect(info.warnings).toHaveLength(1);
    expect(info.warnings[0]).toMatch(/^malformed packages\/bad\/package\.json: /);
    // The report carries warnings only when there are some, so a clean
    // workspace prints the same bytes it always did.
    expect(workspaceReport(info).warnings).toEqual(info.warnings);
    expect(Object.keys(workspaceReport(detectWorkspaces(join(FIXTURES, "mini-monorepo"))))).toEqual(["packages", "cycle", "topoOrder"]);
  });
});

describe("checkWorkspaceDeps", () => {
  const edge = (from: string, to: string, kind = "import", dangling?: boolean): Edge => ({ from, to, kind, weight: 1, ...(dangling ? { dangling } : {}) }) as Edge;

  it("flags an import of a sibling the manifest does not declare (mini-monorepo)", () => {
    const root = join(FIXTURES, "mini-monorepo");
    const { graph } = buildIndexArtifacts(root);
    const check = checkWorkspaceDeps(detectWorkspaces(root), graph);
    expect(check).toEqual({
      ok: false,
      undeclared: [{ from: "@scope/b", to: "@scope/a", files: 1, example: "packages/b/src/consumer.ts" }],
      unusedDeclared: [],
    });
  });

  it("passes declared imports, reports unused declarations, ignores non-import and intra-package edges", () => {
    const root = scratchRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/b/package.json": JSON.stringify({ name: "b", dependencies: { a: "*", c: "*" } }),
      "packages/c/package.json": JSON.stringify({ name: "c" }),
    });
    const info = detectWorkspaces(root);
    const check = checkWorkspaceDeps(info, {
      fileEdges: [
        edge("packages/b/src/x.ts", "packages/a/src/index.ts"),
        edge("packages/b/src/y.ts", "packages/b/src/x.ts"),
        edge("packages/c/src/z.ts", "packages/a/src/index.ts", "call"), // not an import
        edge("packages/c/src/z.ts", "packages/a/nope", "import", true), // dangling
        edge("scripts/tool.ts", "packages/a/src/index.ts"), // outside every package
        edge("packages/a/src/index.ts", "packages/c/src/z.ts"),
        edge("packages/a/test/t.ts", "packages/c/src/z.ts"),
      ],
    });
    expect(check).toEqual({
      ok: false,
      undeclared: [{ from: "a", to: "c", files: 2, example: "packages/a/src/index.ts" }],
      unusedDeclared: [{ from: "b", to: "c" }],
    });
  });

  it("leaves nx members out: nx infers project dependencies from imports", () => {
    const root = scratchRepo({
      "nx.json": "{}",
      "apps/web/project.json": JSON.stringify({ name: "web" }),
      "libs/ui/project.json": JSON.stringify({ name: "ui" }),
    });
    const check = checkWorkspaceDeps(detectWorkspaces(root), { fileEdges: [edge("apps/web/main.ts", "libs/ui/index.ts")] });
    expect(check).toEqual({ ok: true, undeclared: [], unusedDeclared: [] });
  });

  it("CLI: `workspaces --check` prints the check and exits 1 on an undeclared import", () => {
    const res = spawnSync(process.execPath, [CLI, "workspaces", "--check", "--no-index-cache", "--repo", join(FIXTURES, "mini-monorepo")], {
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as { check: { ok: boolean; undeclared: { from: string; to: string }[] } };
    expect(out.check.ok).toBe(false);
    expect(out.check.undeclared.map((u) => `${u.from}->${u.to}`)).toEqual(["@scope/b->@scope/a"]);

    // Without --check: exit 0, no graph work, no `check` key.
    const plain = spawnSync(process.execPath, [CLI, "workspaces", "--repo", join(FIXTURES, "mini-monorepo")], { encoding: "utf8" });
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout).check).toBeUndefined();
  });
});
