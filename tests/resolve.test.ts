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

describe("resolveImport — Python import roots", () => {
  // src layout, a module named like a stdlib one inside the package, and a
  // 4-line test fixture that happens to be called flask.py (flask's own tree).
  const c = scratchCtx({
    "pyproject.toml": "[project]\nname = \"flask\"\n",
    "src/flask/__init__.py": "from .app import Flask\n",
    "src/flask/app.py": "import typing as t\nfrom .typing import RouteCallable\n",
    "src/flask/typing.py": "RouteCallable = object\n",
    "src/flask/json/__init__.py": "import json\n",
    "tests/test_basic.py": "import flask\nimport cliapp\n",
    "tests/test_apps/cliapp/__init__.py": "",
    "tests/test_apps/cliapp/inner1/__init__.py": "",
    "tests/test_apps/cliapp/inner1/inner2/__init__.py": "",
    "tests/test_apps/cliapp/inner1/inner2/flask.py": "app = None\n",
  });
  it("uses the dirs holding top-level packages as roots, never a package dir itself", () => {
    expect(c.pyRoots).toEqual(["", "src", "tests/test_apps"]);
  });
  it("resolves `import flask` to the src-layout package, not a same-named test fixture", () => {
    expect(resolveImport("tests/test_basic.py", ".py", "flask", c)).toEqual({
      kind: "resolved",
      target: "src/flask/__init__.py",
    });
    expect(resolveImport("src/flask/app.py", ".py", "flask.json", c)).toEqual({
      kind: "resolved",
      target: "src/flask/json/__init__.py",
    });
  });
  it("keeps stdlib imports external even when the package has a same-named module", () => {
    expect(resolveImport("src/flask/app.py", ".py", "typing", c).kind).toBe("external");
    expect(resolveImport("src/flask/json/__init__.py", ".py", "json", c).kind).toBe("external");
    // …while the explicit relative import still binds the package module.
    expect(resolveImport("src/flask/app.py", ".py", ".typing", c)).toEqual({
      kind: "resolved",
      target: "src/flask/typing.py",
    });
  });
  it("reaches a top-level fixture package through its parent root", () => {
    expect(resolveImport("tests/test_basic.py", ".py", "cliapp", c)).toEqual({
      kind: "resolved",
      target: "tests/test_apps/cliapp/__init__.py",
    });
  });
  it("prefers the importer's own project when two projects share a top-level name", () => {
    const m = scratchCtx({
      "a/pyproject.toml": "",
      "a/src/utils/__init__.py": "",
      "a/src/app.py": "import utils\n",
      "b/pyproject.toml": "",
      "b/src/utils/__init__.py": "",
      "b/src/app.py": "import utils\n",
    });
    for (const p of ["a", "b"]) {
      expect(resolveImport(`${p}/src/app.py`, ".py", "utils", m)).toEqual({
        kind: "resolved",
        target: `${p}/src/utils/__init__.py`,
      });
    }
  });
  it("adds no root inside a regular package, even across a namespace gap", () => {
    const m = scratchCtx({
      "pkg/__init__.py": "",
      "pkg/data/sub/__init__.py": "",
      "pkg/data/sub/json/__init__.py": "",
      "pkg/core.py": "import json\n",
    });
    expect(m.pyRoots).toEqual([""]);
    expect(resolveImport("pkg/core.py", ".py", "json", m).kind).toBe("external");
    expect(resolveImport("pkg/core.py", ".py", "pkg.data.sub", m)).toEqual({
      kind: "resolved",
      target: "pkg/data/sub/__init__.py",
    });
  });
});

describe("resolveImport — asset extensions are a JS-family rule only", () => {
  const c = scratchCtx({
    "src/mypkg/__init__.py": "",
    "src/mypkg/map.py": "def mapit(): pass\n",
    "src/mypkg/pdf/__init__.py": "",
    "src/mypkg/core.py": "from .map import mapit\nfrom .pdf import render\n",
    "java/com/acme/core/Map.java": "package com.acme.core;\npublic class Map {}\n",
    "java/com/acme/core/App.java": "package com.acme.core;\nimport com.acme.core.Map;\npublic class App {}\n",
    "cs/Models/Svg.cs": "namespace Acme.Models.Svg;\npublic class Icon {}\n",
    "cs/Program.cs": "using Acme.Models.Svg;\nnamespace Acme;\n",
    "web/main.ts": 'import logo from "./logo.svg";\n',
  });
  it("resolves Python modules named map/pdf", () => {
    expect(resolveImport("src/mypkg/core.py", ".py", ".map", c)).toEqual({
      kind: "resolved",
      target: "src/mypkg/map.py",
    });
    expect(resolveImport("src/mypkg/core.py", ".py", ".pdf", c)).toEqual({
      kind: "resolved",
      target: "src/mypkg/pdf/__init__.py",
    });
  });
  it("resolves a Java class Map and a C# namespace ending in .Svg", () => {
    expect(resolveImport("java/com/acme/core/App.java", ".java", "com.acme.core.Map", c)).toEqual({
      kind: "resolved",
      target: "java/com/acme/core/Map.java",
    });
    expect(resolveImport("cs/Program.cs", ".cs", "Acme.Models.Svg", c)).toEqual({
      kind: "resolved",
      target: "cs/Models/Svg.cs",
    });
  });
  it("still treats a JS asset import as external", () => {
    expect(resolveImport("web/main.ts", ".ts", "./logo.svg", c).kind).toBe("external");
  });
});

