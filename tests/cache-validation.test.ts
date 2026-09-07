import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readPersistedIndex, toCacheMap } from "../src/preload.js";
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
    for (const key of ["calls", "idents", "terms", "literals", "relations", "importedNames"] as const) delete entry.record[key];
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
    ["calls", [{ name: "run", line: 0 }]], ["idents", [1]], ["terms", {}],
    ["importedNames", [null]], ["truncated", "yes"], ["relations", [{ kind: "extends", from: "A", to: null, line: 1 }]],
    ["literals", [{ kind: "string", value: 10, line: 1 }]],
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
