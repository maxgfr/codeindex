import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as engine from "../src/engine.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../scripts/engine.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

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
  "grammarKeysForExts",
  "grammarKeyForExt",
  "grammarReady",
  "extractAst",
  // grammars resolution + pull/cache tier (v2.14.0)
  "resolveGrammarsDir",
  "resolveGrammarsTier",
  "sharedGrammarsCacheDir",
  "DEFAULT_GRAMMARS_URL",
  "resolveGrammarsPullTarget",
  "fetchGrammarsTarball",
  "fetchExpectedSha256",
  "extractTarInto",
  "extractGrammarsTarball",
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
  "buildRawCallerIndex",
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
  "searchIndex",
  "subtokens",
  "checkRules",
  "parseRules",
  "changeCoupling",
  "rankHotspots",
  "renderRepoMap",
  "findDeadCode",
  "symbolComplexity",
  "riskHotspots",
  "complexityOfSource",
  "renderMermaid",
  "symbolsOverview",
  "findSymbol",
  "findReferences",
  "resolveUniqueSymbol",
  "replaceSymbolBody",
  "insertAfterSymbol",
  "insertBeforeSymbol",
  "writeMemory",
  "readMemory",
  "deleteMemory",
  "listMemories",
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
  "runCli",
  "runMcpServer",
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
    execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });

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

describe("index command (single pass + incremental cache)", () => {
  it("writes graph.json + symbols.json + cache.json; warm rebuild is byte-identical", () => {
    const out = join(mkdtempSync(join(tmpdir(), "ci-index-")), "out");
    const run = () =>
      execFileSync(process.execPath, [CLI, "index", "--repo", REPO, "--out", out], { encoding: "utf8" });
    run();
    const cold = engine.readText(join(out, "graph.json"));
    const coldSymbols = engine.readText(join(out, "symbols.json"));
    expect(cold.length).toBeGreaterThan(0);
    expect(engine.readText(join(out, "cache.json"))).toContain('"extractorVersion"');
    run(); // warm — must reuse the cache and reproduce the exact bytes
    expect(engine.readText(join(out, "graph.json"))).toBe(cold);
    expect(engine.readText(join(out, "symbols.json"))).toBe(coldSymbols);
  });
});

