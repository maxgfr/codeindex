import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkRules, parseRules, type ArchRule } from "../src/rules.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import type { Edge, FileNode, Graph } from "../src/types.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

// Hand-built graphs: checkRules only reads files (rel/fileKind/degIn/degOut),
// fileEdges and moduleEdges, so a minimal Graph isolates each rule semantics.
function fileNode(rel: string, o: Partial<FileNode> = {}): FileNode {
  return {
    id: rel,
    kind: "file",
    rel,
    fileKind: o.fileKind ?? "code",
    lang: "typescript",
    module: o.module ?? "root",
    symbols: 0,
    lines: 1,
    degIn: o.degIn ?? 0,
    degOut: o.degOut ?? 0,
  };
}

function graphOf(files: FileNode[], fileEdges: Edge[] = [], moduleEdges: Edge[] = []): Graph {
  return {
    schemaVersion: 4,
    version: "0.0.0",
    fileCount: files.length,
    languages: {},
    files,
    modules: [],
    fileEdges,
    moduleEdges,
  };
}

const edge = (from: string, to: string, kind: Edge["kind"] = "import"): Edge => ({ from, to, kind, weight: 1 });

describe("checkRules — forbidden edges", () => {
  it("flags a matching edge with severity error by default and echoes the comment", () => {
    const g = graphOf(
      [fileNode("src/core/a.ts", { degOut: 1 }), fileNode("src/cli/b.ts", { degIn: 1 })],
      [edge("src/core/a.ts", "src/cli/b.ts")],
    );
    const rules: ArchRule[] = [{ name: "core-must-not-touch-cli", from: "src/core/**", to: "src/cli/**", comment: "core stays UI-free" }];
    expect(checkRules(g, rules)).toEqual([
      {
        rule: "core-must-not-touch-cli",
        from: "src/core/a.ts",
        to: "src/cli/b.ts",
        kind: "import",
        severity: "error",
        comment: "core stays UI-free",
      },
    ]);
  });

  it("restricts to the given edge kinds and honors severity warn", () => {
    const g = graphOf(
      [fileNode("a.ts", { degOut: 2 }), fileNode("b.ts", { degIn: 2 })],
      [edge("a.ts", "b.ts", "import"), edge("a.ts", "b.ts", "mention")],
    );
    const rules: ArchRule[] = [{ name: "no-imports", from: "a.ts", to: "b.ts", kind: ["import"], severity: "warn" }];
    const violations = checkRules(g, rules);
    expect(violations.length).toBe(1);
    expect(violations[0]!.kind).toBe("import");
    expect(violations[0]!.severity).toBe("warn");
  });

  it("ignores dangling edges and accepts glob arrays", () => {
    const g = graphOf(
      [fileNode("app/x.ts", { degOut: 1 }), fileNode("lib/y.ts", { degIn: 1 })],
      [edge("app/x.ts", "lib/y.ts"), { ...edge("app/x.ts", "./gone.js"), dangling: true }],
    );
    const rules: ArchRule[] = [{ name: "r", from: ["app/**", "web/**"], to: ["lib/**"] }];
    const violations = checkRules(g, rules);
    expect(violations.map((v) => `${v.from} -> ${v.to}`)).toEqual(["app/x.ts -> lib/y.ts"]);
  });

  it("sorts violations deterministically (rule, from, to, kind)", () => {
    const g = graphOf(
      [fileNode("a.ts", { degOut: 2 }), fileNode("z.ts", { degOut: 1 }), fileNode("b.ts", { degIn: 3 })],
      [edge("z.ts", "b.ts"), edge("a.ts", "b.ts", "use"), edge("a.ts", "b.ts", "import")],
    );
    const rules: ArchRule[] = [{ name: "r", from: "*.ts", to: "b.ts" }];
    expect(checkRules(g, rules).map((v) => `${v.from} ${v.kind}`)).toEqual(["a.ts import", "a.ts use", "z.ts import"]);
  });
});

describe("checkRules — builtins", () => {
  it("cycles: reports a module-level import cycle once, as a canonical path from the smallest module", () => {
    const g = graphOf([], [], [edge("pkg-b", "pkg-a"), edge("pkg-a", "pkg-b"), edge("pkg-a", "pkg-c")]);
    const violations = checkRules(g, [{ name: "no-cycles", builtin: "cycles" }]);
    expect(violations).toEqual([
      { rule: "no-cycles", from: "pkg-a", to: "pkg-a -> pkg-b -> pkg-a", kind: "cycle", severity: "error" },
    ]);
  });

  it("cycles: only import-kind module edges participate", () => {
    const g = graphOf([], [], [edge("m-a", "m-b", "call"), edge("m-b", "m-a", "call")]);
    expect(checkRules(g, [{ name: "no-cycles", builtin: "cycles" }])).toEqual([]);
  });

  it("orphans: flags edge-less code files but skips docs and entrypoint-looking names", () => {
    const g = graphOf([
      fileNode("src/dead.ts"), // orphan
      fileNode("src/index.ts"), // entrypoint-looking — excluded
      fileNode("src/main.py"), // entrypoint-looking — excluded
      fileNode("notes.md", { fileKind: "doc" }), // not code — excluded
      fileNode("src/used.ts", { degIn: 1 }), // has an edge — excluded
    ]);
    expect(checkRules(g, [{ name: "no-orphans", builtin: "orphans", severity: "warn" }])).toEqual([
      { rule: "no-orphans", from: "src/dead.ts", to: "src/dead.ts", kind: "orphan", severity: "warn" },
    ]);
  });
});

