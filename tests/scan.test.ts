import { describe, it, expect, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo, type RepoScan } from "../src/scan.js";
import { walk } from "../src/walk.js";
import type { FileRecord } from "../src/types.js";
import { extractMarkdown } from "../src/extract/markdown.js";
import { extractCode } from "../src/extract/code.js";

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

describe("scanRepo", () => {
  const scan = scanRepo(REPO);
  const byRel = new Map(scan.files.map((f) => [f.rel, f]));

  it("classifies code, docs and config", () => {
    expect(byRel.get("src/client.ts")?.kind).toBe("code");
    expect(byRel.get("README.md")?.kind).toBe("doc");
    expect(byRel.get("docs/guide.md")?.kind).toBe("doc");
    expect(byRel.get("tsconfig.json")?.kind).toBe("config");
    expect(byRel.get("go.mod")?.kind).toBe("config");
  });

  it("extracts a markdown title, summary and local links", () => {
    const readme = byRel.get("README.md")!;
    expect(readme.title).toBe("Mini Repo");
    expect(readme.summary).toContain("polyglot");
    const links = readme.refs.map((r) => r.spec);
    expect(links).toContain("docs/guide.md");
    expect(links).toContain("docs/api.md");
  });

  it("extracts code symbols and import specifiers", () => {
    const client = byRel.get("src/client.ts")!;
    expect(client.symbols.find((s) => s.name === "HttpClient")).toMatchObject({
      kind: "class",
      exported: true,
    });
    const specs = client.refs.map((r) => r.spec);
    expect(specs).toContain("./util.js");
    expect(specs).toContain("@/helpers");
  });

  it("produces a deterministic (sorted) file list and a language histogram", () => {
    const rels = scan.files.map((f) => f.rel);
    expect([...rels]).toEqual([...rels].sort());
    expect(scan.languages.typescript).toBeGreaterThan(0);
    expect(scan.languages.python).toBeGreaterThan(0);
    expect(scan.languages.go).toBeGreaterThan(0);
  });
});

