import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo } from "../src/scan.js";
import { renderScip } from "../src/render/scip.js";
import { ENGINE_VERSION } from "../src/types.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const GOLDEN = fileURLToPath(new URL("./fixtures/scip/mini-repo.scip", import.meta.url));

// Fixed project_root so the bytes never depend on the machine's checkout path.
const PROJECT_ROOT = "file:///repo";
const render = (): Uint8Array => renderScip(scanRepo(REPO), { projectRoot: PROJECT_ROOT });

// ---------------------------------------------------------------------------
// A tiny protobuf reader (varint + length-delimited only) used to verify the
// encoded index without pulling in a dependency.
// ---------------------------------------------------------------------------
interface Field {
  field: number;
  wire: number;
  varint?: number;
  bytes?: Uint8Array;
}
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    const b = buf[p++]!;
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, p];
}
function decode(buf: Uint8Array, start = 0, end = buf.length): Field[] {
  const out: Field[] = [];
  let p = start;
  while (p < end) {
    let tag: number;
    [tag, p] = readVarint(buf, p);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, p] = readVarint(buf, p);
      out.push({ field, wire, varint: v });
    } else if (wire === 2) {
      let len: number;
      [len, p] = readVarint(buf, p);
      out.push({ field, wire, bytes: buf.subarray(p, p + len) });
      p += len;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}
const first = (fields: Field[], n: number): Field | undefined => fields.find((f) => f.field === n);
const allOf = (fields: Field[], n: number): Field[] => fields.filter((f) => f.field === n);
const str = (f: Field | undefined): string => (f?.bytes ? new TextDecoder().decode(f.bytes) : "");
const packedInts = (f: Field | undefined): number[] => {
  if (!f?.bytes) return [];
  const nums: number[] = [];
  let p = 0;
  while (p < f.bytes.length) {
    let v: number;
    [v, p] = readVarint(f.bytes, p);
    nums.push(v);
  }
  return nums;
};

