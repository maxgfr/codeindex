import { afterEach, expect, it } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteMemory, listMemories, readMemory, writeMemory } from "../src/memory.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const boundary of [".codeindex", "memories", "topic", "file"] as const) {
  it(`rejects ${boundary} symlinks without touching outside files`, () => {
    const root = mkdtempSync(join(tmpdir(), "codeindex-memory-boundary-")); roots.push(root);
    const repo = join(root, "repo"), outside = join(root, "outside"); mkdirSync(repo); mkdirSync(outside);
    const destination = join(outside, ...(boundary === ".codeindex" ? ["memories", "topic"] : boundary === "memories" ? ["topic"] : []));
    mkdirSync(destination, { recursive: true }); const note = join(destination, "note.md"); writeFileSync(note, "outside original\n");
    const link = join(repo, ...(boundary === ".codeindex" ? [".codeindex"] : boundary === "memories" ? [".codeindex", "memories"] : boundary === "topic" ? [".codeindex", "memories", "topic"] : [".codeindex", "memories", "topic", "note.md"]));
    mkdirSync(join(link, ".."), { recursive: true }); symlinkSync(boundary === "file" ? note : outside, link);
    expect(readMemory(repo, "topic/note")).toBeUndefined();
    expect(() => writeMemory(repo, "topic/note", "changed")).toThrow(/symlink|symbolic/i);
    expect(() => deleteMemory(repo, "topic/note")).toThrow(/symlink|symbolic/i);
    expect(listMemories(repo)).not.toContain("topic/note");
    expect(readFileSync(note, "utf8")).toBe("outside original\n");
  });
}
it("supports nested memories and a symlinked repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "codeindex-memory-safe-")); roots.push(root);
  const repo = join(root, "repo"), alias = join(root, "alias"); mkdirSync(repo); symlinkSync(repo, alias);
  expect(writeMemory(alias, "topic/note", "hello")).toBe("topic/note");
  expect(readMemory(alias, "topic/note")).toBe("hello\n"); expect(listMemories(alias)).toEqual(["topic/note"]);
  expect(deleteMemory(alias, "topic/note")).toBe(true); expect(existsSync(join(repo, ".codeindex", "memories", "topic", "note.md"))).toBe(false);
});

it("rejects hard-linked memories without exposing or changing shared files", () => {
  const root = mkdtempSync(join(tmpdir(), "codeindex-memory-hardlink-")); roots.push(root);
  const repo = join(root, "repo"), outside = join(root, "outside.md");
  mkdirSync(join(repo, ".codeindex", "memories", "topic"), { recursive: true });
  writeFileSync(outside, "outside original\n");
  const note = join(repo, ".codeindex", "memories", "topic", "note.md");
  linkSync(outside, note);
  expect(readMemory(repo, "topic/note")).toBeUndefined();
  expect(() => writeMemory(repo, "topic/note", "changed")).toThrow(/hard link/i);
  expect(() => deleteMemory(repo, "topic/note")).toThrow(/hard link/i);
  expect(listMemories(repo)).not.toContain("topic/note");
  expect(readFileSync(outside, "utf8")).toBe("outside original\n");
  expect(readFileSync(note, "utf8")).toBe("outside original\n");
  writeMemory(repo, "topic/own", "owned");
  expect(listMemories(repo)).toEqual(["topic/own"]);
  expect(readMemory(repo, "topic/own")).toBe("owned\n");
});