describe("scanRepo — change-tracking flags", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // Build the cache exactly the way the `index` command persists it: one entry
  // per kept file, keyed by rel, carrying (hash, record, size, mtimeMs).
  function cacheOf(scan: RepoScan): Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }> {
    const m = new Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }>();
    for (const f of scan.files) m.set(f.rel, { hash: f.hash, record: f, size: f.size, mtimeMs: scan.mtimes.get(f.rel) });
    return m;
  }

  // Fresh writable copy of the fixture + its run-1 scan/cache, per test — no
  // cross-test mutation leaks.
  function setup(): { root: string; cache: Map<string, { hash: string; record: FileRecord; size?: number; mtimeMs?: number }> } {
    const dir = mkdtempSync(join(tmpdir(), "ci-scan-flags-"));
    dirs.push(dir);
    const root = join(dir, "mini-repo");
    cpSync(REPO, root, { recursive: true });
    return { root, cache: cacheOf(scanRepo(root)) };
  }

  it("reports contentUnchanged + clean cache when nothing changed since run 1", () => {
    const { root, cache } = setup();
    const rescan = scanRepo(root, { cache });
    expect(rescan.contentUnchanged).toBe(true);
    expect(rescan.cacheDirty).toBe(false);
  });

  it("a bare mtime touch keeps content unchanged but dirties the cache", () => {
    const { root, cache } = setup();
    const past = new Date(2000, 0, 1); // distinct fixed mtime — content untouched
    utimesSync(join(root, "src", "client.ts"), past, past);
    const rescan = scanRepo(root, { cache });
    expect(rescan.contentUnchanged).toBe(true); // hash re-proved identical
    expect(rescan.cacheDirty).toBe(true); // but the persisted mtimeMs changes
  });

  it("a content edit clears contentUnchanged", () => {
    const { root, cache } = setup();
    appendFileSync(join(root, "src", "client.ts"), "\nexport const edited = 1;\n");
    const rescan = scanRepo(root, { cache });
    expect(rescan.contentUnchanged).toBe(false);
    expect(rescan.cacheDirty).toBe(true);
  });

  it("a file add clears contentUnchanged", () => {
    const { root, cache } = setup();
    writeFileSync(join(root, "src", "extra.ts"), "export const extra = 1;\n");
    const rescan = scanRepo(root, { cache });
    expect(rescan.contentUnchanged).toBe(false);
    expect(rescan.cacheDirty).toBe(true);
  });

  it("a file delete clears contentUnchanged", () => {
    const { root, cache } = setup();
    rmSync(join(root, "src", "client.ts"));
    const rescan = scanRepo(root, { cache });
    expect(rescan.contentUnchanged).toBe(false);
    expect(rescan.cacheDirty).toBe(true);
  });

  it("a doc edit clears contentUnchanged (docs stay on the exact hash path)", () => {
    const { root, cache } = setup();
    appendFileSync(join(root, "README.md"), "\nEdited prose.\n");
    const rescan = scanRepo(root, { cache });
    expect(rescan.contentUnchanged).toBe(false);
    expect(rescan.cacheDirty).toBe(true);
  });

  it("no cache supplied → contentUnchanged=false, cacheDirty=true", () => {
    const { root } = setup();
    const rescan = scanRepo(root);
    expect(rescan.contentUnchanged).toBe(false);
    expect(rescan.cacheDirty).toBe(true);
  });

  it("precomputedWalk yields a scan identical to walking internally", () => {
    const { root, cache } = setup();
    const direct = scanRepo(root, { cache });
    const precomputed = scanRepo(root, { cache, precomputedWalk: walk(root, {}) });
    expect(precomputed.files).toEqual(direct.files);
    expect(precomputed.contentUnchanged).toBe(direct.contentUnchanged);
    expect(precomputed.cacheDirty).toBe(direct.cacheDirty);
    expect(precomputed.capped).toBe(direct.capped);
    expect(precomputed.excluded).toBe(direct.excluded);
  });
});

describe("extractMarkdown", () => {
  it("ignores links inside fenced code blocks", () => {
    const md = "# T\n\n```\n[x](./inside.md)\n```\n\n[y](./outside.md)\n";
    const info = extractMarkdown(md);
    const specs = info.refs.map((r) => r.spec);
    expect(specs).toContain("./outside.md");
    expect(specs).not.toContain("./inside.md");
  });
  it("drops external links and anchors", () => {
    const info = extractMarkdown("[a](https://x.com) [b](#frag) [c](./rel.md)");
    const specs = info.refs.map((r) => r.spec);
    expect(specs).toEqual(["./rel.md"]);
  });
});

describe("extractCode", () => {
  it("reads the top doc-comment as a summary", () => {
    const info = extractCode("x.ts", ".ts", "// The widget factory. Builds widgets.\nexport function make() {}");
    expect(info.summary).toBe("The widget factory.");
  });
  it("skips eslint/pragma directive comments", () => {
    const onlyDirective = extractCode("x.ts", ".ts", "/* eslint @typescript-eslint/naming-convention: 0 */\nexport const x = 1;");
    expect(onlyDirective.summary).toBeUndefined();
    const directiveThenProse = extractCode("x.ts", ".ts", "// eslint-disable-next-line\n// Parses the config file.\nexport function p() {}");
    expect(directiveThenProse.summary).toBe("Parses the config file.");
  });
});

describe("extractMarkdown — badges", () => {
  it("does not use a badge/image-only line as the summary", () => {
    const info = extractMarkdown("# Project\n\n[![Quality Status](https://x/badge.svg)](https://x/ci)\n\nThe real description of the project.");
    expect(info.summary).toBe("The real description of the project.");
    expect(info.summary).not.toContain("Quality");
  });
});