describe("index fastpath", () => {
  // CODEINDEX_EMBED_DIR is neutralized so a dev shell's model never turns the
  // embed leg of the guard on for these runs.
  const ENV = { ...process.env, CODEINDEX_EMBED_DIR: "" };
  const runIndex = (repo: string, out: string): void => {
    execFileSync(process.execPath, [CLI, "index", "--repo", repo, "--out", out], { encoding: "utf8", env: ENV });
  };
  const freshOut = (): string => join(mkdtempSync(join(tmpdir(), "ci-fastpath-")), "out");
  // A mutable copy of the fixture: content/mtime edits must never touch the
  // shared checkout. The copy is not a git worktree — commit is absent on both
  // sides of the guard, which must still fastpath.
  const freshRepo = (): string => {
    const dir = join(mkdtempSync(join(tmpdir(), "ci-fastpath-repo-")), "repo");
    cpSync(REPO, dir, { recursive: true });
    return dir;
  };

  it("warm rerun is byte-identical and rewrites nothing", () => {
    const out = freshOut();
    runIndex(REPO, out);
    const graph = engine.readText(join(out, "graph.json"));
    const symbols = engine.readText(join(out, "symbols.json"));
    const graphMtime = statSync(join(out, "graph.json")).mtimeMs;
    const symbolsMtime = statSync(join(out, "symbols.json")).mtimeMs;
    const cacheMtime = statSync(join(out, "cache.json")).mtimeMs;
    const res = spawnSync(process.execPath, [CLI, "index", "--repo", REPO, "--out", out], { encoding: "utf8", env: ENV });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("(unchanged — artifacts reused)");
    expect(engine.readText(join(out, "graph.json"))).toBe(graph);
    expect(engine.readText(join(out, "symbols.json"))).toBe(symbols);
    // Reused, not rewritten: the artifacts AND the clean cache keep their mtimes.
    expect(statSync(join(out, "graph.json")).mtimeMs).toBe(graphMtime);
    expect(statSync(join(out, "symbols.json")).mtimeMs).toBe(symbolsMtime);
    expect(statSync(join(out, "cache.json")).mtimeMs).toBe(cacheMtime);
  });

  it("a bare touch leaves artifacts untouched but refreshes cache.json's mtime key", () => {
    const repo = freshRepo();
    const out = freshOut();
    runIndex(repo, out);
    const graphMtime = statSync(join(out, "graph.json")).mtimeMs;
    const symbolsMtime = statSync(join(out, "symbols.json")).mtimeMs;
    const target = join(repo, "src", "util.ts");
    const later = new Date(Date.now() + 5000);
    utimesSync(target, later, later);
    const touched = statSync(target).mtimeMs;
    runIndex(repo, out);
    expect(statSync(join(out, "graph.json")).mtimeMs).toBe(graphMtime);
    expect(statSync(join(out, "symbols.json")).mtimeMs).toBe(symbolsMtime);
    const cache = JSON.parse(engine.readText(join(out, "cache.json"))) as {
      files: Record<string, { mtimeMs?: number }>;
    };
    expect(cache.files["src/util.ts"]!.mtimeMs).toBe(touched);
  });

  it("a content edit rebuilds, byte-identical to a cold build into a fresh out dir", () => {
    const repo = freshRepo();
    const warm = freshOut();
    runIndex(repo, warm);
    runIndex(repo, warm); // reach the fastpath state first
    appendFileSync(join(repo, "src", "util.ts"), "\nexport function fastpathProbe(): number {\n  return 42;\n}\n");
    runIndex(repo, warm); // guard must fail → full rebuild
    const cold = freshOut();
    runIndex(repo, cold);
    expect(engine.readText(join(warm, "symbols.json"))).toContain("fastpathProbe");
    expect(engine.readText(join(warm, "graph.json"))).toBe(engine.readText(join(cold, "graph.json")));
    expect(engine.readText(join(warm, "symbols.json"))).toBe(engine.readText(join(cold, "symbols.json")));
  });

  it("a corrupted graph.json is repaired on the next run", () => {
    const out = freshOut();
    runIndex(REPO, out);
    const coldGraph = engine.readText(join(out, "graph.json"));
    writeFileSync(join(out, "graph.json"), "{ corrupted\n");
    runIndex(REPO, out); // sha mismatch → full path rewrites the artifact
    expect(engine.readText(join(out, "graph.json"))).toBe(coldGraph);
  });

  it("an old-format cache.json without meta keys rebuilds without crashing and gains them", () => {
    const out = freshOut();
    runIndex(REPO, out);
    const parsed = JSON.parse(engine.readText(join(out, "cache.json"))) as Record<string, unknown>;
    // Strip the meta keys — exactly what a cache written by an older engine looks like.
    writeFileSync(
      join(out, "cache.json"),
      JSON.stringify({
        schemaVersion: parsed.schemaVersion,
        extractorVersion: parsed.extractorVersion,
        files: parsed.files,
      }) + "\n",
    );
    const coldGraph = engine.readText(join(out, "graph.json"));
    const graphMtime = statSync(join(out, "graph.json")).mtimeMs;
    runIndex(REPO, out);
    expect(engine.readText(join(out, "graph.json"))).toBe(coldGraph);
    // It really took the full path (rewrote the artifact) — never the fastpath.
    expect(statSync(join(out, "graph.json")).mtimeMs).not.toBe(graphMtime);
    const after = JSON.parse(engine.readText(join(out, "cache.json"))) as {
      engineVersion?: string;
      graphSha1?: string;
      symbolsSha1?: string;
    };
    expect(after.engineVersion).toBe(engine.ENGINE_VERSION);
    expect(after.graphSha1).toMatch(/^[0-9a-f]{40}$/);
    expect(after.symbolsSha1).toMatch(/^[0-9a-f]{40}$/);
  });

  // The embed leg of the guard deliberately checks embedVersion + modelId ON
  // TOP of the sidecar sha: after a model swap the on-disk embeddings.bin
  // still matches the OLD run's sha, so a sha-only guard would fastpath and
  // silently reuse vectors computed by the wrong model. Each sub-condition
  // gets a tripwire below so a future "simplification" back to sha-only
  // cannot land unnoticed.
  const MODEL_DIR = fileURLToPath(new URL("./fixtures/embed-model", import.meta.url));
  const MODEL_ENV = { ...process.env, CODEINDEX_EMBED_DIR: MODEL_DIR };
  const runIndexWith = (env: NodeJS.ProcessEnv, out: string) =>
    spawnSync(process.execPath, [CLI, "index", "--repo", REPO, "--out", out], { encoding: "utf8", env });

  it("warm rerun with a model fastpaths and leaves embeddings.bin untouched", () => {
    const out = freshOut();
    expect(runIndexWith(MODEL_ENV, out).status).toBe(0);
    const bin = readFileSync(join(out, "embeddings.bin"));
    const binMtime = statSync(join(out, "embeddings.bin")).mtimeMs;
    const res = runIndexWith(MODEL_ENV, out);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain("(unchanged — artifacts reused)");
    // Reused, not rewritten: same bytes AND the file was never re-opened for write.
    expect(statSync(join(out, "embeddings.bin")).mtimeMs).toBe(binMtime);
    expect(readFileSync(join(out, "embeddings.bin")).equals(bin)).toBe(true);
  });

  it("a model swap fails the embed leg and rebuilds embeddings.bin with the new model", () => {
    const out = freshOut();
    expect(runIndexWith(MODEL_ENV, out).status).toBe(0);
    const oldBin = readFileSync(join(out, "embeddings.bin"));
    // Same weights, different identity — exactly the case a sha-only guard
    // would wrongly fastpath (the on-disk bin still matches the old meta sha).
    const swappedDir = mkdtempSync(join(tmpdir(), "ci-fastpath-model-"));
    const model = JSON.parse(engine.readText(join(MODEL_DIR, "model.json"))) as { modelId: string };
    model.modelId = "codeindex-fixture-tiny-8d-swapped";
    writeFileSync(join(swappedDir, "model.json"), JSON.stringify(model));
    const res = runIndexWith({ ...process.env, CODEINDEX_EMBED_DIR: swappedDir }, out);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("(unchanged — artifacts reused)");
    expect(res.stderr).toContain("model codeindex-fixture-tiny-8d-swapped");
    expect(readFileSync(join(out, "embeddings.bin")).equals(oldBin)).toBe(false);
    const cache = JSON.parse(engine.readText(join(out, "cache.json"))) as { embed?: { modelId?: string } };
    expect(cache.embed?.modelId).toBe("codeindex-fixture-tiny-8d-swapped");
  });

  it("a corrupted embeddings.bin fails the sha sub-condition and is repaired byte-identical", () => {
    const out = freshOut();
    expect(runIndexWith(MODEL_ENV, out).status).toBe(0);
    const cold = readFileSync(join(out, "embeddings.bin"));
    writeFileSync(join(out, "embeddings.bin"), "corrupted");
    const res = runIndexWith(MODEL_ENV, out); // sidecar sha mismatch → full path
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("(unchanged — artifacts reused)");
    expect(readFileSync(join(out, "embeddings.bin")).equals(cold)).toBe(true);
  });

  it("a cache claiming a different embedVersion fails the guard and rebuilds", () => {
    const out = freshOut();
    expect(runIndexWith(MODEL_ENV, out).status).toBe(0);
    const cachePath = join(out, "cache.json");
    const tampered = JSON.parse(engine.readText(cachePath)) as { embed?: { embedVersion?: number } };
    tampered.embed!.embedVersion = 0; // an incompatible sidecar format
    writeFileSync(cachePath, JSON.stringify(tampered) + "\n");
    const bin = readFileSync(join(out, "embeddings.bin"));
    const res = runIndexWith(MODEL_ENV, out);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toContain("(unchanged — artifacts reused)");
    // The full path re-derives the identical bin and heals the meta.
    expect(readFileSync(join(out, "embeddings.bin")).equals(bin)).toBe(true);
    const after = JSON.parse(engine.readText(cachePath)) as { embed?: { embedVersion?: number } };
    expect(after.embed?.embedVersion).toBe(engine.EMBED_VERSION);
  });
});

