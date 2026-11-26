// `npx skills add <owner>/<repo>` vendors an agent skill into
// `.agents/skills/<name>/`, adds a copy or a symlink per agent
// (`.claude/skills/<name>`, `.cursor/skills/<name>`…) and records it in a root
// `skills-lock.json`. Those directories are third-party, like vendor/: indexed,
// another project's SKILL.md and reference docs showed up in search, delta
// reports and module maps. A skill the lock does not list is the repo's own and
// stays indexed; the lock file itself is skipped like every other lock file.
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installedSkills, isInstalledSkillPath, walk, type WalkSkip } from "../src/walk.js";
import { buildIndexArtifacts } from "../src/pipeline.js";
import { grepRepo } from "../src/grep.js";
import { readDeltaDiff } from "../src/delta.js";
import { whyPath } from "../src/why.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

const lock = (...names: string[]): string =>
  JSON.stringify({
    version: 2,
    skills: Object.fromEntries(names.map((n) => [n, { source: `example-owner/${n}`, sourceType: "github", computedHash: "0" }])),
  });

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: skill ${name}\n---\n\n# ${name}\n\nMARKER_${name.replace(/-/g, "_")}\n`;

// An app, its own skill under .claude/skills, and two installed skills: the
// canonical copy under .agents/skills, a per-agent copy under .cursor/skills
// and a per-agent symlink under .claude/skills.
// `null` writes no lock file at all.
function fixture(lockText: string | null = lock("vendored-one", "vendored-two")): string {
  const root = mkdtempSync(join(tmpdir(), "ci-walk-skills-"));
  dirs.push(root);
  write(root, {
    "src/app.ts": "export function main(): string { return 'app'; }\n",
    ".claude/skills/own-skill/SKILL.md": SKILL("own-skill"),
    ".agents/skills/vendored-one/SKILL.md": SKILL("vendored-one"),
    ".agents/skills/vendored-one/references/guide.md": "# Guide\n\nMARKER_vendored_one_guide\n",
    ".agents/skills/vendored-one/scripts/run.ts": "export function vendoredRun(): number { return 1; }\n",
    ".agents/skills/vendored-two/SKILL.md": SKILL("vendored-two"),
    ".cursor/skills/vendored-two/SKILL.md": SKILL("vendored-two"),
    // A nested package's skills are first-party: the lock is read at the root
    // and only the root's dot-directories are vendored there.
    "packages/web/.agents/skills/vendored-one/SKILL.md": SKILL("vendored-one"),
    // A root `skills/` that is not a dot-directory is not where the CLI writes.
    "skills/vendored-one/SKILL.md": SKILL("vendored-one"),
  });
  symlinkSync(join(root, ".agents/skills/vendored-one"), join(root, ".claude/skills/vendored-one"), "dir");
  if (lockText !== null) writeFileSync(join(root, "skills-lock.json"), lockText);
  return root;
}

const rels = (root: string): string[] => walk(root).files.map((f) => f.rel).sort();

