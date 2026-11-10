import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { renderGraphJson } from "../src/render/graph-json.js";
import { renderSymbolsJson } from "../src/render/symbols-json.js";

// The extraction-losslessness gate: ultraindex 5.1.0's committed bundle built
// tests/fixtures/mini-repo (copied outside any git worktree, so `commit` is
// absent) and the exact graph.json/symbols.json bytes were pinned under
// tests/compat/. The engine, stamped with ultraindex's version/schema via
// `meta`, must reproduce them byte-for-byte — proving the core moved here
// without a behavior change. Regenerate the pins ONLY for an adjudicated,
// documented behavior change (see the versioning rules in README.md).
//
// Regenerated since, each time for one such change and nothing else:
//   - the three recall gaps the ctags differential named (dea75aa);
//   - `lines` (EXTRACTOR_VERSION 21): the newline ending a file's last line is
//     no longer counted as one more line. 13 of the 14 nodes lose exactly 1;
//     no other byte of either pin moved.
const EXPECTED_GRAPH = fileURLToPath(new URL("./compat/ultraindex-5.1.0-graph.json", import.meta.url));
const EXPECTED_SYMBOLS = fileURLToPath(new URL("./compat/ultraindex-5.1.0-symbols.json", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

describe("ultraindex 5.1.0 byte compatibility", () => {
  it("reproduces graph.json and symbols.json byte-for-byte", () => {
    const repo = join(mkdtempSync(join(tmpdir(), "ci-compat-")), "mini-repo");
    cpSync(FIXTURE, repo, { recursive: true });
    const { graph, symbols } = buildIndexArtifacts(repo, {
      meta: { version: "5.1.0", schemaVersion: 4 },
    });
    expect(renderGraphJson(graph)).toBe(readFileSync(EXPECTED_GRAPH, "utf8"));
    expect(renderSymbolsJson(symbols)).toBe(readFileSync(EXPECTED_SYMBOLS, "utf8"));
  });
});