describe("resolveImport — tsconfig baseUrl and paths precedence", () => {
  it("resolves a bare name against a baseUrl declared without paths", () => {
    const c = scratchCtx({
      "web/tsconfig.json": '{ "compilerOptions": { "baseUrl": "src" } }',
      "web/src/page.ts": 'import { Card } from "components/Card";',
      "web/src/components/Card.ts": "export const Card = 1;",
    });
    expect(resolveImport("web/src/page.ts", ".ts", "components/Card", c)).toEqual({
      kind: "resolved",
      target: "web/src/components/Card.ts",
    });
    // Only a hit counts: a third-party name stays external, never dangling.
    expect(resolveImport("web/src/page.ts", ".ts", "react", c).kind).toBe("external");
  });
  it("tries baseUrl after a paths pattern that matched and missed", () => {
    const c = scratchCtx({
      "tsconfig.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "lib/*": ["vendor/lib/*"] } } }',
      "src/main.ts": 'import "src/lib/helpers";',
      "src/lib/helpers.ts": "export {};",
      "lib/only-here.ts": "export {};",
    });
    expect(resolveImport("src/main.ts", ".ts", "src/lib/helpers", c)).toEqual({
      kind: "resolved",
      target: "src/lib/helpers.ts",
    });
    expect(resolveImport("src/main.ts", ".ts", "lib/only-here", c)).toEqual({
      kind: "resolved",
      target: "lib/only-here.ts",
    });
  });
  it("gives bare names no base when only paths is declared", () => {
    const c = scratchCtx({
      "tsconfig.json": '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      "src/main.ts": 'import "components/Card";',
      "components/Card.ts": "export {};",
    });
    expect(resolveImport("src/main.ts", ".ts", "components/Card", c).kind).toBe("external");
  });
  it("picks the longest matching prefix, and an exact alias before any pattern", () => {
    const c = scratchCtx({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
            "@/components/*": ["src/ui/components/*"],
            "@/components/Button": ["src/exact/Button"],
          },
        },
      }),
      "src/components/Button.ts": "export {};",
      "src/components/Input.ts": "export {};",
      "src/ui/components/Button.ts": "export {};",
      "src/ui/components/Input.ts": "export {};",
      "src/exact/Button.ts": "export {};",
      "src/main.ts": "export {};",
    });
    expect(resolveImport("src/main.ts", ".ts", "@/components/Input", c)).toEqual({
      kind: "resolved",
      target: "src/ui/components/Input.ts",
    });
    expect(resolveImport("src/main.ts", ".ts", "@/components/Button", c)).toEqual({
      kind: "resolved",
      target: "src/exact/Button.ts",
    });
  });
});

describe("tsconfig extends — workspace packages and ${configDir}", () => {
  it("follows extends into an in-repo workspace package (Turborepo layout)", () => {
    const c = scratchCtx({
      "packages/tsconfig/package.json": '{ "name": "@repo/tsconfig" }',
      "packages/tsconfig/base.json": '{ "compilerOptions": { "paths": { "@shared/*": ["src/lib/*"] } } }',
      "packages/tsconfig/src/lib/helpers.ts": "export const x = 1;",
      "packages/ui/package.json": '{ "name": "@repo/ui", "tsconfig": "./tsconfig.lib.json" }',
      "packages/ui/tsconfig.lib.json": '{ "compilerOptions": { "baseUrl": ".", "paths": { "@ui/*": ["src/*"] } } }',
      "packages/ui/src/button.ts": "export {};",
      "app/tsconfig.json": '{ "extends": "@repo/tsconfig/base.json" }',
      "app/main.ts": 'import { x } from "@shared/helpers";',
      "site/tsconfig.json": '{ "extends": "@repo/ui" }',
      "site/main.ts": 'import "@ui/button";',
    });
    expect(resolveImport("app/main.ts", ".ts", "@shared/helpers", c)).toEqual({
      kind: "resolved",
      target: "packages/tsconfig/src/lib/helpers.ts",
    });
    expect(resolveImport("site/main.ts", ".ts", "@ui/button", c)).toEqual({
      kind: "resolved",
      target: "packages/ui/src/button.ts",
    });
    expect(c.warnings).toEqual([]);
  });
  it("substitutes ${configDir} with the extending config's dir", () => {
    const c = scratchCtx({
      "config/tsconfig.shared.json": '{ "compilerOptions": { "paths": { "~/*": ["${configDir}/src/*"] } } }',
      "apps/web/tsconfig.json": '{ "extends": "../../config/tsconfig.shared.json" }',
      "apps/web/src/lib/a.ts": "export {};",
      "apps/web/src/b.ts": 'import "~/lib/a";',
      "apps/api/tsconfig.json":
        '{ "extends": "../../config/tsconfig.shared.json", "compilerOptions": { "baseUrl": "${configDir}/src" } }',
      "apps/api/src/lib/a.ts": "export {};",
      "apps/api/src/b.ts": 'import "lib/a";',
    });
    expect(resolveImport("apps/web/src/b.ts", ".ts", "~/lib/a", c)).toEqual({
      kind: "resolved",
      target: "apps/web/src/lib/a.ts",
    });
    expect(resolveImport("apps/api/src/b.ts", ".ts", "~/lib/a", c)).toEqual({
      kind: "resolved",
      target: "apps/api/src/lib/a.ts",
    });
    expect(resolveImport("apps/api/src/b.ts", ".ts", "lib/a", c)).toEqual({
      kind: "resolved",
      target: "apps/api/src/lib/a.ts",
    });
  });
});

describe("resolveImport — package.json imports and resource queries", () => {
  const c = scratchCtx({
    "package.json": JSON.stringify({
      name: "app",
      imports: {
        "#internal/*": "./src/lib/*.ts",
        "#config": { node: "./src/lib/config.ts" },
        "#dist": "./dist/entry.js",
      },
    }),
    "src/lib/helpers.ts": "export {};",
    "src/lib/config.ts": "export {};",
    "src/entry.ts": "export {};",
    "src/main.ts": "export {};",
    "src/workers/heavy.ts": "export {};",
    "src/styles/app.css": "a {}",
    "nested/package.json": '{ "name": "nested" }',
    "nested/index.ts": 'import "#config";',
  });
  it("resolves #subpath imports through the nearest package.json", () => {
    expect(resolveImport("src/main.ts", ".ts", "#internal/helpers", c)).toEqual({
      kind: "resolved",
      target: "src/lib/helpers.ts",
    });
    expect(resolveImport("src/main.ts", ".ts", "#config", c)).toEqual({
      kind: "resolved",
      target: "src/lib/config.ts",
    });
    expect(resolveImport("src/main.ts", ".ts", "#dist", c)).toEqual({ kind: "resolved", target: "src/entry.ts" });
    expect(resolveImport("src/main.ts", ".ts", "#nope", c).kind).toBe("external");
    // Node never looks past the nearest package.json, which declares no imports.
    expect(resolveImport("nested/index.ts", ".ts", "#config", c).kind).toBe("external");
  });
  it("strips a bundler resource query before probing, keeping missing files dangling", () => {
    expect(resolveImport("src/main.ts", ".ts", "./workers/heavy.ts?worker", c)).toEqual({
      kind: "resolved",
      target: "src/workers/heavy.ts",
    });
    expect(resolveImport("src/main.ts", ".ts", "./styles/app.css?inline", c)).toEqual({
      kind: "resolved",
      target: "src/styles/app.css",
    });
    expect(resolveImport("src/main.ts", ".ts", "./workers/gone.ts?worker", c)).toEqual({
      kind: "dangling",
      reason: "missing-module",
    });
  });
});

describe("resolveImport — Go package representative", () => {
  const c = scratchCtx({
    "go.mod": "module example.com/svc\n",
    "pkg/x/api_test.go": "package x\n",
    "pkg/x/handler.go": "package x\n",
    "pkg/x/x.go": "package x\n",
    "pkg/onlytests/a_test.go": "package onlytests\n",
    "main.go": "package main\n",
  });
  it("never picks a _test.go file when the package has other files", () => {
    expect(resolveImport("main.go", ".go", "example.com/svc/pkg/x", c)).toEqual({
      kind: "resolved",
      target: "pkg/x/handler.go",
    });
  });
  it("falls back to a test file for a test-only directory", () => {
    expect(resolveImport("main.go", ".go", "example.com/svc/pkg/onlytests", c)).toEqual({
      kind: "resolved",
      target: "pkg/onlytests/a_test.go",
    });
  });
});

describe("resolveDocLink — repo-root-relative links", () => {
  const c = scratchCtx({
    "README.md": "[bench](/BENCHMARKS.md)\n",
    "BENCHMARKS.md": "# bench\n",
    "docs/doc.md": "[home](/README.md) [gone](/NOPE.md) [root](/)\n",
  });
  it("resolves a leading-slash link against the repo root", () => {
    expect(resolveDocLink("README.md", "/BENCHMARKS.md", c)).toEqual({ kind: "resolved", target: "BENCHMARKS.md" });
    expect(resolveDocLink("docs/doc.md", "/README.md", c)).toEqual({ kind: "resolved", target: "README.md" });
    expect(resolveDocLink("docs/doc.md", "/", c)).toEqual({ kind: "resolved", target: "README.md" });
  });
  it("still flags a missing root-relative target as dangling", () => {
    expect(resolveDocLink("docs/doc.md", "/NOPE.md", c)).toEqual({ kind: "dangling", reason: "missing-target" });
  });
});