describe("agent skills installed from skills-lock.json", () => {
  it("skips every installed skill directory under a root dot-directory", () => {
    const root = fixture();
    const skips: WalkSkip[] = [];
    const files = walk(root, { onSkip: (s) => skips.push(s) }).files.map((f) => f.rel).sort();
    expect(files).toEqual([
      ".claude/skills/own-skill/SKILL.md",
      "packages/web/.agents/skills/vendored-one/SKILL.md",
      "skills/vendored-one/SKILL.md",
      "src/app.ts",
    ]);
    const installed = skips.filter((s) => s.reason === "installed-skill");
    expect(installed.map((s) => s.rel).sort()).toEqual([
      ".agents/skills/vendored-one",
      ".agents/skills/vendored-two",
      ".claude/skills/vendored-one",
      ".cursor/skills/vendored-two",
    ]);
    expect(installed.every((s) => s.directory)).toBe(true);
  });

  it("keeps a repo's own skills, absent from the lock", () => {
    const root = fixture(lock("vendored-one"));
    const files = rels(root);
    expect(files).toContain(".claude/skills/own-skill/SKILL.md");
    expect(files).toContain(".agents/skills/vendored-two/SKILL.md");
    expect(files).toContain(".cursor/skills/vendored-two/SKILL.md");
    expect(files.some((f) => f.startsWith(".agents/skills/vendored-one/"))).toBe(false);
  });

  it("skips skills-lock.json as a lock file", () => {
    const root = fixture();
    const skips: WalkSkip[] = [];
    walk(root, { onSkip: (s) => skips.push(s) });
    expect(skips.find((s) => s.rel === "skills-lock.json")?.reason).toBe("lockfile");
    expect(rels(root)).not.toContain("skills-lock.json");
  });

  it("tolerates a malformed, misshapen or missing lock file", () => {
    const everything = [
      ".agents/skills/vendored-one/SKILL.md",
      ".agents/skills/vendored-one/references/guide.md",
      ".agents/skills/vendored-one/scripts/run.ts",
      ".agents/skills/vendored-two/SKILL.md",
      ".claude/skills/own-skill/SKILL.md",
      ".cursor/skills/vendored-two/SKILL.md",
      "packages/web/.agents/skills/vendored-one/SKILL.md",
      "skills/vendored-one/SKILL.md",
      "src/app.ts",
    ];
    for (const text of [null, "", "{not json", "null", "[]", '{"skills":null}', '{"skills":["vendored-one"]}', '{"skills":"vendored-one"}']) {
      const root = fixture(text);
      expect(() => walk(root)).not.toThrow();
      expect(rels(root)).toEqual(everything);
      expect(installedSkills(root).size).toBe(0);
    }
    // A key that is not one path segment names no directory.
    const root = fixture(JSON.stringify({ skills: { "../src": {}, "a/b": {}, "..": {}, "": {} } }));
    expect(installedSkills(root).size).toBe(0);
    expect(rels(root)).toEqual(everything);
  });

  it("matches only `.<dir>/skills/<name>` and what lies under it", () => {
    const skills = new Set(["vendored-one"]);
    expect(isInstalledSkillPath(".agents/skills/vendored-one", skills)).toBe(true);
    expect(isInstalledSkillPath(".agents/skills/vendored-one/SKILL.md", skills)).toBe(true);
    expect(isInstalledSkillPath(".agents/skills/vendored-onex/SKILL.md", skills)).toBe(false);
    expect(isInstalledSkillPath(".agents/skills", skills)).toBe(false);
    expect(isInstalledSkillPath("skills/vendored-one/SKILL.md", skills)).toBe(false);
    expect(isInstalledSkillPath("pkg/.agents/skills/vendored-one/SKILL.md", skills)).toBe(false);
    expect(isInstalledSkillPath(".agents/other/vendored-one/SKILL.md", skills)).toBe(false);
  });

  it("keeps installed skills out of the index build and explains the skip", () => {
    const root = fixture();
    const { scan, symbols } = buildIndexArtifacts(root);
    expect(scan.files.map((f) => f.rel).some((r) => r.startsWith(".agents/") || r.startsWith(".cursor/"))).toBe(false);
    expect(JSON.stringify(symbols)).not.toContain("vendoredRun");
    const why = whyPath(root, ".agents/skills/vendored-one/references/guide.md");
    expect(why).toMatchObject({ indexed: false, reason: "installed-skill", detail: { dir: ".agents/skills/vendored-one", lockfile: "skills-lock.json" } });
  });

  it("grep's two backends leave installed skills out alike", () => {
    const root = fixture();
    const js = grepRepo(root, "MARKER_", { noRipgrep: true });
    expect([...new Set(js.map((h) => h.file))].sort()).toEqual([
      ".claude/skills/own-skill/SKILL.md",
      "packages/web/.agents/skills/vendored-one/SKILL.md",
      "skills/vendored-one/SKILL.md",
    ]);
    expect(grepRepo(root, "MARKER_")).toEqual(js);
  });

  it("delta does not review untracked installed skills", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-walk-skills-delta-"));
    dirs.push(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args]);
    git("init", "-q", "-b", "main");
    write(root, { "src/app.ts": "export const a = 1;\n" });
    git("add", "-A");
    git("commit", "-qm", "init");
    write(root, {
      "skills-lock.json": lock("vendored-one"),
      ".agents/skills/vendored-one/SKILL.md": SKILL("vendored-one"),
      ".claude/skills/own-skill/SKILL.md": SKILL("own-skill"),
    });
    const diff = readDeltaDiff(root);
    if ("error" in diff) throw new Error(diff.error);
    expect(diff.files.map((f) => f.path).sort()).toEqual([".claude/skills/own-skill/SKILL.md", "skills-lock.json"]);
  });

  // The cached `index` path reuses records by a walk of the tree: a skill the
  // lock starts listing leaves the next index instead of lingering in it.
  it("an incremental index drops a skill once the lock lists it", () => {
    const root = fixture(lock("vendored-two"));
    const out = join(root, ".codeindex");
    const index = () => {
      const res = spawnSync(process.execPath, [CLI, "index", "--repo", root, "--out", out], { encoding: "utf8", env: { ...process.env, CODEINDEX_EMBED_DIR: "" } });
      if (res.status !== 0) throw new Error(res.stderr);
      return readFileSync(join(out, "symbols.json"), "utf8");
    };
    expect(index()).toContain("vendoredRun");
    writeFileSync(join(root, "skills-lock.json"), lock("vendored-one", "vendored-two"));
    expect(index()).not.toContain("vendoredRun");
  });
});
