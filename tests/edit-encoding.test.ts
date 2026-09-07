import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { insertAfterSymbol, insertBeforeSymbol, replaceSymbolBody } from "../src/edit.js";
import { readText } from "../src/walk.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const formats = ["utf16le", "utf16be", "utf8bom", "latin1", "utf8"] as const;
function encode(text: string, format: typeof formats[number]): Buffer {
  if (format === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  if (format === "utf16be") return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
  if (format === "utf8bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
  return Buffer.from(text, format);
}
for (const format of formats) {
  describe(`${format} source edits`, () => {
    for (const newline of ["\n", "\r\n"]) {
      for (const operation of ["replace", "before", "after"] as const) {
        it(`${operation} preserves encoding, newline and untouched declarations (${JSON.stringify(newline)})`, () => {
          const root = mkdtempSync(join(tmpdir(), "codeindex-edit-encoding-")); roots.push(root);
          const file = join(root, "source.ts");
          const original = '// café\nexport function first() { return 1; }\n\nexport function second() { return 2; }\n';
          writeFileSync(file, encode(original.replaceAll("\n", newline), format));
          const scan = scanRepo(root);
          const body = 'export function added() { return "été"; }';
          if (operation === "replace") replaceSymbolBody(scan, "first", body, "source.ts");
          else if (operation === "before") insertBeforeSymbol(scan, "first", body, "source.ts");
          else insertAfterSymbol(scan, "first", body, "source.ts");
          const decoded = readText(file);
          expect(decoded).toContain('// café');
          expect(decoded).toContain('export function second() { return 2; }');
          expect(decoded).toContain(body);
          expect(readFileSync(file)).toEqual(encode(decoded, format));
          if (newline === "\r\n") expect(decoded.replaceAll("\r\n", "")).not.toContain("\n");
          expect(scanRepo(root).files[0]!.symbols.map((s) => s.name)).toContain("second");
        });
      }
    }
  });
}
it("rejects text unrepresentable in Latin-1 before changing the file", () => {
  const root = mkdtempSync(join(tmpdir(), "codeindex-edit-encoding-")); roots.push(root);
  const file = join(root, "source.ts");
  const before = encode('// café\nexport function first() { return 1; }\n', "latin1");
  writeFileSync(file, before);
  expect(() => replaceSymbolBody(scanRepo(root), "first", 'export function first() { return "😀"; }')).toThrow(/Latin-1/);
  expect(readFileSync(file)).toEqual(before);
});
it("rejects malformed odd-length UTF-16 before changing the file", () => {
  const root = mkdtempSync(join(tmpdir(), "codeindex-edit-encoding-")); roots.push(root);
  const file = join(root, "source.ts");
  const before = Buffer.concat([encode('export function first() { return 1; }\n', "utf16le"), Buffer.from([0])]);
  writeFileSync(file, before);
  expect(() => replaceSymbolBody(scanRepo(root), "first", 'export function first() { return 2; }')).toThrow(/UTF-16/);
  expect(readFileSync(file)).toEqual(before);
});