describe("no-wasm mode (vendored consumer layout)", () => {
  it("the bundle alone — no grammars sidecar — still indexes via the regex tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-nowasm-"));
    const lone = join(dir, "engine.mjs");
    copyFileSync(BUNDLE, lone);
    copyFileSync(CLI, join(dir, "cli.mjs"));
    const out = execFileSync(process.execPath, [join(dir, "cli.mjs"), "symbols", "--repo", REPO], {
      encoding: "utf8",
      // Neutralize the env override a dev shell might carry.
      env: { ...process.env, CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "" },
    });
    const parsed = JSON.parse(out) as { defs: Record<string, unknown> };
    expect(Object.keys(parsed.defs).length).toBeGreaterThan(0);

    const graphOut = execFileSync(process.execPath, [join(dir, "cli.mjs"), "graph", "--repo", REPO], {
      encoding: "utf8",
      env: { ...process.env, CODEINDEX_GRAMMAR_DIR: "", ULTRAINDEX_GRAMMAR_DIR: "" },
    });
    const graph = JSON.parse(graphOut) as { fileEdges: { kind: string }[] };
    // Imports are regex-extracted in both tiers, so import edges must survive.
    expect(graph.fileEdges.some((e) => e.kind === "import")).toBe(true);
  });
});

// Capture everything runCli writes to stdout while it runs (it emits via
// process.stdout.write), restoring the real writer afterwards.
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  return chunks.join("");
}

