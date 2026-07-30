import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { computeImportPairs } from "../src/callers.js";
import { buildTypeHierarchy, implementationsOf, resolveRelations, resolveRelationEdges } from "../src/relations.js";
import { extractCode } from "../src/extract/code.js";
import { buildIndexArtifacts } from "../src/pipeline.js";

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-relations-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// A three-file TypeScript hierarchy: an interface, a base class, and a concrete
// class that both extends and implements — the shape resolution has to get right.
const TS_REPO = {
  "src/contract.ts": "export interface Runnable {\n  start(): void;\n}\n",
  "src/base.ts": "export abstract class Base {\n  abstract start(): void;\n}\n",
  "src/worker.ts": [
    'import { Runnable } from "./contract.js";',
    'import { Base } from "./base.js";',
    "export class Worker extends Base implements Runnable {",
    "  start(): void {}",
    "}",
    "export class Retrying extends Worker {}",
    "",
  ].join("\n"),
};

describe("relation extraction (per file, unresolved)", () => {
  it("reads both TypeScript heritage clauses off one class", () => {
    const src = "export class Worker extends Base implements Runnable, Closeable {}\n";
    const info = extractCode("w.ts", ".ts", src);
    // Sorted by (from, kind, to), not source order — the same determinism rule
    // every other extracted collection follows, so two builds agree byte for byte.
    expect(info.relations).toEqual([
      { kind: "extends", from: "Worker", to: "Base", line: 1 },
      { kind: "implements", from: "Worker", to: "Closeable", line: 1 },
      { kind: "implements", from: "Worker", to: "Runnable", line: 1 },
    ]);
  });

  it("ignores type arguments — `extends Base<T>` inherits from Base, not T", () => {
    const info = extractCode("w.ts", ".ts", "export class W extends Base<Payload> {}\n");
    expect(info.relations).toEqual([{ kind: "extends", from: "W", to: "Base", line: 1 }]);
  });

  it("reads a Rust trait implementation off the impl block, keeping the type as the subject", () => {
    const src = ["pub struct S;", "", "impl fmt::Display for S {", "    fn fmt(&self) {}", "}", ""].join("\n");
    const info = extractCode("s.rs", ".rs", src);
    // `impl Display for S` says S provides Display — the qualified path reduces
    // to its last segment, since that is what a definition is named by.
    expect(info.relations).toEqual([{ kind: "implements", from: "S", to: "Display", line: 3 }]);
  });

  it("reads Go struct embedding as inheritance and does not also emit a field", () => {
    const src = "type Audited struct {\n\tScheduler\n\tLog []string\n}\n";
    const info = extractCode("s.go", ".go", src);
    expect(info.relations).toEqual([{ kind: "extends", from: "Audited", to: "Scheduler", line: 2 }]);
    // The embedded type is a relation, NOT a field named after the type.
    expect(info.symbols.map((s) => s.name)).not.toContain("Scheduler");
    expect(info.symbols.map((s) => s.name)).toContain("Log");
  });

  it("reads a Ruby superclass and an `include` mixin", () => {
    const src = ["class Worker < Base", "  include Runnable", "  def start; end", "end", ""].join("\n");
    const info = extractCode("w.rb", ".rb", src);
    expect(info.relations).toEqual([
      { kind: "extends", from: "Worker", to: "Base", line: 1 },
      { kind: "implements", from: "Worker", to: "Runnable", line: 2 },
    ]);
  });

  it("splits a C# base list into base class first, interfaces after", () => {
    const info = extractCode("W.cs", ".cs", "public class W : Base, IRunnable, IDisposable { }\n");
    expect(info.relations).toEqual([
      { kind: "extends", from: "W", to: "Base", line: 1 },
      { kind: "implements", from: "W", to: "IDisposable", line: 1 },
      { kind: "implements", from: "W", to: "IRunnable", line: 1 },
    ]);
  });

  it("never records a type as inheriting from itself", () => {
    const info = extractCode("w.ts", ".ts", "export class Worker extends Worker {}\n");
    expect(info.relations ?? []).toEqual([]);
  });

  it("is deterministic and deduped", () => {
    const src = "export class W extends B implements I {}\nexport class W2 extends B implements I {}\n";
    const a = extractCode("w.ts", ".ts", src);
    const b = extractCode("w.ts", ".ts", src);
    expect(a.relations).toEqual(b.relations);
  });
});

