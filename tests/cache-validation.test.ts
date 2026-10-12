import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readPersistedIndex, toCacheMap } from "../src/preload.js";
import { extractedAlike } from "../src/cache.js";
import { scanRepo } from "../src/scan.js";
import { EXTRACTOR_VERSION, SCHEMA_VERSION } from "../src/types.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const scan = scanRepo(FIXTURE);
const files = Object.fromEntries(toCacheMap(scan));
const REL = "src/client.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-cache-validation-"));
  dirs.push(dir);
  return dir;
}

function cache() {
  return { schemaVersion: SCHEMA_VERSION, extractorVersion: EXTRACTOR_VERSION, files: structuredClone(files) };
}

function readCache(value: unknown) {
  const dir = scratch();
  mkdirSync(join(dir, ".codeindex"));
  writeFileSync(join(dir, ".codeindex/cache.json"), JSON.stringify(value));
  return readPersistedIndex(dir);
}

describe("persisted cache validation", () => {
  it("accepts a current cache and old entries without optional stat/extraction fields", () => {
    const current = cache();
    expect(readCache(current)?.cacheMap).toEqual(toCacheMap(scan));
    const entry = current.files[REL]!;
    delete entry.size;
    delete entry.mtimeMs;
    for (const key of ["calls", "idents", "terms", "literals", "relations", "importedNames", "importAliases"] as const) delete entry.record[key];
    expect(readCache(current)?.cacheMap.get(REL)).toEqual(entry);
  });

  it.each([null, [], "files", 1].map((value) => [value]))("rejects an invalid files container: %j", (value) => {
    expect(readCache({ ...cache(), files: value })).toBeUndefined();
  });

  it.each([null, {}, { record: {} }, { hash: "bad" }])("rejects incomplete entries: %j", (value) => {
    expect(readCache({ ...cache(), files: { ...files, [REL]: value } })).toBeUndefined();
  });

  it.each([
    ["rel", "src/other.ts"], ["hash", "0".repeat(40)], ["ext", null], ["kind", "invalid"],
    ["lang", 42], ["size", -1], ["lines", "10"], ["title", {}],
    ["headings", [null]], ["symbols", null], ["symbols", [{}]], ["refs", [{ kind: "import", spec: null }]],
    ["refs", [{ kind: "import", spec: ".util", soft: "yes" }]],
    ["calls", [{ name: "run", line: 0 }]], ["idents", [1]], ["terms", {}],
    ["importedNames", [null]], ["truncated", "yes"], ["relations", [{ kind: "extends", from: "A", to: null, line: 1 }]],
    ["importAliases", [{ local: "b", name: 1, from: "./a.js" }]], ["importAliases", [{ local: "b", name: "a", from: null }]],
    ["literals", [{ kind: "string", value: 10, line: 1 }]], ["generated", "obfuscated"],
  ])("rejects a malformed record field %s", (field, value) => {
    const current = cache();
    Object.assign(current.files[REL]!.record, { [field]: value });
    expect(readCache(current)).toBeUndefined();
  });

  it.each([["size", 0], ["mtimeMs", "today"], ["hash", "bad"]])("rejects entry metadata %s", (field, value) => {
    const current = cache();
    Object.assign(current.files[REL]!, { [field]: value });
    expect(readCache(current)).toBeUndefined();
  });

  it.each(["../client.ts", "/client.ts", "src/./client.ts", "src//client.ts"])("rejects noncanonical paths: %s", (rel) => {
    const entry = structuredClone(files[REL]!);
    entry.record.rel = rel;
    entry.record.symbols = [];
    expect(readCache({ ...cache(), files: { [rel]: entry } })).toBeUndefined();
  });

  it.each(["file", "line", "endLine", "exported", "parent"])("rejects malformed symbol %s", (field) => {
    const current = cache();
    Object.assign(current.files[REL]!.record.symbols[0]!, { [field]: field === "file" ? "elsewhere.ts" : null });
    expect(readCache(current)).toBeUndefined();
  });

  it("rejects incompatible schema/extractor versions", () => {
    expect(readCache({ ...cache(), schemaVersion: -1 })).toBeUndefined();
    expect(readCache({ ...cache(), extractorVersion: -1 })).toBeUndefined();
  });
});