describe("renderScip", () => {
  it("is deterministic: two scans + two renders are byte-identical", () => {
    const a = Buffer.from(render());
    const b = Buffer.from(render());
    expect(Buffer.compare(a, b)).toBe(0);
    expect(a.length).toBeGreaterThan(0);
  });

  it("encodes conformant metadata, documents, occurrences and symbols", () => {
    const scan = scanRepo(REPO);
    const buf = renderScip(scan, { projectRoot: PROJECT_ROOT });
    const index = decode(buf);

    // metadata.tool_info + text encoding + project_root
    const metadata = decode(first(index, 1)!.bytes!);
    const toolInfo = decode(first(metadata, 2)!.bytes!);
    expect(str(first(toolInfo, 1))).toBe("codeindex");
    expect(str(first(toolInfo, 2))).toBe(ENGINE_VERSION);
    expect(str(first(metadata, 3))).toBe(PROJECT_ROOT);
    expect(first(metadata, 4)?.varint).toBe(1); // TextEncoding.UTF8

    // one Document per code file with ≥1 symbol
    const documents = allOf(index, 2);
    const expectedDocs = scan.files.filter((f) => f.kind === "code" && f.symbols.length > 0);
    expect(documents.length).toBe(expectedDocs.length);
    expect(documents.length).toBeGreaterThan(0);

    let totalDefs = 0;
    let totalRefs = 0;
    const symbolPattern = /^codeindex \. \. \. `[^`]+`\/.+$/;

    for (const docField of documents) {
      const doc = decode(docField.bytes!);
      const rel = str(first(doc, 1));
      expect(rel.length).toBeGreaterThan(0);
      expect(rel.startsWith("/")).toBe(false); // path must be repo-relative
      expect(str(first(doc, 4)).length).toBeGreaterThan(0); // language

      // Every SymbolInformation in this document.
      const infoSymbols = new Set<string>();
      for (const siField of allOf(doc, 3)) {
        const si = decode(siField.bytes!);
        const symbol = str(first(si, 1));
        expect(symbol).toMatch(symbolPattern);
        expect(str(first(si, 6)).length).toBeGreaterThan(0); // display_name
        infoSymbols.add(symbol);
      }

      for (const occField of allOf(doc, 2)) {
        const occ = decode(occField.bytes!);
        const range = packedInts(first(occ, 1));
        expect(range.length).toBe(3); // [line, startChar, endChar]
        expect(range.every((n) => n >= 0)).toBe(true);
        expect(range[2]!).toBeGreaterThanOrEqual(range[1]!); // endChar >= startChar
        const symbol = str(first(occ, 2));
        expect(symbol).toMatch(symbolPattern);
        const roles = first(occ, 3)?.varint ?? 0;
        if (roles & 1) {
          totalDefs++;
          // every definition occurrence has a matching SymbolInformation here
          expect(infoSymbols.has(symbol)).toBe(true);
        } else {
          totalRefs++;
        }
      }
    }
    // The mini-repo has definitions in every document and a few cross-file refs.
    expect(totalDefs).toBeGreaterThan(0);
    expect(totalRefs).toBeGreaterThan(0);
  });

  it("declares UTF-16 position_encoding on every Document and locates ranges in UTF-16 code units", () => {
    // `café` (a 2-byte-in-UTF-8, 1-code-unit-in-UTF-16 character) sits BEFORE
    // `target` on the same declaration line, so a UTF-8 byte offset for
    // `target` would differ from its UTF-16 offset — this is what proves
    // `locate`/`findWord` (JS `indexOf`, i.e. UTF-16 code units) actually needs
    // `Document.position_encoding` declared.
    const root = mkdtempSync(join(tmpdir(), "scip-utf16-"));
    const line = 'export const café = "x", target = 1;\n';
    writeFileSync(join(root, "unicode.ts"), line);

    const scan = scanRepo(root);
    const buf = renderScip(scan, { projectRoot: PROJECT_ROOT });
    const index = decode(buf);
    const documents = allOf(index, 2);
    expect(documents.length).toBeGreaterThan(0);

    // (a) every Document carries position_encoding = UTF16CodeUnitOffsetFromLineStart (2)
    for (const docField of documents) {
      const doc = decode(docField.bytes!);
      expect(first(doc, 6)?.varint).toBe(2);
    }

    // (b) `target`'s decoded startChar is the UTF-16 (JS `.indexOf`) offset,
    // and it differs from what a UTF-8-byte-offset consumer would compute.
    let targetRange: number[] | undefined;
    for (const occField of allOf(decode(documents[0]!.bytes!), 2)) {
      const occ = decode(occField.bytes!);
      if (str(first(occ, 2)).includes("target")) {
        targetRange = packedInts(first(occ, 1));
        break;
      }
    }
    expect(targetRange).toBeDefined();

    const utf16StartChar = line.indexOf("target");
    const utf8StartChar = Buffer.byteLength(line.slice(0, utf16StartChar), "utf8");
    expect(utf16StartChar).not.toBe(utf8StartChar); // fixture actually exercises the divergence
    expect(targetRange![1]).toBe(utf16StartChar);
    expect(targetRange![1]).not.toBe(utf8StartChar);
  });

  it("matches the committed golden index byte-for-byte", () => {
    const buf = Buffer.from(render());
    // Regenerate the golden after an intentional encoder/mapping change with:
    //   CODEINDEX_UPDATE_SCIP_GOLDEN=1 pnpm vitest run tests/scip.test.ts
    if (process.env.CODEINDEX_UPDATE_SCIP_GOLDEN) {
      writeFileSync(GOLDEN, buf);
      return;
    }
    expect(existsSync(GOLDEN)).toBe(true);
    expect(Buffer.compare(buf, readFileSync(GOLDEN))).toBe(0);
  });

  it("CLI `scip` writes a non-empty index identical to renderScip", () => {
    const out = join(mkdtempSync(join(tmpdir(), "scip-cli-")), "index.scip");
    // Both sides use the tree-sitter AST tier: the CLI warms grammars by default,
    // and tests/setup.ts warms them for the in-process renderScip above, so the
    // two extraction paths — and thus the bytes — line up.
    execFileSync(
      process.execPath,
      [CLI, "scip", "--repo", REPO, "--out", out, "--project-root", PROJECT_ROOT],
      { encoding: "utf8" },
    );
    const cliBytes = readFileSync(out);
    expect(cliBytes.length).toBeGreaterThan(0);
    expect(Buffer.compare(cliBytes, Buffer.from(render()))).toBe(0);
  });

  // Opt-in external validation with the official `scip` binary. Point at it with
  // CODEINDEX_SCIP_BIN=<path> (or have `scip` on PATH); skipped otherwise.
  const scipBin = process.env.CODEINDEX_SCIP_BIN ?? "scip";
  const scipAvailable = (): boolean => {
    try {
      execFileSync(scipBin, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  it.skipIf(!scipAvailable())("passes `scip stats` (>0 occurrences) and `scip lint`", () => {
    const out = join(mkdtempSync(join(tmpdir(), "scip-bin-")), "index.scip");
    writeFileSync(out, render());
    const stats = execFileSync(scipBin, ["stats", "--from", out], { encoding: "utf8" });
    const parsed = JSON.parse(stats) as { occurrences?: number; documents?: number };
    expect(parsed.occurrences ?? 0).toBeGreaterThan(0);
    // lint must not fail fatally (non-zero exit throws).
    execFileSync(scipBin, ["lint", out], { encoding: "utf8", stdio: "pipe" });
  });
});
