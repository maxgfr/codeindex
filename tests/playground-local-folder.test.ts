// Turning a folder the user picked into the same manifest the network path
// produces.
//
// The playground's whole design is "mount a manifest of paths WITH SIZES, let
// walk() choose, only then read bytes" (worker.js, PHASE A/B). A local folder
// fits that shape exactly — a File already knows its size without being read —
// so opening one reuses the entire pipeline and the only new logic is this
// mapping. Which is worth testing precisely because it is fiddly: the browser
// reports paths relative to the folder the user picked, so every path carries a
// leading segment that is not part of the repository.

import { describe, it, expect } from "vitest";

const LOCAL = new URL("../site/playground/local-folder.js", import.meta.url).href;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const { toManifest } = (await import(/* @vite-ignore */ LOCAL)) as Any;

/** A File stand-in — only the three fields the mapping reads. */
const picked = (webkitRelativePath: string, size = 10) => ({
  name: webkitRelativePath.split("/").pop(),
  size,
  webkitRelativePath,
});

describe("opening a local folder", () => {
  it("strips the picked folder from every path and names the repo after it", () => {
    const manifest = toManifest([
      picked("my-repo/package.json", 200),
      picked("my-repo/src/index.ts", 120),
      picked("my-repo/src/lib/util.ts", 80),
    ]);

    expect(manifest.name).toBe("my-repo");
    expect(manifest.files).toEqual([
      { path: "/package.json", size: 200, file: expect.anything() },
      { path: "/src/index.ts", size: 120, file: expect.anything() },
      { path: "/src/lib/util.ts", size: 80, file: expect.anything() },
    ]);
  });

  // Sizes are the point: walk() decides what to read from them, so a manifest
  // that lost them would send the pipeline back to reading everything.
  it("carries the size of every file without reading any of them", () => {
    const manifest = toManifest([picked("r/a.ts", 1), picked("r/big.ts", 2_000_000)]);
    expect(manifest.files.map((f: Any) => f.size)).toEqual([1, 2_000_000]);
  });

  it("keeps the original File so the bytes can be read later", () => {
    const file = picked("r/a.ts");
    expect(toManifest([file]).files[0].file).toBe(file);
  });

  // A folder whose entries do not all share a root is not a picked directory —
  // stripping a "common" segment there would eat a real one.
  it("strips nothing when the entries do not share a root", () => {
    const manifest = toManifest([picked("a/one.ts"), picked("b/two.ts")]);
    expect(manifest.files.map((f: Any) => f.path)).toEqual(["/a/one.ts", "/b/two.ts"]);
  });

  it("handles a plain multi-file selection, which carries no relative path", () => {
    const manifest = toManifest([
      { name: "index.ts", size: 5, webkitRelativePath: "" },
      { name: "other.ts", size: 6, webkitRelativePath: "" },
    ]);
    expect(manifest.files.map((f: Any) => f.path)).toEqual(["/index.ts", "/other.ts"]);
    expect(manifest.name).toBe("local files");
  });

  it("keeps a nested folder that happens to repeat the root's name", () => {
    const manifest = toManifest([picked("app/app/main.ts"), picked("app/README.md")]);
    expect(manifest.files.map((f: Any) => f.path)).toEqual(["/app/main.ts", "/README.md"]);
  });

  it("refuses an empty selection rather than mounting nothing", () => {
    expect(() => toManifest([])).toThrow(/no files/i);
  });
});
