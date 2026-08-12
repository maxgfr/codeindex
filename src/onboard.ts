// One call that tells an agent what this repository IS.
//
// Every piece already existed — scanSummary, detectWorkspaces, renderRepoMap,
// rankHotspots, the memory store — and an agent arriving in an unfamiliar
// codebase spent four or five round trips assembling them by hand, differently
// each time. This composes them once, deterministically, in the order the
// answers are actually needed: how big, what language, how it is laid out, what
// the important files are, where the work concentrates.
//
// It writes a memory by default because the second session should not pay for
// the first one's reading. That is the whole value of the memory store, and
// nothing was using it on the way in.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RepoScan } from "./scan.js";
import type { Graph } from "./types.js";
import { renderRepoMap } from "./repomap.js";
import { detectWorkspaces } from "./workspaces.js";
import { rankHotspots } from "./coupling.js";
import { gitChurn } from "./git.js";
import { writeMemory } from "./memory.js";
import { byStr } from "./sort.js";

export interface OnboardOptions {
  /** Token budget for the repo-map section (default 900). */
  budgetTokens?: number;
  /** Persist the brief as a memory (default true). */
  remember?: boolean;
  /** Memory name (default "onboarding"). */
  memoryName?: string;
}

export interface OnboardBrief {
  /** The rendered brief, markdown. */
  brief: string;
  /** Where it was persisted, when it was. */
  memory?: string;
}

const README_NAMES = ["README.md", "README.markdown", "README.rst", "README.txt", "README"];

/**
 * The repository's own one-line self-description, when it has one.
 *
 * Taken from the README's first non-heading, non-badge paragraph, because the
 * first LINE is usually the project name repeated and the badges below it are
 * noise an agent should never have to read past.
 */
function tagline(root: string): string | undefined {
  for (const name of README_NAMES) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const raw of text.split(/\n\s*\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("<")) continue;
      // A badge paragraph is entirely links and images.
      if (/^(\[!\[|!\[|\[)/.test(line) && !/[.:]\s/.test(line)) continue;
      const cleaned = line
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.length > 20) return cleaned.slice(0, 400);
    }
    break;
  }
  return undefined;
}

/**
 * Compose a project brief from the analyses this engine already computes.
 *
 * Deterministic apart from the git section, which is skipped wholesale when
 * this is not a git checkout rather than emitted empty — a heading with nothing
 * under it reads as "no churn", which is a different claim from "not measured".
 */
export function onboardBrief(scan: RepoScan, graph: Graph, opts: OnboardOptions = {}): OnboardBrief {
  const lines: string[] = [];
  // resolve() first: scan.root is whatever the caller passed, and `.` would
  // otherwise title the brief "# .".
  const name = resolve(scan.root).replace(/\/+$/, "").split("/").pop() || "repository";

  lines.push(`# ${name}`, "");
  const summary = tagline(scan.root);
  if (summary) lines.push(summary, "");

  // Size and languages, most-used first — the shape of what follows.
  const languages = Object.entries(graph.languages)
    .sort((a, b) => b[1] - a[1] || byStr(a[0], b[0]))
    .slice(0, 6)
    .map(([lang, count]) => `${lang} ${count}`)
    .join(", ");
  lines.push(`**${graph.fileCount} indexed files** · ${languages}`, "");

  // Layout. A monorepo is the single fact that most changes how a codebase is
  // navigated, so it goes above everything but the size.
  const workspaces = detectWorkspaces(scan.root);
  if (workspaces.packages.length > 1) {
    lines.push(`## Layout — monorepo, ${workspaces.packages.length} packages`, "");
    for (const pkg of workspaces.packages.slice(0, 20)) lines.push(`- \`${pkg.dir}\` — ${pkg.name}`);
    if (workspaces.packages.length > 20) lines.push(`- …and ${workspaces.packages.length - 20} more`);
    if (workspaces.cycle?.length) lines.push("", `⚠ dependency cycle: ${workspaces.cycle.join(" → ")}`);
    lines.push("");
  }

  lines.push("## Key files", "", renderRepoMap(scan, graph, { budgetTokens: opts.budgetTokens ?? 900 }).trim(), "");

  // Where work concentrates. Git-only, and silent when there is no history —
  // an empty section would read as "nothing is hot", which is not what an
  // unmeasurable repository means.
  const { churn, ok: churnOk } = gitChurn(scan.root);
  if (churnOk && churn.size) {
    const hotspots = rankHotspots(scan, churn, 8);
    if (hotspots.length) {
      lines.push("## Where work concentrates", "", "Files ranked by commits × size — where changes and defects cluster.", "");
      for (const spot of hotspots) lines.push(`- \`${spot.rel}\` — ${spot.commits} commits, ${spot.lines} lines`);
      lines.push("");
    }
  }

  lines.push(
    "## Next",
    "",
    "- `search <query>` — BM25 over names, paths, doc comments and prose; `explain_search` says whether it really matched",
    "- `find_symbol <Name>` / `symbols_overview <file>` — read structure without reading files",
    "- `find_references <Name>` — three labelled tiers; add `lsp: true` when a language server is configured",
    "",
  );

  const brief = lines.join("\n");
  if (opts.remember === false) return { brief };
  const memoryName = opts.memoryName ?? "onboarding";
  writeMemory(scan.root, memoryName, brief);
  return { brief, memory: memoryName };
}
