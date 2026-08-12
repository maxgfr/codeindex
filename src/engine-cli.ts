import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_VERSION, EXTRACTOR_VERSION, type FileRecord } from "./types.js";
import { ENGINE_VERSION } from "./types.js";
import {
  CORE_GRAMMARS,
  EXTENDED_GRAMMARS,
  ensureGrammars,
  grammarKeysForExts,
  resolveGrammarsTier,
  sharedGrammarsCacheDir,
} from "./ast/loader.js";
import { resolveGrammarsPullTarget, pullGrammars } from "./ast/grammars-pull.js";
import { buildIndexArtifacts, buildArtifactsFromScan, type BuildIndexOptions, type IndexArtifacts } from "./pipeline.js";
import { sha1 } from "./hash.js";
import { renderGraphJson } from "./render/graph-json.js";
import { renderSymbolsJson } from "./render/symbols-json.js";
import { renderScip } from "./render/scip.js";
import { scanRepo, scanSummary, type RepoScan } from "./scan.js";
import { scanRepoParallel } from "./pool.js";
import { preloadSession, INDEX_DIR } from "./preload.js";
import { walk, type WalkResult } from "./walk.js";
import { buildTypeHierarchy, implementationsOf } from "./relations.js";
import { computeImportPairs } from "./callers.js";
import { buildSymbolGraph, neighborhood } from "./symbolgraph.js";
import { buildCallerIndex } from "./callers.js";
import { detectWorkspaces } from "./workspaces.js";
import { gitChurn } from "./git.js";
import { grepRepo } from "./grep.js";
import { changeCoupling, rankHotspots } from "./coupling.js";
import { renderRepoMap } from "./repomap.js";
import { findDeadCode } from "./deadcode.js";
import { findLiteralDuplications } from "./literals.js";
import { symbolComplexity, riskHotspots } from "./complexity.js";
import { renderMermaid } from "./viz.js";
import { impactOf, neighborsOf } from "./traverse.js";
import { deltaFor, formatDeltaPanel } from "./delta.js";
import { explainQuery, searchIndex } from "./bm25.js";
import { checkRules, parseRules } from "./rules.js";
import { EMBED_VERSION, resolveEmbedModelDir, loadEmbedModel, parseEmbedModel, resolveEmbedPullUrl, fetchEmbedModel } from "./embed/model.js";
import { buildEmbeddingIndex, serializeEmbeddings } from "./embed/index.js";
import { searchSemantic } from "./embed/search.js";
import {
  resolveEmbedEndpoint,
  buildEndpointIndex,
  encodeQueryViaEndpoint,
  probeEndpoint,
} from "./embed/endpoint.js";
import { have, sh } from "./util.js";
import { lspStatus } from "./lsp/index.js";

