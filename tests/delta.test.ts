// `delta` against real temporary git repositories: what a removal breaks, what
// the diff side must ignore, and the CI gate.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokenImports, computeDelta, deltaFor, formatDeltaPanel, RISK_WEIGHTS } from "../src/delta.js";
import type { DeltaResult } from "../src/delta.js";
import { buildIndexArtifacts } from "../src/pipeline.js";

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

// A committed repo on `main`, so delta has a base to diff against.
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ci-delta-"));
  git(root, ["init", "-q", "-b", "main"]);
  write(root, files);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  return root;
}

function delta(root: string, opts: { staged?: boolean } = {}): DeltaResult {
  const { scan, graph, symbols } = buildIndexArtifacts(root);
  const res = deltaFor(root, graph, symbols, { ...opts, scan });
  if ("error" in res) throw new Error(res.error);
  return res;
}

// lib/hub.ts is imported by five files in three directories.
const HUB_REPO = {
  "lib/hub.ts": "export function hub(): number {\n  return 1;\n}\n",
  "lib/other.ts": "export const other = 2;\n",
  "app/a.ts": 'import { hub } from "../lib/hub";\nexport const a = hub();\n',
  "app/b.ts": 'import { hub } from "../lib/hub";\nexport const b = hub();\n',
  "app/c.ts": 'import { hub } from "../lib/hub";\nexport const c = hub();\n',
  "web/d.ts": 'import { hub } from "../lib/hub";\nexport const d = hub();\n',
  "web/e.ts": 'import { a } from "../app/a";\nexport const e = a;\n',
  "cli/f.ts": 'import { hub } from "../lib/hub";\nexport const f = hub();\n',
};

describe("delta: importers of a removed file", () => {
  it("scores the module a still-imported file was deleted from, naming its importers", () => {
    const root = repo(HUB_REPO);
    try {
      rmSync(join(root, "lib/hub.ts"));
      const res = delta(root);
      expect(res.deleted).toEqual(["lib/hub.ts"]);
      expect(res.broken.map((b) => b.from)).toEqual(["app/a.ts", "app/b.ts", "app/c.ts", "cli/f.ts", "web/d.ts"]);
      expect(res.broken.every((b) => b.target === "lib/hub.ts" && b.kind === "import" && b.renamedTo === undefined)).toBe(true);
      const lib = res.modules.find((m) => m.slug === "lib")!;
      expect(lib.reasons[0]).toBe("removed lib/hub.ts is still imported by 5 files (app/a.ts, app/b.ts, app/c.ts, …)");
      expect(lib.score).toBeGreaterThanOrEqual(RISK_WEIGHTS.brokenImport);
      expect(lib.changedFiles).toEqual(["lib/hub.ts"]);
      // The importers are the blast radius, and the ones to open.
      expect(lib.impact.directFiles).toBe(5);
      expect(lib.impact.transitiveFiles).toBe(6); // + web/e.ts through app/a.ts
      expect(lib.impact.modules).toEqual(["app", "cli", "web"]);
      expect(lib.open).toEqual(["app/a.ts", "app/b.ts", "app/c.ts"]);
      // Explained by the removal, so not repeated as an unexplained dangling import.
      expect(res.dangling).toEqual([]);
      expect(formatDeltaPanel(res)).toContain("broken:    lib/hub.ts still imported by app/a.ts, app/b.ts, app/c.ts, cli/f.ts, web/d.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says where a renamed file went, even when an importer changed too", () => {
    const root = repo(HUB_REPO);
    try {
      git(root, ["mv", "lib/hub.ts", "lib/core.ts"]);
      write(root, { "app/a.ts": 'import { hub } from "../lib/hub";\nexport const a = hub() + 1;\n' });
      const res = delta(root);
      expect(res.broken.filter((b) => b.from === "app/a.ts")).toEqual([
        { from: "app/a.ts", spec: "../lib/hub", kind: "import", target: "lib/hub.ts", renamedTo: "lib/core.ts" },
      ]);
      expect(res.dangling).toEqual([]);
      expect(res.modules.find((m) => m.slug === "lib")!.reasons[0]).toMatch(/^renamed lib\/hub\.ts \(now lib\/core\.ts\) is still imported by 5 files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scores a directory that is gone entirely under the slug it would have had", () => {
    const root = repo(HUB_REPO);
    try {
      rmSync(join(root, "lib"), { recursive: true });
      const res = delta(root);
      const lib = res.modules.find((m) => m.slug === "lib")!;
      expect(lib.path).toBe("lib");
      expect(lib.tests.status).toBe("n/a");
      expect(lib.reasons[0]).toMatch(/^removed lib\/hub\.ts is still imported by 5 files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds nothing broken when nobody imported the removed file", () => {
    const root = repo(HUB_REPO);
    try {
      rmSync(join(root, "lib/other.ts"));
      const res = delta(root);
      expect(res.broken).toEqual([]);
      expect(res.modules).toEqual([]);
      expect(res.deleted).toEqual(["lib/other.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-resolves against the live scan: a removed path re-created in place breaks nothing", () => {
    const root = repo(HUB_REPO);
    try {
      const { scan, graph } = buildIndexArtifacts(root);
      expect(brokenImports(scan, graph, [{ path: "lib/hub.ts" }])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("notes when no scan was supplied instead of silently skipping the trace", () => {
    const root = repo(HUB_REPO);
    try {
      rmSync(join(root, "lib/hub.ts"));
      const { graph, symbols } = buildIndexArtifacts(root);
      const res = deltaFor(root, graph, symbols) as DeltaResult;
      expect(res.broken).toEqual([]);
      expect(res.notes).toContain("no scan supplied — importers of removed files were not traced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps computeDelta pure: broken imports arrive as input", () => {
    const root = repo(HUB_REPO);
    try {
      rmSync(join(root, "lib/hub.ts"));
      const { graph, symbols } = buildIndexArtifacts(root);
      const base = { ref: "main", mergeBase: "0000000", staged: false };
      const files = [{ path: "lib/hub.ts", status: "deleted" as const }];
      expect(computeDelta(graph, symbols, { files, hunks: new Map(), base }).modules).toEqual([]);
      const broken = [{ from: "cli/f.ts", spec: "../lib/hub", kind: "import" as const, target: "lib/hub.ts" }];
      const res = computeDelta(graph, symbols, { files, hunks: new Map(), base, broken });
      expect(res.modules.map((m) => m.slug)).toEqual(["lib"]);
      expect(res.modules[0]!.impact).toEqual({ directFiles: 1, transitiveFiles: 1, modules: ["cli"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
