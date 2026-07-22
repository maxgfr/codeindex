import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanRepo } from "../src/scan.js";
import { buildResolveContext } from "../src/resolve.js";
import { buildModules } from "../src/modules.js";
import { buildGraph } from "../src/graph.js";
import type { Edge } from "../src/types.js";

// Write a set of {relpath: content} files into a fresh temp repo and return its
// full file-level graph — exercises extraction + resolution end to end.
function graphOf(files: Record<string, string>): Edge[] {
  const root = mkdtempSync(join(tmpdir(), "ui-rl-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const scan = scanRepo(root);
  const ctx = buildResolveContext(scan);
  const { modules, moduleOf } = buildModules(scan);
  return buildGraph(scan, ctx, modules, moduleOf).fileEdges;
}
const imp = (edges: Edge[], from: string, to: string) =>
  edges.some((e) => e.from === from && e.to === to && e.kind === "import" && !e.dangling);
const dangling = (edges: Edge[], from: string, reason: string) =>
  edges.some((e) => e.from === from && e.kind === "import" && e.dangling && e.reason === reason);

describe("new-language import resolution", () => {
  it("C/C++: resolves a local #include and dangles a missing one", () => {
    const edges = graphOf({
      "src/app.c": '#include "util.h"\n#include "nope.h"\nint main(){return 0;}\n',
      "src/util.h": "int helper(void);\n",
    });
    expect(imp(edges, "src/app.c", "src/util.h")).toBe(true);
    expect(dangling(edges, "src/app.c", "missing-include")).toBe(true);
  });

  it("C/C++: resolves an #include against an include/ root", () => {
    const edges = graphOf({
      "lib/foo.c": '#include "shared/types.h"\n',
      "lib/include/shared/types.h": "typedef int T;\n",
    });
    // include root "lib/include" makes "shared/types.h" resolve.
    expect(imp(edges, "lib/foo.c", "lib/include/shared/types.h")).toBe(true);
  });

  it("Ruby: resolves require_relative and a bare require against lib/", () => {
    const edges = graphOf({
      "app.rb": 'require_relative "helpers/format"\nrequire "widget"\n',
      "helpers/format.rb": "def fmt; end\n",
      "lib/widget.rb": "class Widget; end\n",
    });
    expect(imp(edges, "app.rb", "helpers/format.rb")).toBe(true);
    expect(imp(edges, "app.rb", "lib/widget.rb")).toBe(true);
  });

  it("PHP: resolves a PSR-4 use and a relative require", () => {
    const edges = graphOf({
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }),
      "src/Service/Mailer.php": "<?php\nnamespace App\\Service;\nclass Mailer {}\n",
      "public/index.php": "<?php\nuse App\\Service\\Mailer;\nrequire './bootstrap.php';\n",
      "public/bootstrap.php": "<?php\n// boot\n",
    });
    expect(imp(edges, "public/index.php", "src/Service/Mailer.php")).toBe(true);
    expect(imp(edges, "public/index.php", "public/bootstrap.php")).toBe(true);
  });

  it("C#: resolves a using to the file declaring that namespace", () => {
    const edges = graphOf({
      "Services/Mailer.cs": "namespace App.Services;\npublic class Mailer {}\n",
      "Program.cs": "using App.Services;\nclass Program { static void Main() {} }\n",
    });
    expect(imp(edges, "Program.cs", "Services/Mailer.cs")).toBe(true);
  });
});
