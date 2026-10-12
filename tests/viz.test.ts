import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mermaidLabel, renderMermaid, renderMermaidClustered } from "../src/viz.js";
import { renderScip } from "../src/render/scip.js";
import { scanRepo } from "../src/scan.js";
import { decodeScip, mermaidProblems } from "./oracles/real-world.js";
import type { Graph, ModuleNode } from "../src/types.js";

// What the renderers emit must survive the names a repository can hold.

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

function graphWith(paths: string[]): Graph {
  const modules = paths.map(
    (path, i) => ({ id: `m${i}`, kind: "module", slug: `m${i}`, path, title: path, summary: "", tier: 1, members: [], symbols: 0, degIn: 1, degOut: 1 }) as unknown as ModuleNode,
  );
  const moduleEdges = paths.slice(1).map((_, i) => ({ from: `m${i}`, to: `m${i + 1}`, kind: "import" as const, weight: 2 }));
  return { schemaVersion: 1, version: "t", fileCount: 0, languages: {}, files: [], modules, fileEdges: [], moduleEdges } as Graph;
}

const HOSTILE = ['<img src=x onerror=alert(1)>', 'say "hi"', "two\nlines", "fence ```here", "issue #12 & co"];

describe("Mermaid labels", () => {
  it("escape HTML, quotes, fences and line breaks", () => {
    expect(mermaidLabel('<b>"x"</b> #1 `y` a&b\nz')).toBe("#lt;b#gt;#quot;x#quot;#lt;/b#gt; #35;1 #96;y#96; a#38;b z");
  });

  it("both diagrams stay valid Mermaid over hostile directory names", () => {
    const g = graphWith(HOSTILE);
    for (const text of [renderMermaid(g), renderMermaidClustered(g).content]) {
      expect(mermaidProblems(text)).toEqual([]);
      expect(text).not.toContain("onerror=alert(1)>");
      // One fence, opened and closed, whatever the names held.
      if (text.startsWith("```")) expect(text.match(/```/g)).toHaveLength(2);
    }
  });
});

describe("SCIP project_root", () => {
  it("is a file URI that round-trips to the repository, a space included", () => {
    const root = join(mkdtempSync(join(tmpdir(), "ci-scip-")), "one file");
    cpSync(REPO, root, { recursive: true });
    const { projectRoot } = decodeScip(renderScip(scanRepo(root)));
    expect(projectRoot).toBe(pathToFileURL(root).href);
    expect(projectRoot).toContain("one%20file");
    expect(fileURLToPath(projectRoot!)).toBe(root);
  });
});