describe("selective grammar warming (T7)", () => {
  it("grammarKeysForExts maps through EXT_GRAMMAR, dedupes and sorts", () => {
    // Mixed set → one key per language, sorted by grammar key.
    expect(engine.grammarKeysForExts([".ts", ".tsx", ".py", ".go"])).toEqual(["go", "python", "tsx", "typescript"]);
    // Every TS-family extension collapses onto the single `typescript` key.
    expect(engine.grammarKeysForExts([".ts", ".mts", ".cts"])).toEqual(["typescript"]);
    // Extensions with no committed grammar (docs, json, unsupported langs) drop out.
    expect(engine.grammarKeysForExts([".ts", ".md", ".json", ".swift"])).toEqual(["typescript"]);
    // Empty in → empty out; the mapping is a pure function of the extension set.
    expect(engine.grammarKeysForExts([])).toEqual([]);
  });

  it("`graph` via runCli — warming only the .ts/.py/.go present — is byte-identical to an all-grammars in-proc build", async () => {
    // The CLI now walks once, warms only the languages the walk saw, and reuses
    // that walk for the scan (precomputedWalk). The rendered graph must match a
    // direct build (this process has every grammar warmed via tests/setup.ts, so
    // any divergence would be the precomputed-walk threading, not a missing tier).
    const viaCli = await captureStdout(() => engine.runCli(["graph", "--repo", REPO]));
    const inProc = engine.renderGraphJson(engine.buildIndexArtifacts(REPO).graph);
    expect(viaCli.length).toBeGreaterThan(0);
    expect(viaCli).toBe(inProc);
  });
});
