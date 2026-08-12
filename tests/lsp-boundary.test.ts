// The LSP tier's one structural guarantee, checked by the engine on itself.
//
// "graph.json and symbols.json cannot change because a language server ran" is
// only worth as much as its enforcement. A comment saying so decays; a test
// that BUILDS THIS REPOSITORY'S OWN GRAPH and walks the import closure of the
// artifact pipeline cannot. If someone imports src/lsp/ from the pipeline —
// even three modules deep, even by accident — this goes red with the path.
//
// Dogfooding on purpose: the tool that claims to answer "what does this reach"
// is the tool answering it here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndexArtifacts } from "../src/pipeline.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every file reachable from `entry` by following import edges. */
function importClosure(edges: { from: string; to: string; kind: string }[], entry: string): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const arr = outgoing.get(edge.from) ?? [];
    arr.push(edge.to);
    outgoing.set(edge.from, arr);
  }
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push(next);
  }
  seen.delete(entry);
  return seen;
}

describe("LSP boundary", () => {
  const { graph } = buildIndexArtifacts(ROOT, { include: ["src/**"] });

  it("src/pipeline.ts cannot reach src/lsp/ — the artifact path never sees the tier", () => {
    const reachable = [...importClosure(graph.fileEdges, "src/pipeline.ts")];
    // Sanity: the closure is real, not an empty set that would pass vacuously.
    expect(reachable).toContain("src/scan.ts");
    expect(reachable.filter((f) => f.startsWith("src/lsp/"))).toEqual([]);
  });

  it("neither can the renderers, which are what actually emit the bytes", () => {
    for (const entry of ["src/render/graph-json.ts", "src/render/symbols-json.ts", "src/scan.ts", "src/walk.ts"]) {
      expect(importClosure(graph.fileEdges, entry).has("src/lsp/index.ts"), entry).toBe(false);
    }
  });

  it("the tier does not import the artifact types it must not be able to build", () => {
    // Structural, not just directional: nothing under src/lsp/ may touch the
    // graph, the symbol index or a renderer, so it has no way to produce an
    // artifact even if the import direction were reversed one day.
    const forbidden = [/from "\.\.\/render\//, /from "\.\.\/pipeline\.js"/, /\bGraph\b.*from "\.\.\/types\.js"/, /SymbolIndex/];
    for (const file of ["index.ts", "client.ts", "config.ts", "protocol.ts", "refs.ts", "spawn.ts"]) {
      const source = readFileSync(join(ROOT, "src", "lsp", file), "utf8");
      for (const pattern of forbidden) expect(pattern.test(source), `${file} matches ${pattern}`).toBe(false);
    }
  });

  it("only spawn.ts may import a process — the rest is a pure state machine", () => {
    for (const file of ["index.ts", "client.ts", "config.ts", "protocol.ts", "refs.ts"]) {
      const source = readFileSync(join(ROOT, "src", "lsp", file), "utf8");
      expect(source.includes('from "node:child_process"'), file).toBe(false);
    }
    expect(readFileSync(join(ROOT, "src", "lsp", "spawn.ts"), "utf8")).toContain('from "node:child_process"');
  });

  it("protocol.ts is pure: no filesystem, no process, no clock", () => {
    // It is the layer every framing bug lives in, so it has to stay testable
    // with nothing but strings.
    const source = readFileSync(join(ROOT, "src", "lsp", "protocol.ts"), "utf8");
    for (const forbidden of ["node:fs", "node:child_process", "Date.now", "setTimeout"]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});