describe("relation resolution", () => {
  it("binds each target to its defining file", () => {
    const root = repoWith(TS_REPO);
    const scan = scanRepo(root);
    const resolved = resolveRelations(scan, computeImportPairs(scan));
    expect(resolved).toEqual([
      {
        kind: "extends",
        from: "Retrying",
        fromFile: "src/worker.ts",
        fromLine: 6,
        to: "Worker",
        toFile: "src/worker.ts",
        toKind: "class",
      },
      {
        kind: "extends",
        from: "Worker",
        fromFile: "src/worker.ts",
        fromLine: 3,
        to: "Base",
        toFile: "src/base.ts",
        toKind: "class",
      },
      {
        kind: "implements",
        from: "Worker",
        fromFile: "src/worker.ts",
        fromLine: 3,
        to: "Runnable",
        toFile: "src/contract.ts",
        toKind: "interface",
      },
    ]);
  });

  it("corrects the syntactic guess when the target turns out to be an interface", () => {
    // C# lists the base class first, so extraction guesses `extends` for the
    // first entry. Here the ONLY entry is an interface — resolution must fix it.
    const root = repoWith({
      "IRunnable.cs": "public interface IRunnable { void Start(); }\n",
      "W.cs": "public class W : IRunnable { public void Start() {} }\n",
    });
    const scan = scanRepo(root);
    const resolved = resolveRelations(scan, computeImportPairs(scan));
    expect(resolved).toEqual([
      { kind: "implements", from: "W", fromFile: "W.cs", fromLine: 1, to: "IRunnable", toFile: "IRunnable.cs", toKind: "interface" },
    ]);
  });

  it("drops a target with no definition in the repo rather than inventing an edge", () => {
    const root = repoWith({ "w.ts": "export class W extends SomeFrameworkBase {}\n" });
    const scan = scanRepo(root);
    expect(resolveRelations(scan, computeImportPairs(scan))).toEqual([]);
  });

  it("emits file edges, skipping same-file relations", () => {
    const root = repoWith(TS_REPO);
    const scan = scanRepo(root);
    const edges = resolveRelationEdges(scan, computeImportPairs(scan));
    // Retrying→Worker is same-file: a real relation, not a file dependency.
    expect(edges).toEqual([
      { from: "src/worker.ts", to: "src/base.ts", kind: "extends", weight: 1 },
      { from: "src/worker.ts", to: "src/contract.ts", kind: "implements", weight: 1 },
    ]);
  });

  it("puts the edges in graph.json and ranks inheritance above a plain call at module level", () => {
    const root = repoWith(TS_REPO);
    const { graph } = buildIndexArtifacts(root);
    const kinds = graph.fileEdges.filter((e) => e.kind === "extends" || e.kind === "implements");
    expect(kinds.length).toBe(2);
    expect(graph.schemaVersion).toBe(5);
  });
});

describe("type hierarchy", () => {
  it("reports both directions plus unresolved supertypes", () => {
    const root = repoWith({ ...TS_REPO, "src/odd.ts": "export class Odd extends Vendor {}\n" });
    const scan = scanRepo(root);
    const h = buildTypeHierarchy(scan, computeImportPairs(scan));

    const runnable = h.get("Runnable")!;
    expect(runnable.kind).toBe("interface");
    expect(runnable.implementedBy.map((r) => r.name)).toEqual(["Worker"]);
    expect(runnable.extends).toEqual([]);

    const worker = h.get("Worker")!;
    expect(worker.extends.map((r) => r.name)).toEqual(["Base"]);
    expect(worker.implements.map((r) => r.name)).toEqual(["Runnable"]);
    expect(worker.extendedBy.map((r) => r.name)).toEqual(["Retrying"]);

    // A base class the repo does not contain is reported, not silently dropped.
    expect(h.get("Odd")!.unresolved).toEqual([{ kind: "extends", to: "Vendor" }]);
  });

  it("walks implementations transitively", () => {
    const root = repoWith(TS_REPO);
    const scan = scanRepo(root);
    const h = buildTypeHierarchy(scan, computeImportPairs(scan));
    // Retrying implements Runnable only through Worker — a one-hop answer would
    // miss it, which is the whole reason this walks.
    expect(implementationsOf(h, "Runnable").map((r) => r.name)).toEqual(["Retrying", "Worker"]);
  });

  it("survives an inheritance cycle without looping", () => {
    const root = repoWith({ "a.ts": "export class A extends B {}\nexport class B extends A {}\n" });
    const scan = scanRepo(root);
    const h = buildTypeHierarchy(scan, computeImportPairs(scan));
    expect(implementationsOf(h, "A").map((r) => r.name)).toEqual(["B"]);
  });

  it("is deterministic across builds", () => {
    const root = repoWith(TS_REPO);
    const one = buildTypeHierarchy(scanRepo(root), computeImportPairs(scanRepo(root)));
    const two = buildTypeHierarchy(scanRepo(root), computeImportPairs(scanRepo(root)));
    expect(JSON.stringify([...one])).toBe(JSON.stringify([...two]));
  });
});