const HELP = `codeindex engine v${ENGINE_VERSION} — deterministic repo indexing

Usage: engine.mjs <command> [flags]

Commands:
  index       Build graph.json + symbols.json (+ incremental cache.json) into
              --out <dir> in ONE pass — the fast path for repeated runs
  scan        Scan summary: file count, language histogram, capped flag
  graph       Full link-graph (graph.json bytes) to stdout or --out
  symbols     Symbol index (symbols.json bytes) to stdout or --out
  scip        SCIP code-intelligence index (protobuf bytes) into --out
              (default index.scip; --out - writes to stdout)
  callers     Per-symbol caller index (JSON)
  hierarchy   Type hierarchy: extends/implements, and what extends/implements it
  implementations  Everything implementing/extending a type (transitively)
  callgraph   Bounded symbol-to-symbol neighborhood (--depth, --direction)
  workspaces  Monorepo packages + dependency graph (JSON)
  churn       Per-file git commit counts (JSON; --since <ref> to bound)
  grep        Search: cli.mjs grep <pattern> --repo <dir> (JSON hits)
  search      Keyless BM25 lexical search over symbol names, path segments,
              markdown headings and summaries: cli.mjs search "<query>" --repo <dir>.
              --semantic fuses in an embedding tier (RRF) — the HTTP endpoint
              (CODEINDEX_EMBED_ENDPOINT) if set, else a local static model;
              degrades to lexical (exit 0) when neither is available/reachable
  embed       Embedding tiers (opt-in). Precedence: endpoint > static model:
                embed status   Effective mode (none/static/endpoint), model +
                               EMBED_VERSION, and endpoint reachability (JSON)
                embed build    Write embeddings.bin into --out <dir> (static tier)
                embed pull     Fetch the official model asset into CODEINDEX_EMBED_DIR
                               (or <repo>/.codeindex/models/); sha256-verified. Override
                               the source with CODEINDEX_EMBED_URL
                embed serve    Print (or --run) the docker command that starts the
                               containerized embedding server (rich tier)
  lsp         Optional LSP tier (opt-in by asset — the tier is active only when
              <repo>/.codeindex/lsp.json exists, or CODEINDEX_LSP_CONFIG points
              at one). It annotates QUERY answers only and never touches
              graph.json/symbols.json:
                lsp status     Config path and source, each server with whether
                               its command is on PATH and how many files it
                               claims, and the languages nothing covers (JSON).
                               --probe also starts each server to read the
                               capabilities it really advertises
  grammars    Tree-sitter wasm grammars (optional AST tier; regex without them).
              Two tiers: CORE ships with the bundle; EXTENDED (kotlin, elixir,
              zig, solidity, hcl/terraform) arrives only via \`grammars pull\`.
              Precedence: bundle-adjacent > CODEINDEX_GRAMMARS_DIR > shared cache:
                grammars status  Active tier (adjacent/env/cache/none), resolved
                                 dir, pinned ENGINE_VERSION, pull-needed (JSON)
                grammars pull    Fetch the per-release grammars-<version>.tar.gz
                                 asset into the shared cache (sha256-verified,
                                 atomic). Override the source with
                                 CODEINDEX_GRAMMARS_URL
  rules       Architecture rules (forbidden edges, cycles, orphans, literals)
              validated against the link-graph: --config <codeindex.rules.json>;
              exits 1 on any error-severity violation (a CI gate)
  repomap     Token-budgeted map of the highest-PageRank files (--budget-tokens)
  hotspots    Churn × size ranking of the files where work concentrates (JSON)
  coupling    Change coupling: files that change together (JSON; --since <ref>)
  literals    Values with no single source of truth: one literal written out
              across many files, in three labeled tiers — 'competing' (two or
              more exported constants hold it), 'bypassed' (a constant holds
              it and other files rewrite it anyway), 'uncentralized' (nothing
              holds it). Groups path-like values into namespace families so a
              whole route space reports once, not forty times. Reads code AND
              config files (JSON/YAML/TOML), because the duplications that hurt
              are the ones crossing a language boundary no compiler checks.
              (--min-files, --min-count, --include-tests)
  deadcode    Dead-code candidates in two labeled tiers: 'unreferenced' (no
              call site binds AND nothing references the name) and 'uncalled'
              (referenced — re-export, type position — but never called)
  complexity  Cyclomatic-complexity estimates, most-complex first. Pass a file
              positional for one file; omit for the repo-wide top
  risk        Complexity × git-churn ranking (JSON; --since <ref> to bound)
  delta       Review panel for the git diff: changed files -> enclosing symbols ->
              blast radius -> risk score with explained reasons
              (--base <ref> | --staged, --depth <n>, --json)
  impact      Reverse dependency closure of a file or module: everything that
              transitively imports/uses/calls it (--depth <n>; JSON)
  neighbors   Graph neighbours of a file or module, both directions
              (--depth <n>, --kind import,call,use,doc-link,mention; JSON)
  mermaid     Mermaid diagram of the module graph; pass a module positional to
              focus on one neighborhood
  rewrite     Map an expensive tree-wide search onto its indexed equivalent:
              cli.mjs rewrite '<command line>'. Prints the replacement command
              and exits 0, or exits 1 when it has no opinion (run the original).
              Deliberately conservative — any shell metacharacter or unknown
              flag refuses the rewrite
  mcp         Run as an MCP server over stdio (30 tools: scan_summary, graph,
              symbols, callers, workspaces, churn, symbols_overview,
              find_symbol, find_references, repo_map, hotspots, coupling,
              dead_code, complexity, mermaid, grep, search, embed_status,
              check_rules, the memory quartet and the three symbolic-edit
              writes). Flags: --repo <dir> pins ONE repository so the per-tool
              repo argument becomes optional (an explicit per-call repo still
              wins); --server-name <name> overrides the announced serverInfo;
              --max-response-bytes <n> caps a single tool response (default 1e6;
              a response under the cap is byte-identical, one over it is
              replaced by an actionable notice instead of an unusable blob)
  version     Print the engine version

Flags (accepted before OR after the subcommand: '--repo X scan' and
'scan --repo X' are equivalent):
  --repo <dir>        Repo root (default: cwd)
  --out <file>        Write output to a file instead of stdout (\`scip\`: --out -
                      writes the binary index to stdout)
  --project-root <uri> \`scip\`: override Metadata.project_root (default
                      file://<repo>); pin it for a byte-reproducible index
  --include <glob>    Only include matching paths (repeatable)
  --exclude <glob>    Exclude matching paths (repeatable)
  --scope <dir>       Restrict to one directory (sugar for --include '<dir>/**')
  --no-gitignore      Do not honor .gitignore files (default: honored)
  --ignore-dir <name> Directory names to skip (repeatable) — REPLACES the
                      default ignored-directory set, never merges with it
  --max-files <n>     Cap walked files (default: none — the whole tree is
                      indexed; a cap sets the \`capped\` flag)
  --max-bytes <n>     Skip files above this size (default 1 MiB)
  --max-calls <n>     Per-file call-site cap for extraction (default 512)
  --no-ast            Skip tree-sitter grammars even when present (regex tier)
  --workers <n>       \`index\`: extraction worker threads (default: cores-1,
                      capped at 8; 0 or 1 forces the single-threaded path).
                      Also settable with CODEINDEX_WORKERS. Artifacts are
                      byte-identical either way
  --index <dir>       Persisted index the READ commands reuse, relative to the
                      repo (default .codeindex — i.e. what \`index --out\` wrote
                      there). A fresh index turns the scan into a stat pass and,
                      when it still matches the worktree, skips the pipeline
                      entirely. Stale/absent/corrupt → a normal cold build
  --no-index-cache    Never reuse a persisted index; always build from scratch
  --config <file>     Rules config for \`rules\` (JSON: [{name, from, to, …}])
  --limit <n>         Max results for \`search\` (default 20)
  --no-fuzzy          \`search\`: disable trigram fuzzy fallback for query terms
                      with zero document frequency (default: enabled)
  --exact             \`search\`: drop results that carry no verbatim term match
                      (the ones the stem/trigram bridge produced)
  --explain           \`search\`: emit { results, explain } — which terms matched,
                      which bridged, and whether the query really found anything
  --semantic          \`search\`: RRF-fuse an embedding tier with lexical — the
                      HTTP endpoint if CODEINDEX_EMBED_ENDPOINT is set, else a
                      local static model (lexical-only when neither is available)
  --run               \`embed serve\`: run the docker command instead of printing it
  --probe             \`lsp status\`: start each server and read the capabilities
                      it really advertises (default: no spawn)
  --recall            \`callers\`: recall-oriented binding (issue #7) — relaxes
                      the JS/TS import gate to unique repo-wide names and labels
                      each site corroborated|unique-name
  --ignore-case       \`grep\`: case-insensitive matching
  --max-hits <n>      \`grep\`: cap returned hits (default 200)
  --min-files <n>     \`literals\`: distinct files a value must span (default 2)
  --min-count <n>     \`literals\`: total occurrences required (default 3)
  --include-tests     \`literals\`: count test files too. Off by default — a test
                      restating a value is usually asserting it deliberately
`;

