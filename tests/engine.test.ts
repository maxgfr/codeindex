import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as engine from "../src/engine.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../scripts/engine.mjs", import.meta.url));

// The public contract: every export a consumer may rely on. Removing or
// renaming one is a breaking change — this list is the tripwire.
const CONTRACT = [
  // constants
  "ENGINE_VERSION",
  "SCHEMA_VERSION",
  "EXTRACTOR_VERSION",
  // files tier
  "walk",
  "readText",
  "DEFAULT_MAX_FILES",
  "scanRepo",
  "compileGlobs",
  "parseGitignore",
  "isIgnored",
  "classify",
  "categorize",
  "isCode",
  "isDoc",
  "MARKDOWN_EXT",
  "extractSymbols",
  "languageOf",
  "extToLang",
  // extraction
  "extractCode",
  "extractMarkdown",
  "ensureGrammars",
  "allGrammarKeys",
  "grammarKeyForExt",
  "grammarReady",
  "extractAst",
  // resolution + graph
  "buildResolveContext",
  "resolveImport",
  "resolveDocLink",
  "buildModules",
  "isTestFile",
  "tierForPath",
  "buildGraph",
  "uniqueSymbolDefs",
  "resolveCallEdges",
  "buildCallerIndex",
  "enclosingSymbol",
  "computeImportPairs",
  "detectWorkspaces",
  // analytics
  "applyCentrality",
  "pagerankOf",
  "betweennessOf",
  "detectCommunities",
  "communityOf",
  "computeTestMap",
  "isTestPath",
  "testsForModule",
  "untestedModules",
  "computeSurprises",
  "isSurprising",
  // symbol index + renderers
  "buildSymbolIndex",
  "computeSymbolRefs",
  "renderSymbolsJson",
  "renderGraphJson",
  // pipeline
  "buildIndexArtifacts",
  // git
  "headCommit",
  "isGitWorktree",
  "resolveBaseRef",
  "diffFiles",
  "diffHunks",
  "untrackedFiles",
  "gitChurn",
  "changedSince",
  "grepRepo",
  // helpers
  "sha1",
  "shortHash",
  "byStr",
  "byKey",
  "sh",
  "have",
  "slugify",
  "clip",
  "clipInline",
  "escapeRegExp",
  "foldText",
  "keywords",
  "rankedKeywords",
  "rrf",
] as const;

describe("public API contract", () => {
  it("exports every contract name", () => {
    const missing = CONTRACT.filter((name) => (engine as Record<string, unknown>)[name] === undefined);
    expect(missing).toEqual([]);
  });

  it("ENGINE_VERSION is a semver string and greppable in the bundle", () => {
    expect(engine.ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const bundle = engine.readText(BUNDLE);
    expect(bundle).toContain(`ENGINE_VERSION = "${engine.ENGINE_VERSION}"`);
  });
});

describe("pipeline", () => {
  it("builds graph + symbols for the fixture, deterministically", () => {
    const a = engine.buildIndexArtifacts(REPO);
    const b = engine.buildIndexArtifacts(REPO);
    expect(a.graph.fileCount).toBeGreaterThan(0);
    expect(Object.keys(a.symbols.defs).length).toBeGreaterThan(0);
    expect(engine.renderGraphJson(a.graph)).toBe(engine.renderGraphJson(b.graph));
    expect(engine.renderSymbolsJson(a.symbols)).toBe(engine.renderSymbolsJson(b.symbols));
  });

  it("stamps consumer meta into the graph when provided", () => {
    const { graph } = engine.buildIndexArtifacts(REPO, { meta: { version: "9.9.9", schemaVersion: 7 } });
    expect(graph.version).toBe("9.9.9");
    expect(graph.schemaVersion).toBe(7);
    const { graph: dflt } = engine.buildIndexArtifacts(REPO);
    expect(dflt.version).toBe(engine.ENGINE_VERSION);
    expect(dflt.schemaVersion).toBe(engine.SCHEMA_VERSION);
  });
});

describe("bundle CLI", () => {
  const run = (args: string[], cwd?: string): string =>
    execFileSync(process.execPath, [BUNDLE, ...args], { encoding: "utf8", cwd });

  it("graph emits valid JSON, byte-identical across two runs", () => {
    const a = run(["graph", "--repo", REPO]);
    const b = run(["graph", "--repo", REPO]);
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as { fileCount: number; fileEdges: unknown[] };
    expect(parsed.fileCount).toBeGreaterThan(0);
  });

  it("symbols emits a populated symbol index", () => {
    const parsed = JSON.parse(run(["symbols", "--repo", REPO])) as { defs: Record<string, unknown> };
    expect(Object.keys(parsed.defs).length).toBeGreaterThan(0);
  });

  it("version prints the engine version", () => {
    expect(run(["version"]).trim()).toBe(engine.ENGINE_VERSION);
  });
});

describe("no-wasm mode (vendored consumer layout)", () => {
  it("the bundle alone — no grammars sidecar — still indexes via the regex tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-nowasm-"));
    const lone = join(dir, "engine.mjs");
    copyFileSync(BUNDLE, lone);
    const out = execFileSync(process.execPath, [lone, "symbols", "--repo", REPO], {
      encoding: "utf8",
      // Neutralize the env override a dev shell might carry.
      env: { ...process.env, CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "" },
    });
    const parsed = JSON.parse(out) as { defs: Record<string, unknown> };
    expect(Object.keys(parsed.defs).length).toBeGreaterThan(0);

    const graphOut = execFileSync(process.execPath, [lone, "graph", "--repo", REPO], {
      encoding: "utf8",
      env: { ...process.env, CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "" },
    });
    const graph = JSON.parse(graphOut) as { fileEdges: { kind: string }[] };
    // Imports are regex-extracted in both tiers, so import edges must survive.
    expect(graph.fileEdges.some((e) => e.kind === "import")).toBe(true);
  });
});
