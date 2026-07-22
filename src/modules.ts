import { posix } from "node:path";
import type { FileRecord, Tier } from "./types.js";
import type { RepoScan } from "./scan.js";
import { slugify } from "./util.js";
import { sha1 } from "./hash.js";
import { byStr } from "./sort.js";

// A module is a directory's worth of files — the unit a developer thinks in
// ("src/lang is the language extractors"). Grouping by immediate parent dir is
// deterministic and maps cleanly onto how repos are organized.
export interface ModuleInfo {
  slug: string;
  path: string; // directory path, or "(root)" for top-level files
  title: string;
  tier: Tier;
  members: string[]; // member file rels, sorted
  summary: string;
}

const ROOT_PATH = "(root)";

// Foundations: shared building blocks features depend on (matched on the leaf).
const TIER0 = /(^|\/)(types?|util|utils|lib|libs|common|core|config|configs|constants|shared|helpers|internal)$/i;
// Tail: supporting material, not the product itself. Matched on ANY path
// segment — `a/__tests__/b` is still test material, not a feature. Covers both
// singular/plural jest dunder dirs and e2e suites.
const TIER2_ANY = /(^|\/)(tests?|__tests?__|__mocks?__|__snapshots?__|spec|specs|e2e|examples?|example|benchmark|benchmarks|fixtures?|docs?|documentation|\.github)(\/|$)/i;
// Scripts/CI only count as tail when they're the leaf (a `scripts/` dir), not
// when "scripts" merely appears mid-path.
const TIER2_LEAF = /(^|\/)(scripts?|bin|\.storybook)$/i;
// A file that is itself a test/spec/e2e, by basename — so a directory of only
// these is tail even when its own name is unconventional.
const TEST_FILE = /\.(test|spec|e2e|stories|story)\.[cm]?[jt]sx?$/i;

export function isTestFile(rel: string): boolean {
  return TEST_FILE.test(rel.split("/").pop()!);
}

function dirOf(rel: string): string {
  return rel.includes("/") ? posix.dirname(rel) : ROOT_PATH;
}

// Path-only tier decision; returns null when the path alone is undecided.
export function tierForPath(path: string): Tier | null {
  if (path === ROOT_PATH) return 0; // root manifests/READMEs are foundational context
  if (TIER2_ANY.test(path) || TIER2_LEAF.test(path)) return 2;
  if (TIER0.test(path)) return 0;
  return null;
}

function tierOf(path: string, members: FileRecord[]): Tier {
  const byPath = tierForPath(path);
  if (byPath !== null) return byPath;
  // A directory that is entirely docs/config/tests is tail material regardless
  // of its (unconventional) name.
  if (members.every((m) => m.kind === "doc" || m.kind === "config" || isTestFile(m.rel))) return 2;
  return 1;
}

// Deterministic one-line summary for a module, with no model involvement:
// prefer a directory README/index's own summary, else the richest member's
// doc-comment, else a structural fallback.
function summaryOf(path: string, members: FileRecord[]): string {
  const readme = members.find((m) => /^(readme|index)\.(md|mdx)$/i.test(m.rel.split("/").pop()!));
  if (readme?.summary) return readme.summary;
  if (readme?.title) return readme.title; // a README with only a title is still a better name than a file count
  const withSummary = members
    .filter((m) => m.summary)
    .sort((a, b) => (b.summary?.length ?? 0) - (a.summary?.length ?? 0));
  if (withSummary[0]?.summary) return withSummary[0].summary;
  const langs = [...new Set(members.map((m) => m.lang))].filter((l) => l !== "other");
  const where = path === ROOT_PATH ? "the repository root" : `\`${path}/\``;
  return `${members.length} file(s) in ${where}${langs.length ? ` (${langs.slice(0, 3).join(", ")})` : ""}.`;
}

// Group all scanned files into modules. Returns the modules (sorted by slug) and
// a rel → slug lookup the graph builder uses to lift file edges to module edges.
export function buildModules(scan: RepoScan): {
  modules: ModuleInfo[];
  moduleOf: Map<string, string>;
} {
  const byDir = new Map<string, FileRecord[]>();
  for (const f of scan.files) {
    const dir = dirOf(f.rel);
    let list = byDir.get(dir);
    if (!list) byDir.set(dir, (list = []));
    list.push(f);
  }

  const dirs = [...byDir.keys()].sort(byStr);
  // Slug per directory: slugify the path, but when that is empty (an all-non-ASCII
  // dir) or collides with another dir (slugify truncates at 120 chars, and two
  // packages can share a leaf dir name), append a short STABLE hash of the full
  // path. This keeps slugs injective AND order-independent — the slug is the
  // persistence key for human prose, and the old positional "module"/"-2" scheme
  // shuffled (re-gluing prose onto the wrong module) when a sibling changed.
  const baseOf = new Map<string, string>();
  const baseCount = new Map<string, number>();
  for (const dir of dirs) {
    const b = dir === ROOT_PATH ? "root" : slugify(dir);
    baseOf.set(dir, b);
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }
  const slugForDir = (dir: string): string => {
    const b = baseOf.get(dir)!;
    return b && baseCount.get(b) === 1 ? b : `${b || "module"}-${sha1(dir).slice(0, 8)}`;
  };

  const modules: ModuleInfo[] = [];
  const moduleOf = new Map<string, string>();
  for (const dir of dirs) {
    const members = byDir.get(dir)!.slice().sort((a, b) => byStr(a.rel, b.rel));
    const slug = slugForDir(dir);
    const info: ModuleInfo = {
      slug,
      path: dir,
      title: dir,
      tier: tierOf(dir, members),
      members: members.map((m) => m.rel),
      summary: summaryOf(dir, members),
    };
    modules.push(info);
    for (const m of members) moduleOf.set(m.rel, slug);
  }

  modules.sort((a, b) => byStr(a.slug, b.slug));
  return { modules, moduleOf };
}
