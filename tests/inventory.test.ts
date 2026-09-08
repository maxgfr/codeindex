import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { walk, BINARY_EXT, type WalkSkip } from "../src/walk.js";
import { readTextEx, OffsetMap } from "../src/text.js";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "codeindex-inventory-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("retains source defaults and lets an inventory account for excluded paths", () => {
  const root = fixture();
  for (const [name, text] of Object.entries({ "a.ts": "export const x = 1", "icon.svg": "<svg><title>Hello</title></svg>", "yarn.lock": "lock", "big.txt": "x".repeat(200), ".gitignore": "ignored.txt", "ignored.txt": "secret" })) writeFileSync(join(root, name), text);
  mkdirSync(join(root, "nested", ".git"), { recursive: true });
  writeFileSync(join(root, "nested", "foreign.ts"), "foreign");
  symlinkSync("missing", join(root, "broken"));
  const skips: WalkSkip[] = [];
  const regular = walk(root, { maxFileBytes: 100, onSkip: x => skips.push(x) });
  expect(regular.files.map(x => x.rel)).toEqual([".gitignore", "a.ts"]);
  expect(skips).toEqual(expect.arrayContaining([
    expect.objectContaining({ rel: "icon.svg", reason: "binary-ext" }),
    expect.objectContaining({ rel: "yarn.lock", reason: "lockfile" }),
    expect.objectContaining({ rel: "big.txt", reason: "over-max-bytes" }),
    expect.objectContaining({ rel: "ignored.txt", reason: "gitignored" }),
    expect.objectContaining({ rel: "broken", reason: "broken-symlink" }),
    expect.objectContaining({ rel: "nested", reason: "nested-repo", directory: true }),
  ]));
  const inventory = walk(root, { maxFileBytes: 100, includeLockfiles: true, includeOversize: true, binaryExtensions: new Set([...BINARY_EXT].filter(x => x !== ".svg" && x !== ".lock")) });
  expect(inventory.files.map(x => x.rel)).toEqual([".gitignore", "a.ts", "big.txt", "icon.svg", "yarn.lock"]);
});

it("prunes consumer output before entering it and applies file filters before the cap", () => {
  const root = fixture();
  mkdirSync(join(root, "output")); writeFileSync(join(root, "output", "a.ts"), "generated");
  writeFileSync(join(root, "a.txt"), "skip"); writeFileSync(join(root, "b.ts"), "keep");
  const visited: string[] = [];
  const result = walk(root, { maxFiles: 1, filter: entry => { visited.push(entry.rel); return entry.directory ? entry.rel !== "output" : entry.rel.endsWith(".ts"); } });
  expect(result.files.map(x => x.rel)).toEqual(["b.ts"]); expect(result.capped).toBe(false);
  expect(visited).not.toContain("output/a.ts");
});

it("distinguishes empty, binary and unreadable and preserves byte coordinates", () => {
  const root = fixture();
  writeFileSync(join(root, "empty"), ""); writeFileSync(join(root, "binary"), Buffer.from([0, 1]));
  writeFileSync(join(root, "bom"), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("é😀")]));
  expect(readTextEx(join(root, "empty"))).toMatchObject({ ok: true, binary: false, text: "", bytes: 0 });
  expect(readTextEx(join(root, "missing"))).toMatchObject({ ok: false });
  expect(readTextEx(join(root, "binary"))).toMatchObject({ ok: true, binary: true });
  expect(readTextEx(join(root, "bom"))).toMatchObject({ text: "é😀", bodyStart: 3, byteAddressable: true });
  expect(new OffsetMap("é😀")).toBeDefined();
  writeFileSync(join(root, "utf16"), Buffer.concat([Buffer.from([255, 254]), Buffer.from("é", "utf16le")]));
  expect(readTextEx(join(root, "utf16"))).toMatchObject({ text: "é", encoding: "utf16le", byteAddressable: false });
});
