// Regression tests for GitHub issues #2 (detectWorkspaces gaps), #6
// (reconstruct-migration gaps: categorize asset set, .astro, workspace
// naming/nx/go.work/warnings, walk excluded-count) and #11 (regex tier
// capturing "extends" as an anonymous default class's name). Issue #3 (grep
// negation globs) lives in review-fixes.test.ts next to the other grep-parity
// suites.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectWorkspaces } from "../src/workspaces.js";
import { categorize } from "../src/categorize.js";
import { extToLang } from "../src/lang/common.js";
import { jsTs } from "../src/lang/js-ts.js";
import { walk } from "../src/walk.js";
import { scanRepo } from "../src/scan.js";

function scratchRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-issues-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

describe("issue #2: uv workspaces", () => {
  it("detects [tool.uv.workspace] members with excludes, names and descriptions from pyproject", () => {
    const root = scratchRepo({
      "pyproject.toml": [
        "[project]",
        'name = "root"',
        "",
        "[tool.uv.workspace]",
        'members = ["packages/*"]',
        'exclude = ["packages/legacy"]',
      ].join("\n"),
      "packages/api/pyproject.toml": [
        "[project]",
        'name = "api-server"',
        'description = "The HTTP API"',
        'dependencies = ["core-lib>=0.1"]',
        "",
        "[tool.uv.sources]",
        "core-lib = { workspace = true }",
      ].join("\n"),
      "packages/core/pyproject.toml": '[project]\nname = "core-lib"\n',
      "packages/legacy/pyproject.toml": '[project]\nname = "legacy"\n',
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => `${p.kind}:${p.name}`)).toEqual(["uv:api-server", "uv:core-lib"]);
    const api = info.packages.find((p) => p.name === "api-server")!;
    expect(api.dir).toBe("packages/api");
    expect(api.manifest).toBe("packages/api/pyproject.toml");
    expect(api.description).toBe("The HTTP API");
    expect(api.dependsOn).toEqual(["core-lib"]);
    expect(info.topoOrder).toEqual(["core-lib", "api-server"]);
    expect(info.warnings).toEqual([]);
  });
});

describe("issue #2: Composer path repositories", () => {
  it("expands path-repository globs and reads composer.json names, descriptions and require edges", () => {
    const root = scratchRepo({
      "composer.json": JSON.stringify({
        name: "acme/root",
        repositories: [{ type: "path", url: "packages/*" }, { type: "vcs", url: "https://example.com/x.git" }],
      }),
      "packages/lib/composer.json": JSON.stringify({ name: "acme/lib", description: "Shared lib" }),
      "packages/app/composer.json": JSON.stringify({ name: "acme/app", require: { "acme/lib": "*", "php": ">=8.1" } }),
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => `${p.kind}:${p.name}`)).toEqual(["composer:acme/app", "composer:acme/lib"]);
    expect(info.packages.find((p) => p.name === "acme/lib")!.description).toBe("Shared lib");
    expect(info.packages.find((p) => p.name === "acme/app")!.dependsOn).toEqual(["acme/lib"]);
    expect(info.topoOrder).toEqual(["acme/lib", "acme/app"]);
  });
});

describe("issue #2: Gradle settings includes", () => {
  it("maps `include ':a', ':b:c'` project paths to member dirs with project() edges", () => {
    const root = scratchRepo({
      "settings.gradle": "rootProject.name = 'demo'\ninclude ':app', ':libs:core'\n",
      "app/build.gradle": "dependencies {\n  implementation project(':libs:core')\n}\n",
      "libs/core/build.gradle.kts": "plugins { `java-library` }\n",
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => `${p.kind}:${p.name}`)).toEqual(["gradle:app", "gradle:libs/core"]);
    expect(info.packages.find((p) => p.name === "app")!.manifest).toBe("app/build.gradle");
    expect(info.packages.find((p) => p.name === "libs/core")!.manifest).toBe("libs/core/build.gradle.kts");
    expect(info.packages.find((p) => p.name === "app")!.dependsOn).toEqual(["libs/core"]);
    expect(info.topoOrder).toEqual(["libs/core", "app"]);
  });

  it("reads the Kotlin-DSL include(\"x\") form from settings.gradle.kts", () => {
    const root = scratchRepo({
      "settings.gradle.kts": 'include("web")\n',
      "web/build.gradle.kts": "plugins { application }\n",
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => `${p.kind}:${p.name}`)).toEqual(["gradle:web"]);
  });
});

