import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The pinned real-world corpus shared by the opt-in e2e suites
// (`e2e-real-repos` builds and ratchets each one, `e2e-commands` runs every
// command against it). Each repo is pinned by commit: re-pin deliberately,
// never float, so upstream churn can't move a threshold.

export const CACHE = fileURLToPath(new URL("./.e2e-cache", import.meta.url));

export interface RealRepo {
  slug: string; // owner/name on GitHub
  sha: string; // pinned commit — re-pin deliberately, never float
  maxDanglingRatio: number; // ratchet: dangling / total edges must stay below
  primaryLang: string; // symbols.json must contain defs in this language
  // A resolved import edge that must exist (from-prefix, to-prefix) — the
  // regression teeth proving resolution actually worked here.
  crossEdge?: [RegExp, RegExp];
  budgetMs: number; // generous wall-clock ceiling for one cold build
}

export const REPOS: RealRepo[] = [
  {
    // Yarn workspaces + Next.js app dir (the original adversarial-audit anchor).
    slug: "socialgouv/code-du-travail-numerique",
    sha: "886297ad7ce94d6377863d8fbf88e24f696dd3b7",
    maxDanglingRatio: 0.002,
    primaryLang: "typescript",
    crossEdge: [/^packages\/code-du-travail-frontend\//, /^packages\/(?!code-du-travail-frontend\/)/],
    budgetMs: 120_000,
  },
  {
    // Turborepo + pnpm; packages route subpaths through conditional `exports`.
    slug: "t3-oss/create-t3-turbo",
    sha: "8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee",
    maxDanglingRatio: 0.02,
    primaryLang: "typescript",
    crossEdge: [/^apps\//, /^packages\//],
    budgetMs: 120_000,
  },
  {
    // Canonical Nx layout: root tsconfig.base.json carrying the @org/* aliases.
    slug: "nrwl/nx-examples",
    sha: "0808ace9640cdae6fbbc9b000292383ea6d78c9f",
    maxDanglingRatio: 0.01,
    primaryLang: "typescript",
    crossEdge: [/^apps\//, /^libs\//],
    budgetMs: 120_000,
  },
  {
    // Python: package imports, src layout.
    slug: "pallets/flask",
    sha: "36e4a824f340fdee7ed50937ba8e7f6bc7d17f81",
    maxDanglingRatio: 0.01, // measured baseline: 0/582 edges
    primaryLang: "python",
    crossEdge: [/^tests\//, /^src\/flask\//],
    budgetMs: 120_000,
  },
  {
    // Go: module-rooted imports via go.mod.
    slug: "gin-gonic/gin",
    sha: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    maxDanglingRatio: 0.03, // measured baseline: 5/267 edges (1.87%)
    primaryLang: "go",
    budgetMs: 120_000,
  },
  {
    // Rust: cargo workspace (crates/*), mod/use resolution.
    slug: "BurntSushi/ripgrep",
    sha: "59e318f5ace48db54f37bb67c152535bc17fa153",
    maxDanglingRatio: 0.01, // measured baseline: 0/619 edges
    primaryLang: "rust",
    crossEdge: [/^crates\/core\//, /^crates\/(?!core\/)/],
    budgetMs: 120_000,
  },
  {
    // Large Gradle multi-project: Java + Kotlin across config/core/web modules.
    // Added after the stabilization audit as an independent real-world proof,
    // not one of the repositories used to design the fixes.
    slug: "spring-projects/spring-security",
    sha: "61feae94a04ab78ede3aa7c5c97b1b0e993cca48",
    maxDanglingRatio: 0.001, // measured baseline: 0/48,146 edges
    primaryLang: "java",
    crossEdge: [/^config\//, /^core\//],
    budgetMs: 120_000,
  },
  // ---- Pinned 2026-10-12 for the real-world command campaign: one repo per
  // language family the engine claims, each an independent proof (none of them
  // was used to design a resolver). Ratios measured at the pin.
  {
    // Ruby: bare `require` against lib roots, across sinatra-contrib.
    slug: "sinatra/sinatra",
    sha: "cb22afd7902b566b6eaba6c4ea89739494a65d12",
    maxDanglingRatio: 0.005, // measured baseline: 0/593 edges
    primaryLang: "ruby",
    crossEdge: [/^sinatra-contrib\/lib\//, /^lib\/sinatra/],
    budgetMs: 120_000,
  },
  {
    // C#: namespace `using` resolution across src/ and test/ projects.
    slug: "jbogard/MediatR",
    sha: "916ef1b3d68ccdc96db8f914eaf1b32fc7db52c5",
    maxDanglingRatio: 0.005, // measured baseline: 0/894 edges
    primaryLang: "csharp",
    crossEdge: [/^test\/MediatR\.Tests\//, /^src\/MediatR\//],
    budgetMs: 120_000,
  },
  {
    // C: quoted includes; vendored decNumber/oniguruma reached through -I flags
    // the build system holds (missing-include, a documented limit).
    slug: "jqlang/jq",
    sha: "80fc7a169d3a3942a07f587abc4346d119fc525d",
    maxDanglingRatio: 0.025, // measured: 5/252 edges (1.98%) — generated .inc files and -I vendor paths
    primaryLang: "c",
    crossEdge: [/^src\/.*\.c$/, /^src\/.*\.h$/],
    budgetMs: 120_000,
  },
  {
    // C++: include/fmt headers (`.h` read as C++); gtest lives behind a CMake
    // include dir (missing-include, a documented limit).
    slug: "fmtlib/fmt",
    sha: "b4ffa39b9994c961418406f47358791d89a5aa48",
    maxDanglingRatio: 0.055, // measured baseline: 28/555 edges (5.05%)
    primaryLang: "cpp",
    crossEdge: [/^test\//, /^include\/fmt\//],
    budgetMs: 120_000,
  },
  {
    // Vue + TS pnpm monorepo; VitePress docs.
    slug: "vuejs/pinia",
    sha: "f48737e9aaffcb63c70c0f4f2c977e91be657fcb",
    maxDanglingRatio: 0.03, // measured baseline: 24/830 edges (2.89%)
    primaryLang: "typescript",
    crossEdge: [/^packages\/testing\//, /^packages\/pinia\//],
    budgetMs: 120_000,
  },
  {
    // Svelte + SvelteKit: `$lib` alias, generated `./$types`.
    slug: "sveltejs/realworld",
    sha: "df796708040f5200ec572b28ab7f88ecee5794dd",
    maxDanglingRatio: 0.03, // measured: 1/45 edges (2.2%); 11/27 (40.7%) before $lib and ./$types resolved
    primaryLang: "svelte",
    crossEdge: [/^src\/routes\//, /^src\/lib\//],
    budgetMs: 120_000,
  },
  {
    // PHP: composer PSR-4 autoload.
    slug: "slimphp/Slim",
    sha: "3675bf6baac66b07032575b7bef4200b60b7974b",
    maxDanglingRatio: 0.005, // measured baseline: 1/631 edges (vendor/autoload.php)
    primaryLang: "php",
    crossEdge: [/^tests\//, /^Slim\//],
    budgetMs: 120_000,
  },
  {
    // Kotlin-first Gradle multi-project with Java and mkdocs docs.
    slug: "square/okhttp",
    sha: "42e5888d45623662c138ed27e80ea28bbe0aa5cc",
    maxDanglingRatio: 0.002, // measured baseline: 6/6,032 edges (0.10%)
    primaryLang: "kotlin",
    crossEdge: [/^samples\/guide\//, /^okhttp\/src\//],
    budgetMs: 120_000,
  },
  {
    // Go: nested modules (sdk/metric, exporters/otlp/... each with a go.mod).
    slug: "open-telemetry/opentelemetry-go",
    sha: "033fcebbc46e03bb7671e2bd7088212c8d6281e7",
    maxDanglingRatio: 0.003, // measured baseline: 16/6,844 edges (0.23%)
    primaryLang: "go",
    crossEdge: [/^exporters\/otlp\//, /^sdk\/metric\//],
    budgetMs: 120_000,
  },
  {
    // Elixir: module aliases onto lib/.
    slug: "elixir-plug/plug",
    sha: "73404f851852a00ffb2014be95d4598900fa77b8",
    maxDanglingRatio: 0.005, // measured baseline: 0/284 edges
    primaryLang: "elixir",
    crossEdge: [/^test\/plug\//, /^lib\/plug\//],
    budgetMs: 120_000,
  },
  {
    // Lua: `require("lazy.core.x")` onto lua/.
    slug: "folke/lazy.nvim",
    sha: "306a05526ada86a7b30af95c5cc81ffba93fef97",
    maxDanglingRatio: 0.005, // measured baseline: 0/409 edges
    primaryLang: "lua",
    crossEdge: [/^tests\//, /^lua\/lazy\//],
    budgetMs: 120_000,
  },
  {
    // Scala: Mill layout with version-specific source dirs (src-2, src-3).
    slug: "com-lihaoyi/os-lib",
    sha: "86e5ddb65fe62305afb5885fcc0f8da50aba4b48",
    maxDanglingRatio: 0.005, // measured baseline: 0/290 edges
    primaryLang: "scala",
    crossEdge: [/^os\/test\//, /^os\/src\//],
    budgetMs: 120_000,
  },
];

// Shallow-fetch the pinned commit into the cache; re-runs are offline. The
// history is kept HISTORY_DEPTH deep so the git-reading commands (delta --base
// HEAD~5, churn, hotspots, coupling) have commits to compare against.
export const HISTORY_DEPTH = 30;
export function clonePinned(repo: RealRepo): string {
  const dir = join(CACHE, `${repo.slug.replace("/", "__")}@${repo.sha.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("remote", "add", "origin", `https://github.com/${repo.slug}`);
  git("fetch", "-q", "--depth", String(HISTORY_DEPTH), "origin", repo.sha);
  git("checkout", "-q", "FETCH_HEAD");
  return dir;
}
