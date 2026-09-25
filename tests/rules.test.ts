import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkRules, parseRules, parseRulesText, type ArchRule } from "../src/rules.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import type { Edge, FileNode, Graph } from "../src/types.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const clientModule = new URL("../scripts/bench/mcp-client.mjs", import.meta.url).href;

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
    ...(o.testFile ? { testFile: true as const } : {}),
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
    const g = graphOf(
      [
        fileNode("src/dead.ts"), // orphan
        fileNode("src/index.ts"), // entrypoint-looking — excluded
        fileNode("src/main.py"), // entrypoint-looking — excluded
        fileNode("notes.md", { fileKind: "doc" }), // not code — excluded
        fileNode("src/used.ts", { degIn: 1 }), // has an edge — excluded
        fileNode("src/caller.ts", { degOut: 1 }),
      ],
      [edge("src/caller.ts", "src/used.ts")],
    );
    expect(checkRules(g, [{ name: "no-orphans", builtin: "orphans", severity: "warn" }])).toEqual([
      { rule: "no-orphans", from: "src/dead.ts", to: "src/dead.ts", kind: "orphan", severity: "warn" },
    ]);
  });
});

describe("checkRules — orphans that are not", () => {
  const ORPHANS: ArchRule[] = [{ name: "o", builtin: "orphans" }];
  const go = (rel: string, o: Partial<FileNode> = {}): FileNode => ({ ...fileNode(rel, o), lang: "go" });

  it("counts a Go file as connected when its package is: siblings see each other without imports", () => {
    const g = graphOf(
      [
        go("gin.go", { degOut: 1 }),
        go("path.go"), // cleanPath is called from gin.go, unexported: no edge
        go("codec/json/api.go", { degIn: 1 }), // the import's representative file
        go("codec/json/sonic.go"), // a build variant of the same package
        go("dead/dead.go"), // a package nothing imports
        go("lonely/a_test.go", { degOut: 1, testFile: true }), // a test reaching out
        go("lonely/lonely.go"), // does not make lonely.go live
      ],
      [edge("gin.go", "codec/json/api.go")],
    );
    expect(checkRules(g, ORPHANS).map((v) => v.from)).toEqual(["dead/dead.go", "lonely/lonely.go"]);
  });

  it("skips tests, and languages no code edge in the repo reaches", () => {
    const g = graphOf(
      [
        fileNode("app/a.py", { degOut: 1 }),
        fileNode("app/b.py", { degIn: 1 }),
        fileNode("app/unused.py"),
        fileNode("tests/test_x.py", { testFile: true }),
        { ...fileNode("schema.sql"), lang: "sql" },
        { ...fileNode("on-create.sh"), lang: "shell" },
        { ...fileNode("app/wsgi.py") },
      ].map((f) => (f.lang === "typescript" ? { ...f, lang: "python" } : f)),
      [edge("app/a.py", "app/b.py"), edge("README.md", "schema.sql", "doc-link")],
    );
    expect(checkRules(g, ORPHANS).map((v) => v.from)).toEqual(["app/unused.py"]);
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

  it("accepts every edge kind the graph emits, extends and implements included", () => {
    const kinds = ["contains", "doc-link", "import", "call", "extends", "implements", "use", "mention"] as const;
    for (const k of kinds) expect(parseRules([{ name: "r", from: "a", to: "b", kind: [k] }])[0]).toMatchObject({ kind: [k] });
  });

  it("rejects a literals `tiers` that would select nothing, instead of disabling the gate", () => {
    const lit = { name: "gate", builtin: "literals" };
    expect(() => parseRules([{ ...lit, tiers: "competing" }])).toThrow(/`tiers` must be a non-empty array of competing, bypassed, uncentralized/);
    expect(() => parseRules([{ ...lit, tiers: ["competng"] }])).toThrow(/`tiers`/);
    expect(() => parseRules([{ ...lit, tiers: [] }])).toThrow(/`tiers`/);
    expect(() => parseRules([{ ...lit, minFiles: 0 }])).toThrow(/`minFiles` must be a positive integer/);
    expect(() => parseRules([{ ...lit, includeTests: "yes" }])).toThrow(/`includeTests` must be a boolean/);
    expect(parseRules([{ ...lit, tiers: ["bypassed"], minFiles: 3, minCount: 4, includeTests: true }])[0]).toEqual({
      ...lit,
      severity: undefined,
      comment: undefined,
      tiers: ["bypassed"],
      minFiles: 3,
      minCount: 4,
      includeTests: true,
    });
  });

  it("rejects keys the rule shape does not read, so a typo cannot leave a default in force", () => {
    expect(() => parseRules([{ name: "r", from: "a", to: "b", sevrity: "warn" }])).toThrow(
      /rules\[0\] \(r\): unknown key `sevrity` — a forbidden-edge rule takes name, severity, comment, from, to, kind/,
    );
    expect(() => parseRules([{ name: "c", builtin: "cycles", tiers: ["competing"] }])).toThrow(/unknown key `tiers` — builtin "cycles"/);
    expect(() => parseRules([{ name: "l", builtin: "literals", tier: ["competing"] }])).toThrow(/unknown key `tier`/);
  });

  it("names the rules file in a JSON error, without echoing its content", () => {
    expect(() => parseRulesText('{\n  bad: 1 }', "codeindex.rules.json")).toThrow(
      /^rules config codeindex\.rules\.json is not valid JSON \(line 2, column 3\)$/,
    );
    let msg = "";
    try {
      parseRulesText("root:x:0:0:root:/root:/bin/bash\n", "/etc/passwd");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^rules config \/etc\/passwd is not valid JSON/);
    expect(msg).not.toContain("root:x");
    expect(() => parseRulesText('[{"name":"r","from":"a"}]', "x.json")).toThrow(/^rules config x\.json: rules\[0\] \(r\): `to`/);
  });
});

describe("checkRules — vacuous rules", () => {
  it("reports a forbidden rule whose globs match no indexed file as an unmatched warning", () => {
    const g = graphOf([fileNode("render/a.ts", { degOut: 1 }), fileNode("lib/b.ts", { degIn: 1 })], [edge("render/a.ts", "lib/b.ts")]);
    expect(checkRules(g, [{ name: "typo", from: "rendr/**", to: ["lib/**"] }])).toEqual([
      { rule: "typo", from: "rendr/**", to: "`from` matches no indexed file", kind: "unmatched", severity: "warn" },
    ]);
    // Both sides matching and no offending edge is a passing rule, not a vacuous one.
    expect(checkRules(g, [{ name: "ok", from: "lib/**", to: "render/**" }])).toEqual([]);
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

// 25 values each held by constants in three files (competing), plus one route
// that a constant holds and two other files rewrite (bypassed). graph.json
// carries 24 duplications, competing first, so the bypassed one is not on it.
function writeLiteralsRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "ci-rules-lit-"));
  for (const f of ["a", "b", "c"]) {
    const lines = Array.from({ length: 25 }, (_, i) => `export const K${f.toUpperCase()}${i} = "value-number-${String(i).padStart(2, "0")}";`);
    writeFileSync(join(repo, `${f}.ts`), lines.join("\n") + "\n");
  }
  writeFileSync(join(repo, "route.ts"), 'export const ROUTE = "/api/bypassed/path";\n');
  writeFileSync(join(repo, "use1.ts"), 'export function u1() {\n  return fetch("/api/bypassed/path");\n}\n');
  writeFileSync(join(repo, "use2.ts"), 'export function u2() {\n  return fetch("/api/bypassed/path");\n}\n');
  return repo;
}

describe("checkRules — literals reads the whole duplication list", () => {
  const BYPASS: ArchRule[] = [{ name: "bypass-gate", builtin: "literals", tiers: ["bypassed"] }];

  it("finds a violation past the 24-entry graph headline when given the scan", () => {
    const repo = writeLiteralsRepo();
    try {
      const { scan, graph } = buildIndexArtifacts(repo);
      expect(graph.literalDuplications).toHaveLength(24);
      expect(graph.literalDuplications!.every((d) => d.tier === "competing")).toBe(true);
      expect(checkRules(graph, BYPASS)).toEqual([]); // the headline alone cannot see it
      expect(checkRules(graph, BYPASS, { scan })).toEqual([
        {
          rule: "bypass-gate",
          from: "route.ts:1",
          to: 'bypassed "/api/bypassed/path" (3 sites, 3 files)',
          kind: "literal",
          severity: "error",
        },
      ]);
      expect(checkRules(graph, [{ name: "c", builtin: "literals", tiers: ["competing"] }], { scan })).toHaveLength(25);
      // The rule's own thresholds apply, as `codeindex literals --min-files 4` would.
      expect(checkRules(graph, [{ ...BYPASS[0]!, minFiles: 4 } as ArchRule], { scan })).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("CLI `rules` fails the gate on it", () => {
    const repo = writeLiteralsRepo();
    try {
      const config = join(repo, "codeindex.rules.json");
      writeFileSync(config, JSON.stringify(BYPASS));
      const res = spawnSync(process.execPath, [CLI, "rules", "--repo", repo, "--config", config], { encoding: "utf8" });
      expect(res.status).toBe(1);
      expect(JSON.parse(res.stdout)).toMatchObject({ errors: 1, warnings: 0 });
      writeFileSync(config, "[{ oops }]");
      const bad = spawnSync(process.execPath, [CLI, "rules", "--repo", repo, "--config", config], { encoding: "utf8" });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain(`rules config ${config} is not valid JSON (line 1, column 4)`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("MCP check_rules reads a configPath inside the repository only", async () => {
    const repo = writeLiteralsRepo();
    const outside = mkdtempSync(join(tmpdir(), "ci-rules-out-"));
    const { startMcpClient } = await import(/* @vite-ignore */ clientModule);
    const client = startMcpClient(process.execPath, [CLI, "mcp", "--repo", repo], { timeoutMs: 30_000 });
    try {
      expect((await client.handshake()).ok).toBe(true);
      writeFileSync(join(repo, "rules.json"), JSON.stringify(BYPASS));
      writeFileSync(join(outside, "secret.txt"), "root:x:0:0:root:/root:/bin/bash\n");
      const call = (args: Record<string, unknown>) => client.request("tools/call", { name: "check_rules", arguments: args });
      const inside = await call({ configPath: "rules.json" });
      expect(inside.result.isError).not.toBe(true);
      expect(JSON.parse(inside.result.content[0].text)).toHaveLength(1);
      const escaped = await call({ configPath: join(outside, "secret.txt") });
      expect(escaped.result.isError).toBe(true);
      expect(escaped.result.content[0].text).toMatch(/must be a file inside the repository/);
      expect(escaped.result.content[0].text).not.toContain("root:x");
      const dotdot = await call({ configPath: "../" + outside.split("/").pop() + "/secret.txt" });
      expect(dotdot.result.content[0].text).toMatch(/must be a file inside the repository/);
    } finally {
      await client.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);
});