describe("malformed cache through the shipped CLI", () => {
  it("read commands and index rebuild instead of trusting a stat-matching incomplete record", { timeout: 30_000 }, () => {
    const repo = join(scratch(), "repo");
    cpSync(FIXTURE, repo, { recursive: true });
    const out = join(repo, ".codeindex");
    const run = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8" });
    run("index", "--out", out);
    const path = join(out, "cache.json");
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.files[REL].record = {};
    writeFileSync(path, JSON.stringify(current));
    expect(run("callers")).toBe(run("callers", "--no-index-cache"));
    expect(run("symbols")).toBe(run("symbols", "--no-index-cache"));
    run("index", "--out", out);
    expect(run("symbols")).toBe(run("symbols", "--no-index-cache"));
    expect(readPersistedIndex(repo)?.cacheMap.get(REL)?.record.symbols.length).toBeGreaterThan(0);
  });
});

describe("what the cache may reuse", () => {
  it("a .vue/.svelte/.astro or .h record extracted at another tier is not reused", () => {
    const regexTier = extractedAlike({ grammars: [] }, { ast: () => true });
    for (const ext of [".vue", ".svelte", ".astro", ".h", ".ts"]) expect(regexTier("code", ext), ext).toBe(false);
    // A header extracted with C alone, now that C++ is loaded too.
    expect(extractedAlike({ grammars: ["c"] }, { ast: () => true })("code", ".h")).toBe(false);
    const loaded = ["c", "cpp", "javascript", "typescript"];
    const same = extractedAlike({ grammars: loaded }, { ast: (k) => loaded.includes(k) });
    for (const ext of [".vue", ".svelte", ".h", ".ts"]) expect(same("code", ext), ext).toBe(true);
  });

  it("index after an --no-ast index re-extracts a single-file component", { timeout: 60_000 }, () => {
    const repo = scratch();
    // The regex tier sees the class; only the AST tier sees its members.
    writeFileSync(
      join(repo, "comp.vue"),
      '<script setup lang="ts">\nexport class Store {\n  count = 0;\n  bump(by: number): number {\n    return this.count + by;\n  }\n}\n</script>\n',
    );
    const out = join(scratch(), "idx");
    const run = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8", stdio: "pipe" });
    run("index", "--out", out, "--no-ast");
    run("index", "--out", out);
    const fresh = join(scratch(), "fresh");
    run("index", "--out", fresh, "--no-index-cache");
    expect(readFileSync(join(out, "symbols.json"), "utf8")).toBe(readFileSync(join(fresh, "symbols.json"), "utf8"));
  });

  // A filesystem with 1 s timestamps, simulated: both writes and the index land
  // in one second, so the edit keeps the size and mtime cache.json recorded.
  it("a same-size edit in the tick the index was written in is seen", { timeout: 60_000 }, () => {
    const repo = scratch();
    const file = join(repo, "a.ts");
    const out = join(scratch(), "idx");
    const run = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8", stdio: "pipe" });
    const tick = Math.floor(Date.now() / 1000) - 10;
    writeFileSync(file, "export const a = 1;\n");
    utimesSync(file, tick, tick);
    run("index", "--out", out);
    utimesSync(join(out, "cache.json"), tick, tick);
    writeFileSync(file, "export const b = 2;\n");
    utimesSync(file, tick, tick);
    run("index", "--out", out);
    expect(Object.keys((JSON.parse(readFileSync(join(out, "symbols.json"), "utf8")) as { defs: object }).defs)).toEqual(["b"]);
  });

  it("an old mtime is persisted, so an unchanged tree takes the stat fastpath", () => {
    const repo = scratch();
    const file = join(repo, "a.ts");
    writeFileSync(file, "export const a = 1;\n");
    const old = Date.now() / 1000 - 3600;
    utimesSync(file, old, old);
    const first = scanRepo(repo);
    expect(first.mtimes.get("a.ts")).toBe(statSync(file).mtimeMs);
    const second = scanRepo(repo, { cache: toCacheMap(first) });
    expect(second.contentUnchanged).toBe(true);
    expect(second.cacheDirty).toBe(false);
  });

  it("an --out spelled with '..' segments is still left out of the scan", () => {
    const repo = scratch();
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(repo, "idx"));
    writeFileSync(join(repo, "idx", "graph.json"), "{}\n");
    mkdirSync(join(repo, "sub"));
    const scan = scanRepo(repo, { out: `${repo}/sub/../idx` }); // as a library caller may pass it
    expect(scan.files.map((f) => f.rel)).toEqual(["a.ts"]);
  });
});