interface CliFlags {
  repo: string;
  out?: string;
  include: string[];
  exclude: string[];
  scope?: string;
  gitignore: boolean;
  ignoreDirs: string[];
  maxFiles?: number;
  maxBytes?: number;
  maxCalls?: number;
  noAst: boolean;
  workers?: number; // extraction worker threads (0/1 = sequential)
  indexDir?: string; // persisted index to read (default .codeindex)
  noIndexCache?: boolean; // never reuse a persisted index
  since?: string;
  ignoreCase?: boolean;
  maxHits?: number;
  budgetTokens?: number;
  config?: string; // rules config path
  limit?: number; // search result cap
  minFiles?: number; // literals: distinct-file floor for a duplication
  minCount?: number; // literals: total-occurrence floor for a duplication
  includeTests?: boolean; // literals: count test files too (off by default)
  fuzzy: boolean; // search: trigram fuzzy fallback for df==0 terms (default true)
  exact?: boolean; // search: drop results carrying no verbatim term match
  explain?: boolean; // search: emit { results, explain } instead of a bare array
  semantic: boolean; // search: RRF-fuse the static-embedding tier (default false)
  recall?: boolean; // callers: recall-oriented binding
  run?: boolean; // `embed serve`: actually run the docker command (default: print)
  probe?: boolean; // `lsp status`: start each server to read its real capabilities
  projectRoot?: string; // scip: override Metadata.project_root
  base?: string; // delta: branch/ref to diff against (default: the repo's default branch)
  staged?: boolean; // delta: diff the index instead of the merge-base
  depth?: number; // delta/impact/neighbors: traversal hops
  kind?: string; // neighbors: comma-separated edge kinds to traverse
  direction?: "out" | "in" | "both"; // callgraph: which way to walk
  rank?: "graph" | "lexical"; // search: structural prior (default lexical)
  json?: boolean; // delta: emit JSON instead of the human panel
  positional?: string; // e.g. the grep pattern or search query
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { repo: process.cwd(), include: [], exclude: [], gitignore: true, ignoreDirs: [], noAst: false, fuzzy: true, semantic: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    const num = (): number => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${a} expects a positive number, got "${raw}"`);
      return n;
    };
    if (a === "--repo") flags.repo = resolve(next());
    else if (a === "--out") {
      const v = next();
      flags.out = v === "-" ? "-" : resolve(v); // "-" = stdout (scip binary)
    } else if (a === "--project-root") flags.projectRoot = next();
    else if (a === "--include") flags.include.push(next());
    else if (a === "--exclude") flags.exclude.push(next());
    else if (a === "--scope") flags.scope = next();
    else if (a === "--no-gitignore") flags.gitignore = false;
    else if (a === "--ignore-dir") flags.ignoreDirs.push(next());
    else if (a === "--max-files") flags.maxFiles = num();
    else if (a === "--max-bytes") flags.maxBytes = num();
    else if (a === "--max-calls") flags.maxCalls = num();
    else if (a === "--ignore-case") flags.ignoreCase = true;
    else if (a === "--max-hits") flags.maxHits = num();
    else if (a === "--budget-tokens") flags.budgetTokens = num();
    else if (a === "--min-files") flags.minFiles = num();
    else if (a === "--min-count") flags.minCount = num();
    else if (a === "--include-tests") flags.includeTests = true;
    else if (a === "--no-ast") flags.noAst = true;
    else if (a === "--index") flags.indexDir = next();
    else if (a === "--no-index-cache") flags.noIndexCache = true;
    else if (a === "--workers") {
      // 0 is meaningful here (force sequential), so this cannot use num().
      const raw = next();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--workers expects a non-negative integer, got "${raw}"`);
      flags.workers = n;
    }
    else if (a === "--since") flags.since = next();
    else if (a === "--config") flags.config = resolve(next());
    else if (a === "--limit") flags.limit = num();
    else if (a === "--no-fuzzy") flags.fuzzy = false;
    else if (a === "--exact") flags.exact = true;
    else if (a === "--explain") flags.explain = true;
    else if (a === "--semantic") flags.semantic = true;
    else if (a === "--recall") flags.recall = true;
    else if (a === "--run") flags.run = true;
    else if (a === "--probe") flags.probe = true;
    else if (a === "--base") flags.base = next();
    else if (a === "--staged") flags.staged = true;
    else if (a === "--depth") flags.depth = num();
    else if (a === "--kind") flags.kind = next();
    else if (a === "--rank") {
      const v = next();
      if (v !== "graph" && v !== "lexical") throw new Error(`--rank expects graph|lexical, got "${v}"`);
      flags.rank = v;
    }
    else if (a === "--direction") {
      const v = next();
      if (v !== "out" && v !== "in" && v !== "both") throw new Error(`--direction expects out|in|both, got "${v}"`);
      flags.direction = v;
    }
    else if (a === "--json") flags.json = true;
    else if (!a.startsWith("--") && flags.positional === undefined) flags.positional = a;
    else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function emit(content: string, out?: string): void {
  if (out) writeFileSync(out, content);
  else process.stdout.write(content);
}

function scanOptions(flags: CliFlags, precomputedWalk?: WalkResult): BuildIndexOptions {
  return {
    include: flags.include.length ? flags.include : undefined,
    exclude: flags.exclude.length ? flags.exclude : undefined,
    scope: flags.scope,
    gitignore: flags.gitignore,
    ignoreDirs: flags.ignoreDirs.length ? flags.ignoreDirs : undefined,
    maxFiles: flags.maxFiles,
    maxBytes: flags.maxBytes,
    maxCallsPerFile: flags.maxCalls,
    // The walk performed once in runCli to warm the present-language grammars,
    // reused here so scanRepo does not traverse the tree a second time. Absent
    // for --no-ast / scan-less commands: scanRepo walks itself, unchanged.
    precomputedWalk,
  };
}

// Commands that never walk/scan the file tree — they read git/grep directly or
// only manage the grammar cache, so they must warm NO tree-sitter grammar (the
// CLI previously warmed every one unconditionally). `embed` is scan-only for its
// `build` subcommand; the other embed subcommands (status/pull/serve) are
// excluded by the positional check at the warm site. `grammars` (status/pull)
// resolves/downloads the wasms itself and must not warm them.
// version/help/mcp return before we get there.
const SCANLESS_COMMANDS = new Set(["grep", "churn", "coupling", "workspaces", "grammars"]);

// Flags for `codeindex mcp`. Kept separate from parseFlags on purpose (see the
// dispatch site). `--repo` is resolved to an absolute path and must exist: a
// server pinned to a typo'd directory would otherwise answer every tool call
// with the same confusing per-call error instead of failing at startup.
export function parseMcpFlags(argv: string[]): {
  defaultRepo?: string;
  serverInfo?: { name?: string };
  maxResponseBytes?: number;
} {
  let defaultRepo: string | undefined;
  let name: string | undefined;
  let maxResponseBytes: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") {
      const v = argv[++i];
      if (!v) throw new Error("--repo requires a directory");
      defaultRepo = resolve(v);
    } else if (a === "--server-name") {
      const v = argv[++i];
      if (!v) throw new Error("--server-name requires a value");
      name = v;
    } else if (a === "--max-response-bytes") {
      const v = argv[++i];
      const n = Number(v);
      if (!v || !Number.isFinite(n) || n <= 0) throw new Error("--max-response-bytes requires a positive number");
      maxResponseBytes = n;
    } else {
      throw new Error(`unknown flag for \`mcp\`: ${a}`);
    }
  }
  if (defaultRepo && !existsSync(defaultRepo)) throw new Error(`--repo path does not exist: ${defaultRepo}`);
  return { defaultRepo, serverInfo: name ? { name } : undefined, maxResponseBytes };
}