describe("issue #2: glob patterns", () => {
  it("expands nested wildcard patterns (packages/*/plugins/*) at arbitrary depth", () => {
    const root = scratchRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*/plugins/*"] }),
      "packages/one/plugins/alpha/package.json": JSON.stringify({ name: "alpha" }),
      "packages/two/plugins/beta/package.json": JSON.stringify({ name: "beta" }),
      "packages/one/package.json": JSON.stringify({ name: "one" }), // NOT a member
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(info.packages.map((p) => p.dir)).toEqual([
      "packages/one/plugins/alpha",
      "packages/two/plugins/beta",
    ]);
  });

  it("expands partial wildcard segments (libs-*)", () => {
    const root = scratchRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["libs-*"] }),
      "libs-a/package.json": JSON.stringify({ name: "a" }),
      "libs-b/package.json": JSON.stringify({ name: "b" }),
      "other/package.json": JSON.stringify({ name: "nope" }),
    });
    const info = detectWorkspaces(root);
    expect(info.packages.map((p) => p.name)).toEqual(["a", "b"]);
  });
});

describe("issue #2/#6: naming, nx, go.work, warnings", () => {
  it("names a nameless manifest by its FULL dir path, not the basename", () => {
    const root = scratchRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*/utils"] }),
      "packages/a/utils/package.json": "{}",
      "packages/b/utils/package.json": "{}",
    });
    const names = detectWorkspaces(root).packages.map((p) => p.name);
    // Basename naming would collide both on "utils".
    expect(names).toEqual(["packages/a/utils", "packages/b/utils"]);
  });

  it("detects nx members that have only a project.json", () => {
    const root = scratchRepo({
      "nx.json": JSON.stringify({}),
      "apps/web/project.json": JSON.stringify({ name: "web-app" }),
      "libs/data/project.json": JSON.stringify({ name: "data-lib" }),
    });
    const info = detectWorkspaces(root);
    // Sorted by dir: apps/web before libs/data.
    expect(info.packages.map((p) => `${p.kind}:${p.name}`)).toEqual(["nx:web-app", "nx:data-lib"]);
    expect(info.packages.find((p) => p.name === "web-app")!.manifest).toBe("apps/web/project.json");
  });

  it("names a go.work member from go.mod even when a package.json coexists", () => {
    const root = scratchRepo({
      "go.work": "go 1.22\n\nuse ./svc\n",
      "svc/go.mod": "module example.com/svc\n\ngo 1.22\n",
      "svc/package.json": JSON.stringify({ name: "svc-tooling" }),
    });
    const info = detectWorkspaces(root);
    expect(info.packages).toHaveLength(1);
    expect(info.packages[0]).toMatchObject({
      name: "example.com/svc",
      kind: "go",
      manifest: "svc/go.mod",
    });
  });

  it("collects warnings for malformed manifests instead of silently skipping the member", () => {
    const root = scratchRepo({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/good/package.json": JSON.stringify({ name: "good", description: "A fine package" }),
      "packages/bad/package.json": "{ not json at all",
    });
    const info = detectWorkspaces(root);
    // The malformed member is still registered, named by its full dir path.
    expect(info.packages.map((p) => p.name)).toEqual(["packages/bad", "good"]);
    expect(info.warnings.length).toBeGreaterThan(0);
    expect(info.warnings.every((w) => w.startsWith("malformed packages/bad/package.json:"))).toBe(true);
    expect(info.packages.find((p) => p.name === "good")!.description).toBe("A fine package");
  });
});

describe("issue #6: categorize archive/executable extensions", () => {
  it.each([
    ".zip", ".gz", ".tar", ".rar", ".7z", ".wasm", ".so", ".dylib", ".dll", ".exe", ".bin",
    ".class", ".jar", ".pyc", ".node",
  ])("blob%s -> asset", (ext) => {
    expect(categorize(`vendor-blobs/blob${ext}`, ext)).toBe("asset");
  });

  it("keeps .svg as asset (engine view; reconstruct overrides to `other` locally)", () => {
    expect(categorize("logo.svg", ".svg")).toBe("asset");
  });

  it("categorizes .astro as code and labels the language", () => {
    expect(categorize("src/pages/index.astro", ".astro")).toBe("code");
    expect(extToLang(".astro")).toBe("astro");
  });

  it("counts .astro files under the astro language in a scan", () => {
    const root = scratchRepo({ "src/index.astro": "---\nconst t = 1;\n---\n<h1>{t}</h1>\n" });
    expect(scanRepo(root).languages).toMatchObject({ astro: 1 });
  });
});

describe("issue #6: walk/scan excluded count", () => {
  it("counts files seen and rejected by size/lockfile/binary/minified/gitignore — never ignored dirs", () => {
    const root = scratchRepo({
      ".gitignore": "secret.txt\n",
      "ok.ts": "export const ok = 1;\n",
      "big.ts": "x".repeat(500),
      "yarn.lock": "lockfile-noise\n",
      "logo.png": "not-really-a-png\n",
      "app.min.js": "minified\n",
      "secret.txt": "gitignored\n",
      // Ignored DIRS: their files must not count — they were never seen.
      "node_modules/dep/index.js": "module.exports = 1;\n",
      "dist/out.js": "bundled\n",
    });
    const r = walk(root, { maxFileBytes: 200 });
    expect(r.files.map((f) => f.rel)).toEqual([".gitignore", "ok.ts"]);
    expect(r.excluded).toBe(5); // big.ts, yarn.lock, logo.png, app.min.js, secret.txt
    expect(r.capped).toBe(false);

    // RepoScan surfaces the walk's count (additive — not part of graph.json).
    expect(scanRepo(root, { maxBytes: 200 }).excluded).toBe(5);
  });

  it("stays zero on a clean tree", () => {
    const root = scratchRepo({ "a.ts": "export {};\n" });
    expect(walk(root).excluded).toBe(0);
  });
});

describe("issue #11: export default class extends Base", () => {
  it("emits only the file-stem default symbol, never a class named `extends`", () => {
    const syms = jsTs.extract("base.ts", "export default class extends Base {}\n");
    expect(syms).toContainEqual(
      expect.objectContaining({ name: "base", kind: "default", line: 1, exported: true }),
    );
    expect(syms.some((s) => s.name === "extends")).toBe(false);
  });

  it("still captures the class name of a NAMED default class that extends", () => {
    const syms = jsTs.extract("sub.ts", "export default class Sub extends Base {}\n");
    expect(syms).toContainEqual(
      expect.objectContaining({ name: "Sub", kind: "class", exported: true }),
    );
    expect(syms.some((s) => s.kind === "default")).toBe(false);
  });
});
