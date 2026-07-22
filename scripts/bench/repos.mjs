// Pinned target repos for the competitor benchmark harness.
//
// The six primary repos reuse the EXACT slugs + SHAs from
// tests/e2e-real-repos.test.ts and share its on-disk clone cache
// (tests/.e2e-cache/<owner__name>@<sha12>), so a bench run reuses whatever the
// e2e suite already fetched — no double clone. next.js is added for parity with
// 01x-in/codeindex's own published figure (init cold 121_037 ms for 11_064
// indexed files, April 2026); its SHA is pinned here and re-pinned deliberately.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CLI_PATH = fileURLToPath(new URL("../cli.mjs", import.meta.url));
export const ENGINE_URL = new URL("../engine.mjs", import.meta.url);
const CACHE = fileURLToPath(new URL("../../tests/.e2e-cache", import.meta.url));

// `symbol` is the representative identifier for the query scenario. Where a
// confident public name exists it is pinned; the two dense TS monorepos are left
// to the deterministic auto-pick (see pickSymbol) since no single name is
// obviously canonical. Any pinned name that a build fails to extract also falls
// back to the auto-pick, so a stale pin degrades to a real symbol, never a crash.
export const REPOS = [
  {
    slug: "socialgouv/code-du-travail-numerique",
    sha: "886297ad7ce94d6377863d8fbf88e24f696dd3b7",
    lang: "typescript",
    symbol: undefined, // auto-pick
  },
  {
    slug: "t3-oss/create-t3-turbo",
    sha: "8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee",
    lang: "typescript",
    symbol: undefined, // auto-pick
  },
  {
    slug: "nrwl/nx-examples",
    sha: "0808ace9640cdae6fbbc9b000292383ea6d78c9f",
    lang: "typescript",
    symbol: undefined, // auto-pick
  },
  {
    slug: "pallets/flask",
    sha: "36e4a824f340fdee7ed50937ba8e7f6bc7d17f81",
    lang: "python",
    symbol: "Flask",
  },
  {
    slug: "gin-gonic/gin",
    sha: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    lang: "go",
    symbol: "New",
  },
  {
    slug: "BurntSushi/ripgrep",
    sha: "59e318f5ace48db54f37bb67c152535bc17fa153",
    lang: "rust",
    symbol: "WalkBuilder",
  },
  {
    // Pinned 2026-07-22 from repos/vercel/next.js/commits/canary. Big repo:
    // marked `slow` so scenarios that spawn a >60s run downgrade to fewer runs.
    slug: "vercel/next.js",
    sha: "203177bb7505837801281c7d1eb008519a242010",
    lang: "typescript",
    symbol: "NextResponse",
    slow: true,
    // Reference figures published by 01x-in for comparison (not asserted here):
    ref01x: { coldMs: 121037, files: 11064 },
  },
];

export function reposFor(sel) {
  if (!sel || sel === "all") return REPOS.slice();
  const hit = REPOS.filter((r) => r.slug === sel);
  if (!hit.length) throw new Error(`unknown repo slug: ${sel} (use one of ${REPOS.map((r) => r.slug).join(", ")} or 'all')`);
  return hit;
}

// Shallow-fetch the pinned commit into the shared e2e cache; re-runs are offline.
// Identical strategy to tests/e2e-real-repos.test.ts so the cache is shared.
export function clonePinned(repo) {
  const dir = join(CACHE, `${repo.slug.replace("/", "__")}@${repo.sha.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/${repo.slug}`);
  git("fetch", "-q", "--depth", "1", "origin", repo.sha);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}

// Deterministic representative symbol: honour `preferred` when the build
// actually extracted it, else pick the most-referenced defined name (tie-break:
// most defs, then lexicographic). Guarantees a real symbol for the query row.
export function pickSymbol(symbols, preferred) {
  const defs = symbols.defs ?? {};
  const refs = symbols.refs ?? {};
  if (preferred && defs[preferred]) return preferred;
  const names = Object.keys(defs);
  if (!names.length) return preferred ?? "";
  names.sort((a, b) => {
    const ra = (refs[a]?.length ?? 0), rb = (refs[b]?.length ?? 0);
    if (rb !== ra) return rb - ra;
    const da = defs[a].length, db = defs[b].length;
    if (db !== da) return db - da;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return names[0];
}