// Flags that consume the following argv element. Needed to hoist leading flags
// past the subcommand without mistaking a flag's VALUE for the command name
// (`--repo /x scan`: `/x` must not be read as the command).
const VALUE_FLAGS = new Set([
  "--repo",
  "--out",
  "--project-root",
  "--include",
  "--exclude",
  "--scope",
  "--ignore-dir",
  "--max-files",
  "--max-bytes",
  "--max-calls",
  "--max-hits",
  "--budget-tokens",
  "--min-files",
  "--min-count",
  "--since",
  "--config",
  "--limit",
  "--server-name",
  "--workers",
  "--index",
  "--max-response-bytes",
]);

// Accept global flags BEFORE the subcommand as well as after, so
// `codeindex --repo /x scan` and `codeindex scan --repo /x` agree. A strict
// subcommand-first parser reads the leading flag as the command name and fails
// with a baffling "unknown flag: scan".
//
// This is not only ergonomics. A host that wraps the CLI may splice a flag in
// right after the binary name — iterion's rewriter `inject_flag` does exactly
// that, turning `codeindex grep foo` into `codeindex --max-hits 40 grep foo` —
// and without hoisting that command cannot run at all.
//
// Returns argv unchanged when there is nothing to hoist, so `--help`,
// `--version` and a bare subcommand all keep their existing behaviour.
export function hoistLeadingFlags(argv: string[]): string[] {
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("-")) break;
    lead.push(a);
    i++;
    if (VALUE_FLAGS.has(a) && i < argv.length) {
      lead.push(argv[i] as string);
      i++;
    }
  }
  // No leading flags, or they were the whole line (`--help`, `--version`).
  if (lead.length === 0 || i >= argv.length) return argv;
  return [argv[i] as string, ...lead, ...argv.slice(i + 1)];
}

