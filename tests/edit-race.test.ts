// A file another writer changes between the moment an edit reads it and the
// moment it writes: the edit is refused instead of overwriting that change with
// an edit of the previous content. The reader is wrapped so the change lands
// at exactly that moment, which no real race can be timed to.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

let afterRead: ((abs: string) => void) | undefined;
vi.mock("../src/text.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/text.js")>();
  return {
    ...real,
    readTextEx: (abs: string) => {
      const read = real.readTextEx(abs);
      const hook = afterRead;
      afterRead = undefined;
      hook?.(abs);
      return read;
    },
  };
});

const { scanRepo } = await import("../src/scan.js");
const { insertAfterSymbol, replaceSymbolBody } = await import("../src/edit.js");

describe("an edit never overwrites a change made while it was prepared", () => {
  const src = "export function a(): number {\n  return 1;\n}\n";

  it("refuses, leaving the other writer's change on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-edit-race-"));
    const file = join(root, "x.ts");
    writeFileSync(file, src);
    const scan = scanRepo(root);
    const theirs = src + "// saved by an editor meanwhile\n";
    afterRead = (abs) => writeFileSync(abs, theirs);
    expect(() => replaceSymbolBody(scan, "a", "export function a(): number {\n  return 2;\n}", "x.ts")).toThrow(
      /edit refused, nothing written: x\.ts changed while the edit was prepared/,
    );
    expect(readFileSync(file, "utf8")).toBe(theirs);
  });

  it("writes as before when nothing changed in between", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-edit-race-"));
    const file = join(root, "x.ts");
    writeFileSync(file, src);
    const scan = scanRepo(root);
    insertAfterSymbol(scan, "a", "export const b = 2;", "x.ts");
    expect(readFileSync(file, "utf8")).toContain("export const b = 2;");
  });
});
