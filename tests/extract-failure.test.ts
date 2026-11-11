// A regex-tier extractor that throws leaves its file with no symbols. That used
// to look exactly like a file that declares nothing; the record now says so.
// Swift has no grammar, so its file always goes through the regex tier.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lang/swift.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lang/swift.js")>();
  return {
    swift: {
      ...real.swift,
      extract: (rel: string, content: string, masked?: string) => {
        if (content.includes("BOOM")) throw new Error("extractor bug");
        return real.swift.extract(rel, content, masked);
      },
    },
  };
});

const { scanRepo } = await import("../src/scan.js");
const { parseCacheEntries } = await import("../src/cache.js");
const { EXTRACTOR_VERSION, SCHEMA_VERSION } = await import("../src/types.js");

describe("a regex extractor that throws", () => {
  it("is recorded on the file, which keeps its other fields; a clean file is not flagged", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-extract-failure-"));
    writeFileSync(join(root, "bad.swift"), "// BOOM\nfunc area() -> Int { return 1 }\n");
    writeFileSync(join(root, "good.swift"), "func area() -> Int { return 1 }\n");
    const files = new Map(scanRepo(root).files.map((f) => [f.rel, f]));
    expect(files.get("bad.swift")).toMatchObject({ symbols: [], extractFailed: true, lang: "swift" });
    expect(files.get("good.swift")!.extractFailed).toBeUndefined();
    expect(files.get("good.swift")!.symbols.map((s) => s.name)).toEqual(["area"]);
  });

  it("the flag survives the cache, and nothing else is accepted in its place", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-extract-failure-"));
    writeFileSync(join(root, "bad.swift"), "// BOOM\n");
    const record = scanRepo(root).files[0]!;
    const cache = (r: unknown) => parseCacheEntries({ schemaVersion: SCHEMA_VERSION, extractorVersion: EXTRACTOR_VERSION, files: { "bad.swift": { hash: record.hash, record: r } } });
    expect(cache(record)?.get("bad.swift")?.record.extractFailed).toBe(true);
    expect(cache({ ...record, extractFailed: "yes" })).toBeUndefined();
  });
});