export async function runCli(rawArgv: string[]): Promise<void> {
  const argv = hoistLeadingFlags(rawArgv);
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "version" || cmd === "--version") {
    process.stdout.write(ENGINE_VERSION + "\n");
    return;
  }
  if (cmd === "rewrite") {
    // Host contract (iterion's `rewriters` kind, rtk's generalization): stdin
    // is nothing, argv is ONE full command line, stdout is the command to run
    // instead, and the exit code says whether to use it. Exit 1 = "no opinion,
    // run the original" — the overwhelmingly common, deliberately cheap case.
    const { rewriteCommand } = await import("./rewrite.js");
    const rewritten = rewriteCommand(rest.join(" "));
    if (!rewritten) {
      process.exitCode = 1;
      return;
    }
    process.stdout.write(rewritten + "\n");
    return;
  }
  if (cmd === "mcp") {
    // `mcp` takes a deliberately tiny, self-contained flag set rather than
    // going through parseFlags: the shared parser owns positional/scope
    // semantics that mean nothing to a long-lived server, and every unknown
    // flag there is fatal. Pinning is OPT-IN — a bare `codeindex mcp` keeps
    // the historical contract where each tool call carries its own `repo`.
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer(parseMcpFlags(rest));
    return;
  }

  const flags = parseFlags(rest);
  if (!existsSync(flags.repo)) throw new Error(`--repo path does not exist: ${flags.repo}`);

  // Warm ONLY the grammars for languages actually present, and only for commands
  // that scan the file tree. Scan-less commands (grep, churn, coupling,
  // workspaces, embed status|pull|serve) load no grammar at all; version/help/mcp
  // already returned above. The walk is done ONCE here to derive the present
  // extensions, then handed to the scan via precomputedWalk so the tree is
  // traversed a single time. --no-ast keeps the regex tier: no walk, no warm —
  // scanRepo walks itself, exactly as before.
  const scans = !SCANLESS_COMMANDS.has(cmd) && !(cmd === "embed" && flags.positional !== "build");
  let precomputedWalk: WalkResult | undefined;
  if (scans && !flags.noAst) {
    precomputedWalk = walk(flags.repo, {
      maxFileBytes: flags.maxBytes,
      maxFiles: flags.maxFiles,
      gitignore: flags.gitignore,
      ignoreDirs: flags.ignoreDirs.length ? flags.ignoreDirs : undefined,
    });
    await ensureGrammars(grammarKeysForExts(precomputedWalk.files.map((f) => f.ext)));
  }

  // Read commands reuse a persisted index instead of rebuilding from scratch.
  //
  // Only `index` ever consulted .codeindex/; every read command (graph, symbols,
  // scip, callers, search, repomap, hotspots, deadcode, complexity, risk,
  // mermaid, rules) re-walked, re-read, re-hashed and re-EXTRACTED the whole
  // repo on each invocation — `codeindex search` cost a full tree-sitter pass
  // every time, with a fresh index sitting right next to it.
  //
  // cache.json turns the scan into a stat pass; when the freshness guard holds,
  // graph.json/symbols.json come back without running the pipeline at all. Both
  // degrade to today's cold path when the index is absent, stale or corrupt, so
  // output is unchanged either way. Resolved lazily and at most once: a command
  // uses either the scan or the artifacts, never both.
  const indexDir = flags.indexDir ?? INDEX_DIR;
  let preloadTried = false;
  let preloaded: { scan: RepoScan; arts?: IndexArtifacts } | undefined;
  const tryPreload = (): { scan: RepoScan; arts?: IndexArtifacts } | undefined => {
    if (preloadTried) return preloaded;
    preloadTried = true;
    if (flags.noIndexCache) return undefined;
    const p = preloadSession(flags.repo, scanOptions(flags, precomputedWalk), indexDir);
    if (p) preloaded = { scan: p.scan, arts: p.arts };
    return preloaded;
  };
  const readScan = (): RepoScan => tryPreload()?.scan ?? scanRepo(flags.repo, scanOptions(flags, precomputedWalk));
  const readArtifacts = (): IndexArtifacts => {
    const p = tryPreload();
    if (p?.arts) return p.arts;
    if (p) return buildArtifactsFromScan(p.scan, scanOptions(flags, precomputedWalk));
    return buildIndexArtifacts(flags.repo, scanOptions(flags, precomputedWalk));
  };

  if (cmd === "index") {
    if (!flags.out) throw new Error("index needs --out <dir>");
    const outDir = flags.out;
    mkdirSync(outDir, { recursive: true });
    // Incremental cache: reuse per-file records when (schema, extractor) match —
    // same invalidation discipline as ultraindex's cache.json.
    const cachePath = join(outDir, "cache.json");
    type CacheEntry = { hash: string; record: FileRecord; size?: number; mtimeMs?: number };
    // ADDITIVE meta keys describing the artifacts the cache-writing run put on
    // disk. Old engines ignore them (they only check schema/extractor above);
    // old caches lacking them simply never take the fastpath below (their
    // per-file records are still reused). cache.json embeds mtimes, so it was
    // never cross-machine byte-reproducible — no determinism surface changes.
    type CacheMeta = {
      engineVersion?: string;
      commit?: string;
      graphSha1?: string;
      symbolsSha1?: string;
      embed?: { embedVersion?: number; modelId?: string; sha1?: string };
    };
    let cache: Map<string, CacheEntry> | undefined;
    let meta: CacheMeta = {};
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as {
        schemaVersion: number;
        extractorVersion: number;
        files: Record<string, CacheEntry>;
      } & CacheMeta;
      if (parsed.schemaVersion === SCHEMA_VERSION && parsed.extractorVersion === EXTRACTOR_VERSION) {
        cache = new Map(Object.entries(parsed.files));
        meta = {
          engineVersion: parsed.engineVersion,
          commit: parsed.commit,
          graphSha1: parsed.graphSha1,
          symbolsSha1: parsed.symbolsSha1,
          embed: parsed.embed,
        };
      }
    } catch {
      // no cache yet (or unreadable) — cold build
    }
    const scan = await scanRepoParallel(flags.repo, {
      ...scanOptions(flags, precomputedWalk),
      cache,
      out: outDir,
      workers: flags.workers,
    });
    const modelDir = resolveEmbedModelDir(flags.repo);
    const model = modelDir ? loadEmbedModel(modelDir) : undefined;

    const graphPath = join(outDir, "graph.json");
    const symbolsPath = join(outDir, "symbols.json");
    const embedPath = join(outDir, "embeddings.bin");
    // sha of an on-disk artifact, or undefined when it is missing/unreadable —
    // never equal to a defined meta sha, so a deleted artifact fails the guard.
    const artifactSha = (path: string): string | undefined => {
      try {
        return sha1(readFileSync(path));
      } catch {
        return undefined;
      }
    };
    const writeCache = (out: Pick<CacheMeta, "graphSha1" | "symbolsSha1" | "embed">): void => {
      const files: Record<string, CacheEntry> = {};
      for (const f of scan.files) {
        const entry: CacheEntry = { hash: f.hash, record: f, size: f.size };
        const mtime = scan.mtimes.get(f.rel);
        if (mtime !== undefined) entry.mtimeMs = mtime;
        files[f.rel] = entry;
      }
      // Fixed key order; JSON.stringify drops the undefined-valued keys
      // (commit outside a git worktree, embed without a model) cleanly.
      writeFileSync(
        cachePath,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          extractorVersion: EXTRACTOR_VERSION,
          engineVersion: ENGINE_VERSION,
          commit: scan.commit,
          graphSha1: out.graphSha1,
          symbolsSha1: out.symbolsSha1,
          embed: out.embed,
          files,
        }) + "\n",
      );
    };

    // FASTPATH GUARD — skip the whole downstream pipeline only when this scan
    // is proven identical to the run that wrote the on-disk artifacts:
    // contentUnchanged means this scan's records are object-identical to that
    // run's; downstream is a pure function of (records, docText, commit,
    // meta-opts) and the CLI never sets meta/previousCommunities;
    // engineVersion pins the version stamp; commit must match because
    // graph.json embeds it (identical trees under a new HEAD must rebuild);
    // the shas prove the on-disk bytes are that run's output. ANY failure —
    // deleted or tampered artifacts included — falls through to the full
    // build, which rewrites everything (self-healing).
    const embedUnchanged =
      !model ||
      (meta.embed !== undefined &&
        meta.embed.embedVersion === EMBED_VERSION &&
        meta.embed.modelId === model.modelId &&
        meta.embed.sha1 !== undefined &&
        artifactSha(embedPath) === meta.embed.sha1);
    const fastpath =
      scan.contentUnchanged &&
      meta.engineVersion === ENGINE_VERSION &&
      meta.commit === scan.commit &&
      meta.graphSha1 !== undefined &&
      artifactSha(graphPath) === meta.graphSha1 &&
      meta.symbolsSha1 !== undefined &&
      artifactSha(symbolsPath) === meta.symbolsSha1 &&
      embedUnchanged;

    if (fastpath) {
      // Artifacts verified byte-identical to what this build would produce —
      // leave them untouched. Rewrite cache.json only when the scan says its
      // bytes would change (e.g. an mtime drifted); the meta is carried
      // forward verbatim since the guard just proved it describes the disk.
      if (scan.cacheDirty) writeCache(meta);
      process.stderr.write(
        `codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${scan.capped ? " (capped)" : ""} (unchanged — artifacts reused)\n`,
      );
    } else {
      const { graph, symbols } = buildArtifactsFromScan(scan);
      const graphJson = renderGraphJson(graph);
      const symbolsJson = renderSymbolsJson(symbols);
      writeFileSync(graphPath, graphJson);
      writeFileSync(symbolsPath, symbolsJson);
      // Deterministic embeddings sidecar: written next to graph.json ONLY when a
      // model asset is present (opt-in). Silently skipped otherwise — no model, no
      // embeddings.bin, no impact on the graph/symbols consumers.
      let embedNote = "";
      let embedMeta: CacheMeta["embed"];
      if (model) {
        const index = buildEmbeddingIndex(scan, model);
        const bytes = serializeEmbeddings(index);
        writeFileSync(embedPath, bytes);
        embedMeta = { embedVersion: EMBED_VERSION, modelId: model.modelId, sha1: sha1(bytes) };
        embedNote = ` + embeddings.bin (${index.records.length} records, model ${model.modelId})`;
      }
      // cache.json is written LAST so its meta always describes artifacts that
      // are already on disk — a crash mid-way leaves stale meta whose shas
      // fail the guard on the next run (safe: it just rebuilds).
      writeCache({ graphSha1: sha1(graphJson), symbolsSha1: sha1(symbolsJson), embed: embedMeta });
      process.stderr.write(`codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${embedNote}${scan.capped ? " (capped)" : ""}\n`);
    }
  } else if (cmd === "scan") {
    // Summary-only: a file count and a language histogram need the walk and the
    // path-based classifiers, never a read or a parse. Same numbers as before by
    // construction — scanSummary and scanRepo share the keptFiles loop.
    const s = scanSummary(flags.repo, scanOptions(flags, precomputedWalk));
    const summary = {
      engineVersion: ENGINE_VERSION,
      commit: s.commit,
      fileCount: s.fileCount,
      languages: s.languages,
      capped: s.capped,
    };
    emit(JSON.stringify(summary, null, 2) + "\n", flags.out);
  } else if (cmd === "graph") {
    const { graph } = readArtifacts();
    emit(renderGraphJson(graph), flags.out);
  } else if (cmd === "symbols") {
    const { symbols } = readArtifacts();
    emit(renderSymbolsJson(symbols), flags.out);
  } else if (cmd === "scip") {
    const scan = readScan();
    const bytes = renderScip(scan, { projectRoot: flags.projectRoot });
    const out = flags.out ?? resolve("index.scip");
    if (out === "-") process.stdout.write(Buffer.from(bytes));
    else {
      writeFileSync(out, bytes);
      process.stderr.write(`codeindex: SCIP index → ${out} (${bytes.length} bytes)\n`);
    }
  } else if (cmd === "callers") {
    const scan = readScan();
    const index = buildCallerIndex(scan, undefined, { recall: flags.recall });
    const obj: Record<string, unknown> = {};
    for (const [name, entry] of index) obj[name] = entry;
    emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
  } else if (cmd === "hierarchy") {
    const scan = readScan();
    const hierarchy = buildTypeHierarchy(scan, computeImportPairs(scan));
    if (flags.positional) {
      const entry = hierarchy.get(flags.positional);
      if (!entry) throw new Error(`no type named ${flags.positional}`);
      emit(JSON.stringify(entry, null, 2) + "\n", flags.out);
    } else {
      const obj: Record<string, unknown> = {};
      for (const [key, entry] of hierarchy) obj[key] = entry;
      emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
    }
  } else if (cmd === "implementations") {
    if (!flags.positional) throw new Error("implementations needs a type name: cli.mjs implementations <Name> --repo <dir>");
    const scan = readScan();
    const hierarchy = buildTypeHierarchy(scan, computeImportPairs(scan));
    if (!hierarchy.has(flags.positional)) throw new Error(`no type named ${flags.positional}`);
    emit(
      JSON.stringify({ name: flags.positional, implementations: implementationsOf(hierarchy, flags.positional) }, null, 2) + "\n",
      flags.out,
    );
  } else if (cmd === "callgraph") {
    if (!flags.positional) throw new Error("callgraph needs a symbol: cli.mjs callgraph <Symbol> --repo <dir>");
    const scan = readScan();
    const graph = buildSymbolGraph(scan, computeImportPairs(scan));
    const result = neighborhood(graph, flags.positional, {
      ...(flags.depth !== undefined ? { depth: flags.depth } : {}),
      ...(flags.direction ? { direction: flags.direction } : {}),
    });
    if (!result.root.length) throw new Error(`no symbol named ${flags.positional}`);
    emit(JSON.stringify(result, null, 2) + "\n", flags.out);
  } else if (cmd === "search") {
    if (!flags.positional) throw new Error('search needs a query: cli.mjs search "<query>" --repo <dir>');
    const scan = readScan();
    const searchOpts = {
      limit: flags.limit,
      fuzzy: flags.fuzzy,
      ...(flags.exact ? { exact: true } : {}),
      ...(flags.rank ? { rank: flags.rank } : {}),
    };

    // stdout stays pure JSON — a caller pipes it into jq. The verdict goes to
    // stderr, the channel this command already uses to say a tier degraded.
    // Emitted for the semantic tier too: whether an identifier exists in the
    // indexed tree is a fact about the corpus, not about the ranking model.
    const warnIfWeak = (): void => {
      const { explain } = explainQuery(scan, flags.positional!, searchOpts);
      if (explain.note) process.stderr.write(`codeindex: ${explain.note}\n`);
    };

    if (flags.semantic) {
      const endpoint = resolveEmbedEndpoint();
      const lexical = (): void => {
        const results = searchIndex(scan, flags.positional!, searchOpts);
        emit(JSON.stringify(results, null, 2) + "\n", flags.out);
      };
      if (endpoint) {
        // Rich tier. The endpoint takes PRECEDENCE over a local static model:
        // configuring CODEINDEX_EMBED_ENDPOINT is an explicit user intent. An
        // unreachable/timed-out/malformed endpoint degrades straight to lexical
        // (a stderr note, exit 0) — NOT to the static model.
        try {
          const index = await buildEndpointIndex(scan);
          const queryVec = await encodeQueryViaEndpoint(flags.positional);
          const results = searchSemantic(scan, flags.positional, index, { queryVec, limit: flags.limit, fuzzy: flags.fuzzy });
          emit(JSON.stringify(results, null, 2) + "\n", flags.out);
        } catch (e) {
          process.stderr.write(
            `codeindex: embedding endpoint ${endpoint} unavailable (${e instanceof Error ? e.message : e}) — returning lexical results\n`,
          );
          lexical();
        }
      } else {
        const modelDir = resolveEmbedModelDir(flags.repo);
        const model = modelDir ? loadEmbedModel(modelDir) : undefined;
        if (!model) {
          // Degradation: --semantic without a model or endpoint → lexical results
          // + a stderr note, exit 0. The results shape is a superset of lexical.
          process.stderr.write(
            "codeindex: semantic search unavailable (no embedding model or endpoint) — returning lexical results; run `codeindex embed pull` or set CODEINDEX_EMBED_ENDPOINT to enable it\n",
          );
          lexical();
        } else {
          const index = buildEmbeddingIndex(scan, model);
          const results = searchSemantic(scan, flags.positional, index, { model, limit: flags.limit, fuzzy: flags.fuzzy });
          emit(JSON.stringify(results, null, 2) + "\n", flags.out);
        }
      }
      warnIfWeak();
    } else {
      const { results, explain } = explainQuery(scan, flags.positional, searchOpts);
      // --explain is opt-in precisely so the default stdout stays a bare array,
      // byte-identical to every release before this one.
      emit(JSON.stringify(flags.explain ? { results, explain } : results, null, 2) + "\n", flags.out);
      if (explain.note) process.stderr.write(`codeindex: ${explain.note}\n`);
    }
  } else if (cmd === "embed") {
    const sub = flags.positional;
    const modelDir = resolveEmbedModelDir(flags.repo);
    if (sub === "status") {
      const model = modelDir ? loadEmbedModel(modelDir) : undefined;
      const endpoint = resolveEmbedEndpoint();
      // Effective mode with precedence: endpoint > static model > none.
      const mode: "none" | "static" | "endpoint" = endpoint ? "endpoint" : model ? "static" : "none";
      const status: Record<string, unknown> = {
        embedVersion: EMBED_VERSION,
        mode,
        model: model
          ? { present: true, dir: modelDir, modelId: model.modelId, dim: model.dim, vocabSize: model.vocabSize }
          : { present: false },
        endpoint: endpoint ?? null,
      };
      // When an endpoint is configured, actually probe its reachability.
      if (endpoint) status.endpointReachable = await probeEndpoint(endpoint);
      emit(JSON.stringify(status, null, 2) + "\n", flags.out);
    } else if (sub === "serve") {
      // Convenience only — the LIBRARY never orchestrates docker (engine.ts is
      // side-effect-free). This lives in the CLI: it prints (or, with --run,
      // executes) the docker command that starts the embedding server image.
      const dockerArgs = ["run", "-d", "-p", "8756:8756", "ghcr.io/maxgfr/codeindex-embed:latest"];
      const oneLiner = `docker ${dockerArgs.join(" ")}`;
      if (!have("docker")) {
        process.stderr.write(
          "codeindex: docker not found on PATH. Install Docker, then run:\n  " + oneLiner + "\n",
        );
        process.exitCode = 1;
        return;
      }
      if (flags.run) {
        process.stderr.write(`codeindex: starting embedding server → ${oneLiner}\n`);
        const res = sh("docker", dockerArgs);
        if (res.stdout.trim()) process.stdout.write(res.stdout.trim() + "\n"); // container id
        if (!res.ok) {
          process.stderr.write(res.stderr || "codeindex: docker run failed\n");
          process.exitCode = 1;
          return;
        }
        process.stderr.write(
          "codeindex: server starting on http://localhost:8756 — then:\n" +
            "  CODEINDEX_EMBED_ENDPOINT=http://localhost:8756 codeindex search \"<query>\" --repo . --semantic\n",
        );
      } else {
        // Print the command for the user to run (default; no side effects).
        process.stdout.write(oneLiner + "\n");
        process.stderr.write(
          "codeindex: run the line above to start the embedding server (or `embed serve --run`), then:\n" +
            "  CODEINDEX_EMBED_ENDPOINT=http://localhost:8756 codeindex search \"<query>\" --repo . --semantic\n",
        );
      }
    } else if (sub === "build") {
      if (!flags.out) throw new Error("embed build needs --out <dir>");
      if (!modelDir) {
        process.stderr.write("codeindex: no embedding model present — run `codeindex embed pull` first (nothing written)\n");
        process.exitCode = 1;
        return;
      }
      const model = loadEmbedModel(modelDir)!;
      mkdirSync(flags.out, { recursive: true });
      const scan = readScan();
      const index = buildEmbeddingIndex(scan, model);
      writeFileSync(join(flags.out, "embeddings.bin"), serializeEmbeddings(index));
      process.stderr.write(`codeindex: ${index.records.length} embedding records → ${flags.out}/embeddings.bin (model ${model.modelId})\n`);
    } else if (sub === "pull") {
      // Default: the official published asset + its pinned sha256. A user-set
      // CODEINDEX_EMBED_URL overrides both (mirror/custom model, no verification).
      const { url, sha256 } = resolveEmbedPullUrl();
      const destDir = process.env.CODEINDEX_EMBED_DIR ?? join(flags.repo, ".codeindex", "models");
      mkdirSync(destDir, { recursive: true });
      process.stderr.write(`codeindex: fetching model from ${url} → ${join(destDir, "model.json")}\n`);
      let body: string;
      try {
        // Follows redirects (GitHub → CDN) and verifies sha256 for the default asset.
        body = await fetchEmbedModel(url, sha256);
      } catch (e) {
        process.stderr.write(`codeindex: pull failed — ${e instanceof Error ? e.message : String(e)} (nothing written)\n`);
        process.exitCode = 1;
        return;
      }
      try {
        // Shape-validate BEFORE writing: a JSON-valid but shape-invalid asset
        // would otherwise land on disk and turn every later semantic search
        // into a hard loadEmbedModel error instead of the documented degrade.
        parseEmbedModel(JSON.parse(body), url);
      } catch (e) {
        process.stderr.write(
          `codeindex: pull failed — response is not a valid model.json (${e instanceof Error ? e.message : String(e)}) (nothing written)\n`,
        );
        process.exitCode = 1;
        return;
      }
      writeFileSync(join(destDir, "model.json"), body);
      process.stderr.write(`codeindex: model written to ${join(destDir, "model.json")}\n`);
    } else {
      throw new Error("embed needs a subcommand: status | build | pull | serve");
    }
  } else if (cmd === "lsp") {
    const sub = flags.positional;
    if (sub !== "status") throw new Error("lsp needs a subcommand: status");
    // A MALFORMED config is the one case that exits 1: here the config IS the
    // question being asked, so swallowing the parse error would answer it
    // wrongly. Everywhere else an unusable tier degrades on exit 0.
    emit(JSON.stringify(await lspStatus(readScan(), flags.repo, flags.probe === true), null, 2) + "\n", flags.out);
  } else if (cmd === "grammars") {
    const sub = flags.positional;
    const cacheDir = sharedGrammarsCacheDir();
    if (sub === "status") {
      // Report which tier furnishes the wasms (adjacent/env/cache/none), the
      // resolved dir, the pinned ENGINE_VERSION the cache is keyed on, and
      // whether a pull is needed (no runtime wasm resolvable → AST off, regex).
      const info = resolveGrammarsTier();
      const present = (name: string): boolean => info.dirs.some((d) => existsSync(join(d, name)));
      const runtimePresent = present("web-tree-sitter.wasm");
      const target = resolveGrammarsPullTarget();
      // Which grammars are actually THERE, split by tier. Without this, `status`
      // said "adjacent" and a user whose Kotlin repo was silently indexed by the
      // regex tier had no way to see that the extended set was missing.
      const resolvedIn = (keys: Set<string>): string[] => [...keys].filter((k) => present(`${k}.wasm`)).sort();
      const core = resolvedIn(CORE_GRAMMARS);
      const extended = resolvedIn(EXTENDED_GRAMMARS);
      const status: Record<string, unknown> = {
        engineVersion: ENGINE_VERSION,
        tier: info.tier,
        dir: info.dir ?? null,
        dirs: info.dirs,
        cacheDir,
        runtimePresent,
        pullNeeded: !runtimePresent,
        core: { resolved: core.length, of: CORE_GRAMMARS.size, missing: [...CORE_GRAMMARS].filter((k) => !core.includes(k)).sort() },
        extended: {
          resolved: extended.length,
          of: EXTENDED_GRAMMARS.size,
          missing: [...EXTENDED_GRAMMARS].filter((k) => !extended.includes(k)).sort(),
        },
        url: target.url,
      };
      emit(JSON.stringify(status, null, 2) + "\n", flags.out);
    } else if (sub === "pull") {
      // The mechanic itself (sidecar checksum, idempotent skip, atomic install)
      // lives in pullGrammars — shared verbatim with warmGrammars, so the CLI
      // and the library warm-up can never drift apart. Here we only map its
      // result onto the CLI contract: progress notes and the terminal message to
      // stderr, non-zero exit on failure (which wrote nothing).
      const res = await pullGrammars(cacheDir, { onNote: (m) => process.stderr.write(m) });
      process.stderr.write(res.message);
      if (!res.ok) process.exitCode = 1;
    } else {
      throw new Error("grammars needs a subcommand: status | pull");
    }
  } else if (cmd === "rules") {
    if (!flags.config) throw new Error("rules needs --config <codeindex.rules.json>");
    const rules = parseRules(JSON.parse(readFileSync(flags.config, "utf8")));
    const { graph } = readArtifacts();
    const violations = checkRules(graph, rules);
    const errors = violations.filter((v) => v.severity === "error").length;
    emit(JSON.stringify({ errors, warnings: violations.length - errors, violations }, null, 2) + "\n", flags.out);
    if (errors > 0) process.exitCode = 1; // the CI gate
  } else if (cmd === "workspaces") {
    const info = detectWorkspaces(flags.repo);
    emit(
      JSON.stringify(
        { packages: info.packages, cycle: info.cycle ?? null, topoOrder: info.topoOrder },
        null,
        2,
      ) + "\n",
      flags.out,
    );
  } else if (cmd === "churn") {
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    const sorted: Record<string, number> = {};
    for (const k of [...churn.keys()].sort()) sorted[k] = churn.get(k)!;
    emit(JSON.stringify({ ok, churn: sorted }, null, 2) + "\n", flags.out);
  } else if (cmd === "repomap") {
    const { scan, graph } = readArtifacts();
    emit(renderRepoMap(scan, graph, { budgetTokens: flags.budgetTokens }), flags.out);
  } else if (cmd === "hotspots") {
    const scan = readScan();
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, hotspots: rankHotspots(scan, churn) }, null, 2) + "\n", flags.out);
  } else if (cmd === "coupling") {
    const { ok, couplings } = changeCoupling(flags.repo, { since: flags.since });
    emit(JSON.stringify({ ok, couplings }, null, 2) + "\n", flags.out);
  } else if (cmd === "deadcode") {
    emit(JSON.stringify(findDeadCode(readScan()), null, 2) + "\n", flags.out);
  } else if (cmd === "literals") {
    const report = findLiteralDuplications(readScan(), {
      minFiles: flags.minFiles,
      minCount: flags.minCount,
      includeTests: flags.includeTests,
    });
    emit(JSON.stringify(report, null, 2) + "\n", flags.out);
  } else if (cmd === "complexity") {
    const scan = readScan();
    emit(JSON.stringify(symbolComplexity(scan, flags.positional), null, 2) + "\n", flags.out);
  } else if (cmd === "risk") {
    const scan = readScan();
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, risks: riskHotspots(scan, churn) }, null, 2) + "\n", flags.out);
  } else if (cmd === "delta") {
    const { graph, symbols } = readArtifacts();
    const res = deltaFor(flags.repo, graph, symbols, {
      base: flags.base,
      staged: flags.staged,
      depth: flags.depth,
    });
    if ("error" in res) throw new Error(res.error);
    emit(flags.json ? JSON.stringify(res, null, 2) + "\n" : formatDeltaPanel(res), flags.out);
  } else if (cmd === "impact") {
    if (!flags.positional) throw new Error("impact needs a target: cli.mjs impact <file|module> --repo <dir>");
    const { graph } = readArtifacts();
    const res = impactOf(graph, flags.positional, flags.depth ?? Infinity);
    if (!res) throw new Error(`no such file or module in the index: ${flags.positional}`);
    emit(JSON.stringify(res, null, 2) + "\n", flags.out);
  } else if (cmd === "neighbors") {
    if (!flags.positional) throw new Error("neighbors needs a target: cli.mjs neighbors <file|module> --repo <dir>");
    const { graph } = readArtifacts();
    const kinds = flags.kind ? new Set(flags.kind.split(",").map((k) => k.trim()).filter(Boolean)) : undefined;
    const res = neighborsOf(graph, flags.positional, flags.depth ?? 1, kinds);
    if (!res) throw new Error(`no such file or module in the index: ${flags.positional}`);
    emit(JSON.stringify(res, null, 2) + "\n", flags.out);
  } else if (cmd === "mermaid") {
    const { graph } = readArtifacts();
    emit(renderMermaid(graph, { module: flags.positional }), flags.out);
  } else if (cmd === "grep") {
    if (!flags.positional) throw new Error("grep needs a pattern: cli.mjs grep <pattern> --repo <dir>");
    // `--scope <dir>` is documented as global sugar for `--include '<dir>/**'`;
    // every other command gets it via scanOptions, but grep bypasses the scan
    // and builds its own glob list — so it has to fold the sugar in itself, or
    // the flag would be silently ignored here alone.
    const scopeGlobs = flags.scope ? [`${flags.scope.replace(/\/+$/, "")}/**`] : [];
    const globs = [...scopeGlobs, ...flags.include, ...flags.exclude.map((g) => `!${g}`)];
    const hits = grepRepo(flags.repo, flags.positional, {
      globs: globs.length ? globs : undefined,
      ignoreCase: flags.ignoreCase,
      maxHits: flags.maxHits,
    });
    emit(JSON.stringify(hits, null, 2) + "\n", flags.out);
  } else {
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exitCode = 2;
  }
}