describe("parseRules", () => {
  it("accepts a bare array or a {rules} wrapper and applies no defaults of its own", () => {
    const arr = [{ name: "r", from: "a/**", to: "b/**" }];
    expect(parseRules(arr)).toEqual([{ name: "r", from: "a/**", to: "b/**", kind: undefined, severity: undefined, comment: undefined }]);
    expect(parseRules({ rules: arr })).toEqual(parseRules(arr));
  });

  it("rejects malformed payloads with descriptive errors", () => {
    expect(() => parseRules("nope")).toThrow(/must be an array/);
    expect(() => parseRules([{ from: "a", to: "b" }])).toThrow(/`name`/);
    expect(() => parseRules([{ name: "r", from: "a" }])).toThrow(/`to`/);
    expect(() => parseRules([{ name: "r", builtin: "nope" }])).toThrow(/builtin/);
    expect(() => parseRules([{ name: "r", from: "a", to: "b", severity: "fatal" }])).toThrow(/severity/);
    expect(() => parseRules([{ name: "r", from: "a", to: "b", kind: ["teleport"] }])).toThrow(/kind/);
  });
});

// A synthetic monorepo written to a temp dir and run through the REAL pipeline:
// packages/a and packages/b import each other (a module-level import cycle),
// packages/b also violates a forbidden-edge rule, and packages/c/dead.ts is an
// orphan. This is the end-to-end CI-gate scenario.
function writeSyntheticMonorepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ci-rules-"));
  mkdirSync(join(repo, "packages/a/src"), { recursive: true });
  mkdirSync(join(repo, "packages/b/src"), { recursive: true });
  mkdirSync(join(repo, "packages/c/src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "syn", workspaces: ["packages/*"] }) + "\n");
  writeFileSync(
    join(repo, "packages/a/src/api.ts"),
    'import { helperB } from "../../b/src/helper.js";\nexport function apiA(): number {\n  return helperB();\n}\n',
  );
  writeFileSync(
    join(repo, "packages/b/src/helper.ts"),
    'import { apiA } from "../../a/src/api.js";\nexport function helperB(): number {\n  return 1;\n}\nexport function useA(): number {\n  return apiA();\n}\n',
  );
  writeFileSync(join(repo, "packages/c/src/dead.ts"), "export function unusedThing(): number {\n  return 42;\n}\n");
  return repo;
}

const SYNTH_RULES: ArchRule[] = [
  { name: "b-must-not-import-a", from: "packages/b/**", to: "packages/a/**", kind: ["import"], comment: "b is a leaf" },
  { name: "no-cycles", builtin: "cycles" },
  { name: "no-orphans", builtin: "orphans", severity: "warn" },
];

describe("rules on a synthetic monorepo (real pipeline)", () => {
  it("finds the forbidden edge, the import cycle and the orphan — deterministically", () => {
    const repo = writeSyntheticMonorepo();
    const { graph } = buildIndexArtifacts(repo);
    const violations = checkRules(graph, SYNTH_RULES);
    expect(violations).toEqual([
      {
        rule: "b-must-not-import-a",
        from: "packages/b/src/helper.ts",
        to: "packages/a/src/api.ts",
        kind: "import",
        severity: "error",
        comment: "b is a leaf",
      },
      {
        rule: "no-cycles",
        from: "packages-a-src",
        to: "packages-a-src -> packages-b-src -> packages-a-src",
        kind: "cycle",
        severity: "error",
      },
      {
        rule: "no-orphans",
        from: "packages/c/src/dead.ts",
        to: "packages/c/src/dead.ts",
        kind: "orphan",
        severity: "warn",
      },
    ]);
    // Deterministic double-run: identical bytes.
    const again = checkRules(buildIndexArtifacts(repo).graph, SYNTH_RULES);
    expect(JSON.stringify(again)).toBe(JSON.stringify(violations));
  });

  it("CLI `rules` exits 1 on error-severity violations and 0 when only warnings remain", () => {
    const repo = writeSyntheticMonorepo();
    const config = join(repo, "codeindex.rules.json");

    writeFileSync(config, JSON.stringify({ rules: SYNTH_RULES }, null, 2) + "\n");
    const failing = spawnSync(process.execPath, [CLI, "rules", "--repo", repo, "--config", config], { encoding: "utf8" });
    expect(failing.status).toBe(1);
    const out = JSON.parse(failing.stdout) as { errors: number; warnings: number; violations: unknown[] };
    expect(out.errors).toBe(2);
    expect(out.warnings).toBe(1);
    expect(out.violations.length).toBe(3);

    writeFileSync(config, JSON.stringify({ rules: [{ name: "no-orphans", builtin: "orphans", severity: "warn" }] }) + "\n");
    const warning = spawnSync(process.execPath, [CLI, "rules", "--repo", repo, "--config", config], { encoding: "utf8" });
    expect(warning.status).toBe(0);
    const warnOut = JSON.parse(warning.stdout) as { errors: number; warnings: number };
    expect(warnOut.errors).toBe(0);
    expect(warnOut.warnings).toBe(1);
  });
});
