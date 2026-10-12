import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walk } from "../src/walk.js";

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ci-walk-"));
  for (const rel of files) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), "x\n");
  }
  return root;
}

describe("walk order", () => {
  it("lists a directory's files, then its subdirectories in name order", () => {
    const root = tree(["z.ts", "c/1.ts", "a/1.ts", "b/1.ts", "a/sub/2.ts", "a/0.ts"]);
    expect(walk(root).files.map((f) => f.rel)).toEqual(["z.ts", "a/0.ts", "a/1.ts", "a/sub/2.ts", "b/1.ts", "c/1.ts"]);
  });

  it("a --max-files cap keeps the beginning of the alphabet", () => {
    const root = tree(["z.ts", "c/1.ts", "a/1.ts", "b/1.ts"]);
    const res = walk(root, { maxFiles: 2 });
    expect(res.files.map((f) => f.rel)).toEqual(["z.ts", "a/1.ts"]);
    expect(res.capped).toBe(true);
  });
});
