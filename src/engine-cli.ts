import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileArgReadings, resolveFileArg } from "./patharg.js";
import { SCHEMA_VERSION, EXTRACTOR_VERSION, type FileRecord, type Graph } from "./types.js";
import { ENGINE_VERSION } from "./types.js";
import {
  CORE_GRAMMARS,
  EXTENDED_GRAMMARS,
  ensureGrammars,
  grammarKeysForExts,
  grammarReady,
  resolveGrammarsTier,
  sharedGrammarsCacheDir,
} from "./ast/loader.js";
import { resolveGrammarsPullTarget, pullGrammars } from "./ast/grammars-pull.js";
import { buildArtifactsFromScan, type BuildIndexOptions, type IndexArtifacts } from "./pipeline.js";
import { sha1 } from "./hash.js";
import { renderGraphJson } from "./render/graph-json.js";
import { renderSymbolsJson } from "./render/symbols-json.js";
import { renderScip } from "./render/scip.js";
import { normalizeScope, scanSummary, scanWalkOptions, type RepoScan, type ScanSkip } from "./scan.js";
import { skipHistogram, whyPath } from "./why.js";
import { byKey } from "./sort.js";
import { scanRepoParallel } from "./pool.js";
import {
  indexDirPath,
  inspectPersistedIndex,
  persistedArtifacts,
  preloadSessionLazy,
  readPersistedIndex,
  INDEX_DIR,
  type ArtifactName,
  type PersistedMeta,
  type PersistedArtifacts,
  type PreloadedSession,
  type UnusableIndex,
} from "./preload.js";
import { indexStatus } from "./status.js";
import { freshArtifacts, proveFresh, renderFreshness, FRESHNESS_FILE, type FreshnessScanOptions } from "./freshness.js";
import { classify } from "./classify.js";
import { compatibleEntries, extractionProfile, sameExtractionProfile } from "./cache.js";
import { walk, type WalkResult } from "./walk.js";
import { implementationsOf, typeEntry } from "./relations.js";
import { callPath, neighborhood } from "./symbolgraph.js";
import { buildCallerIndex, buildRawCallerIndex, callerIndexForNames, lookupCallerEntry, rawCallerSitesFor, refNames } from "./callers.js";
import { explainNoCallers, findReferences, findSymbol, rawCallersOf, resolveSymbolRef, symbolAt, symbolsOverview, withCallerIds } from "./query.js";
import { conciseReferences, symbolLocation } from "./mcp/concise.js";
import { formatSymbolRef } from "./symref.js";
import { checkWorkspaceDeps, detectWorkspaces, workspaceReport } from "./workspaces.js";
import { gitChurn } from "./git.js";
import { grepRepo } from "./grep.js";
import { changeCoupling, rankHotspots } from "./coupling.js";
import { renderRepoMap } from "./repomap.js";
import { capDeadCode, findDeadCode } from "./deadcode.js";
import { findLiteralDuplications } from "./literals.js";
import { symbolComplexity, riskHotspots } from "./complexity.js";
import { renderMermaid } from "./viz.js";
import { resolutionReport } from "./resolution.js";
import { hierarchyFor, resolveContextFor, symbolGraphFor } from "./derived.js";
import { EDGE_KINDS, dependencyPath, impactOf, neighborsOf } from "./traverse.js";
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
import { lspStatus, callersWithLsp, referencesWithLsp } from "./lsp/index.js";
import { profileNames, toolsInProfiles } from "./mcp/tools.js";

const HELP = `codeindex engine v${ENGINE_VERSION} — deterministic repo indexing

Usage: codeindex <command> [flags]

Commands:
  index       Build graph.json + symbols.json (+ incremental cache.json, and
              freshness.json: its stamps without the records) into --out
              <dir> in ONE pass — the fast path for repeated runs. Each
              artifact is replaced atomically (temp file + rename). An --out
              inside the repo is excluded from the scan; at the repo root only
              the artifacts are
  scan        Scan summary: file count, language histogram, capped flag, the
              files the walk rejected (excluded) and every skip by reason
              (skipped; a skipped directory counts once). --why <path> says
              why ONE path is or is not indexed ({path, indexed, reason,
              detail}: the deciding .gitignore line, the size over --max-bytes,
              the --scope/--include/--exclude glob, the skipped directory
              above it…); --skipped lists every skip, sorted by path (JSON)
  status      Is the persisted index (--index, default .codeindex) fresh for
              this tree and these flags? JSON: whether cache.json is usable (or
              why not: absent/unreadable/corrupt/schema/extractor), the indexed
              vs HEAD commit, per-file drift (unchanged/touched/modified/added/
              deleted/reextract), artifactsFresh and the reasons it is not.
              Reads freshness.json (else cache.json), walks and stats; hashes
              only stat-changed files, never extracts. --check exits 1 when
              the artifacts are not fresh (a CI gate for a committed index).
              A moved HEAD alone is not stale: read commands restamp
              graph.json's commit
  graph       Full link-graph (graph.json bytes) to stdout or --out
  symbols     Symbol index (symbols.json bytes) to stdout or --out
  scip        SCIP code-intelligence index (protobuf bytes) into --out
              (default index.scip; --out - writes to stdout). Symbols carry
              the nearest manifest's package and their declaration chain;
              subtypes and overrides carry implementation relationships
  callers     Per-symbol caller index (JSON); an optional <symbol> selects one
              (unknown symbol: exit 2; a symbol no site binds to: its defs and
              how many call sites name it anyway); --lsp appends language-server
              incoming calls; --raw lists every call site by name, unresolved;
              --with-caller names each site's enclosing symbol (its id)
  hierarchy   Type hierarchy: extends/implements, and what extends/implements it
  implementations  Everything implementing/extending a type (transitively). A
              Go type implements an interface by assertion (var _ I = (*T)(nil))
              or by method set (name + parameter count, embedding included;
              marked "structural": true)
  callgraph   Bounded symbol-to-symbol neighborhood (--depth up to 5,
              --direction). An 'overrides' edge links a method to the
              supertype method it replaces; --direction out through a method
              reaches its overrides, --direction in to an override reaches
              the base method's callers
  callpath    How does <from> reach <to>: the shortest chains of calls between
              two symbols, following dispatch to overrides ("via":
              "dispatch"), in id order, with pathCount (all equally short
              ones) and truncated past --limit (default 5); --depth caps the
              hops (default 8, max 16; depthClamped). No path: hops null, and
              reverseHops when <to> reaches <from>. --files: two file paths
              and import/use/call edges instead (why does A depend on B; a Go
              import reaches its whole package; inferred calls only with
              --include-inferred, else inferredHops says one would connect)
  find        Declarations by name or Parent/name, each with its complete
              signature, doc, parent and line span (MCP find_symbol): exact
              names first; --substring, --include-body, --concise, --limit
              (default 50). No match answers []
  refs        Who references a symbol (MCP find_references): defs, bound
              callSites, and referencingFiles (file-level mentions, may
              include homonyms); --lsp appends a language server's answer,
              --concise. An unknown name still answers (defs: [])
  outline     Every symbol declared in one file, in declaration order, with
              kind, span, signature, doc and parent (MCP symbols_overview):
              cli.mjs outline <file>; --concise. Unknown file: exit 2
  symbol-at   Which symbol is at <file:line> (or file:line:col): the
              innermost declaration holding the line, its symbol id (what
              callers/callgraph/callpath read) and the declarations around
              it, outermost first; symbol null outside all of them;
              "approximate": true when the file has no AST spans (MCP
              symbol_at)
              A <symbol> above is any of: name, name@file, file#name,
              file#Parent/name (a callgraph id), Parent/name
  workspaces  Monorepo packages + dependency graph (JSON), with warnings for
              malformed manifests. --check compares each package's declared
              sibling dependencies with the imports it really makes
              (undeclared / unusedDeclared) and exits 1 on an undeclared one
  churn       Per-file git commit counts (JSON; --since <ref> to bound)
  grep        Search: cli.mjs grep <pattern> --repo <dir> (JSON hits)
  search      Keyless BM25 lexical search over symbol names, path segments,
              markdown/reST headings and summaries: cli.mjs search "<query>" --repo <dir>.
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
              at one; CODEINDEX_LSP_CONFIG=off disables it). It annotates QUERY
              answers only and never touches graph.json/symbols.json.
              CODEINDEX_LSP_TIMEOUT_MS / CODEINDEX_LSP_STARTUP_TIMEOUT_MS
              override every server's timeoutMs / startupTimeoutMs:
                lsp status     Config path and source, each server with whether
                               its command is on PATH and how many files it
                               claims, and the languages nothing covers (JSON).
                               --probe also starts each server to read the
                               capabilities it really advertises
  grammars    Tree-sitter wasm grammars (optional AST tier; regex without them).
              Two tiers: CORE ships with the bundle; EXTENDED (kotlin, elixir,
              zig, solidity, hcl/terraform) arrives only via \`grammars pull\`.
              Precedence: bundle-adjacent > CODEINDEX_GRAMMARS_DIR > shared cache,
              per grammar — a pulled EXTENDED wasm is found even when the
              core ones ship next to the bundle:
                grammars status  Active tier (adjacent/env/cache/none), resolved
                                 dir, pinned ENGINE_VERSION, pull-needed, and
                                 extendedPullNeeded when an EXTENDED grammar is
                                 still missing (JSON)
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
              call site binds AND no other file names it) and 'uncalled'
              (named elsewhere — import, type position, base-class list,
              same-name call site — but no call binds). Callables only unless
              --kinds all; test and tail files (--include-tail), the package's
              public API (manifest entry points and what they re-export),
              language protocol names (__dunder__, Go init/main, constructor)
              and overrides of live methods are never candidates. --limit <n> caps the list as
              {total, shown, truncated, candidates}
  complexity  Cyclomatic-complexity estimates, most-complex first. Pass a file
              positional for one file; omit for the repo-wide top (--limit,
              default 50). Counts code only (comments, docstrings and strings
              aside; Python/Ruby/Lua and/or count like && and ||); classes and
              other containers are not ranked, and a nested function scores on
              its own, not inside its parent
  risk        Complexity × git-churn ranking (JSON; --since <ref> to bound),
              with the same code-only branch counts per file
  delta       Review panel for the git diff: changed files -> enclosing symbols ->
              blast radius -> risk score with explained reasons
              (--base <ref> | --staged, --depth <n>, --json)
  impact      Reverse dependency closure of a file or module: everything that
              transitively imports/uses/calls it; a Go import reaches every
              file of its package. Calls inferred from a name alone are
              counted (inferredDependents), not followed, unless
              --include-inferred (--depth <n>; JSON; MCP impact)
  neighbors   Graph neighbours of a file or module, both directions: every
              edge kind linking each neighbour, strongest evidence first
              (--depth <n>, --kind import,call,use,extends,implements,
              doc-link,mention; JSON; MCP neighbors)
              File arguments (complexity, outline, symbol-at, impact, neighbors) may be
              written ./path, repo-absolute or with backslashes
  resolution  How much of each language's imports resolved: resolved /
              external / dangling (by reason) / unsupported counts, the top
              dangling specs and external packages, and the config warnings
              that silently turn imports external — whether the graph can be
              trusted for a language (--lang <name>, --limit <n> per list,
              default 10; JSON)
  mermaid     Mermaid diagram of the module graph; pass a module slug, module
              directory or file positional to focus on one neighborhood (an
              unknown target is an error)
  rewrite     Map an expensive tree-wide search onto its indexed equivalent:
              cli.mjs rewrite '<command line>'. Prints the replacement command
              and exits 0, or exits 1 when it has no opinion (run the original).
              Deliberately conservative — any shell metacharacter or unknown
              flag refuses the rewrite
  mcp         Run as an MCP server over stdio (39 tools: scan_summary,
              index_status, graph, symbols, callers, workspaces, churn,
              symbols_overview, find_symbol, find_references, symbol_at,
              lsp_status, onboard, repo_map, hotspots, coupling, dead_code,
              complexity, duplicated_literals, mermaid, grep, search,
              explain_search, embed_status, check_rules, resolution_report,
              type_hierarchy, implementations, call_graph, call_path, impact,
              neighbors, the memory quartet and the three symbolic-edit
              writes). Flags: --repo <dir> pins ONE
              repository so the per-tool repo argument becomes optional (an
              explicit per-call repo still wins); --server-name <name> overrides
              the announced serverInfo; --max-response-bytes <n> caps a single
              tool response (default 1e6; a response under the cap is
              byte-identical, one over it is replaced by an actionable notice,
              sent as a tool error, instead of an unusable blob);
              --tools <profile[,profile]>
              advertises a named subset (all | orient | find | impact | edit |
              risk | memory, default all) — every advertised tool's schema costs an agent
              context on EVERY turn, and a tool left out is still answerable
              when called by name; --watch watches the pinned repo so a call
              skips the whole-tree walk when nothing changed since the last one
              (Linux; elsewhere it only invalidates eagerly)
  version     Print the engine version

Flags (accepted before OR after the subcommand: '--repo X scan' and
'scan --repo X' are equivalent):
  --repo <dir>        Repo root (default: cwd)
  --out <file>        Write output to a file instead of stdout (\`scip\`: --out -
                      writes the binary index to stdout)
  --project-root <uri> \`scip\`: override Metadata.project_root (default
                      file://<repo>); pin it for a byte-reproducible index
  --include <glob>    Only include matching paths (repeatable). Globs are rooted
                      at the repo: '*.ts' is top-level files only, '**/*.ts'
                      any depth
  --exclude <glob>    Exclude matching paths (repeatable)
  --scope <path>      Restrict to one directory or file of the repo ('./src',
                      'src/' and an absolute path inside the repo work too).
                      Combined with --include/--exclude as an intersection
                      (\`grep\`: added to its globs instead)
  --no-gitignore      Do not honor .gitignore files (default: honored)
  --ignore-dir <name> Directory names to skip (repeatable) — REPLACES the
                      default ignored-directory set, never merges with it
                      (\`.git\` and \`.codeindex\` stay skipped regardless).
                      A name, not a path: use --exclude '<dir>/**' for a path.
                      The default set skips build/out/target/tmp only where
                      git tracks nothing in them; a listed name is skipped
                      everywhere
  --max-files <n>     Cap indexed files, counted after --scope/--include/
                      --exclude (default: none — the whole tree is indexed;
                      a cap sets the \`capped\` flag)
  --max-bytes <n>     Skip files above this size (default 1 MiB)
  --max-calls <n>     Per-file call-site cap for extraction (default 512); a
                      capped file keeps one site per distinct callee first
  --no-ast            Skip tree-sitter grammars even when present (regex tier)
  --workers <n>       \`index\`: extraction worker threads (default: cores-1,
                      capped at 8; 0 or 1 forces the single-threaded path).
                      Also settable with CODEINDEX_WORKERS. Artifacts are
                      byte-identical either way
  --index <dir>       Persisted index the READ commands reuse, relative to the
                      repo or absolute (default .codeindex — i.e. what
                      \`index --out\` wrote there). A fresh index turns the scan
                      into a stat pass and, when it still matches the worktree,
                      skips the pipeline entirely. Stale/absent/corrupt → a
                      normal cold build (with a note on stderr when --index was
                      given). The dir itself is never scanned. Records built
                      with another --no-ast/--max-calls setting or grammar set
                      are re-extracted, never reused
  --no-index-cache    Never reuse a persisted index; always build from scratch
                      (\`index\` too: its cache.json is ignored, then rewritten)
  --full-hash         Re-read and re-hash every file instead of trusting an
                      unchanged (size, mtime) — for an edit that kept both.
                      Unchanged content still reuses its extraction
  --check             \`status\`: exit 1 unless the artifacts are fresh;
                      \`workspaces\`: check declared vs imported dependencies
  --why <path>        \`scan\`: explain why one path (repo-relative or absolute)
                      is or is not indexed
  --skipped           \`scan\`: list every path the scan leaves out, and why
  --config <file>     Rules config for \`rules\` (JSON: [{name, from, to, …}])
  --limit <n>         Max results: \`search\` (default 20), \`complexity\` (50),
                      \`risk\` (20), \`deadcode\` (default all), \`find\` (50),
                      \`callpath\` (5 paths listed); entries per top list for
                      \`resolution\` (default 10)
  --lang <name>       \`resolution\`: report one language (as \`scan\` names it)
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
  --lsp               \`callers <name>\`: append incoming calls from a configured
                      language server; requires a symbol target. \`refs\`: append
                      the server's references and an agreement matrix
  --recall            \`callers\`: recall-oriented binding (issue #7) — adds the
                      name-only matches the default rejects (a unique JS/TS name
                      with no import, a same-file homonym whatever the receiver,
                      a proximity guess in Go or into tests) and labels each
                      site corroborated|unique-name
  --raw               \`callers\`: every call site by callee name, with no binding
                      at all (receiver and enclosing symbol per site)
  --ignore-case       \`grep\`: case-insensitive matching
  --max-hits <n>      \`grep\`: cap returned hits (default 200)
  --min-files <n>     \`literals\`: distinct files a value must span (default 2)
  --min-count <n>     \`literals\`: total occurrences required (default 3)
  --include-tests     \`literals\`: count test files too. Off by default — a test
                      restating a value is usually asserting it deliberately
  --include-inferred  \`impact\`, \`callpath --files\`: also follow call edges
                      inferred from a name alone (graph.json confidence
                      "inferred")
  --kinds <k>         \`deadcode\`: callable (default: functions, methods,
                      classes, function-valued consts) | all (types, properties
                      and constants too — reported only when unreferenced)
  --include-tail      \`deadcode\`: also report examples, docs, fixtures and
                      scripts (test files are always roots)
  --substring         \`find\`: match the last name segment by inclusion,
                      case-insensitive
  --include-body      \`find\`: attach each declaration's source lines
  --concise           \`find\`, \`refs\`, \`outline\`: declarations as
                      name/kind/file/line only
  --files             \`callpath\`: walk the file link-graph between two files
  --with-caller       \`callers\`: add "caller" to each site, the symbol id of the
                      declaration the call sits in (a callgraph node)
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
  fullHash?: boolean; // re-read and re-hash every file (no (size, mtime) fastpath)
  check?: boolean; // status: exit 1 unless fresh; workspaces: compare declared deps with real imports
  why?: string; // scan: explain one path
  skipped?: boolean; // scan: list every skip
  since?: string;
  ignoreCase?: boolean;
  maxHits?: number;
  budgetTokens?: number;
  config?: string; // rules config path
  limit?: number; // search result cap
  minFiles?: number; // literals: distinct-file floor for a duplication
  minCount?: number; // literals: total-occurrence floor for a duplication
  includeTests?: boolean; // literals: count test files too (off by default)
  includeInferred?: boolean; // impact: follow name-inferred call edges too (off by default)
  includeTail?: boolean; // deadcode: report tail files (examples, docs, fixtures, scripts) too
  kinds?: "callable" | "all"; // deadcode: candidate kinds (default callable)
  fuzzy: boolean; // search: trigram fuzzy fallback for df==0 terms (default true)
  exact?: boolean; // search: drop results carrying no verbatim term match
  explain?: boolean; // search: emit { results, explain } instead of a bare array
  semantic: boolean; // search: RRF-fuse the static-embedding tier (default false)
  lsp?: boolean; // callers: append language-server incoming calls
  recall?: boolean; // callers: recall-oriented binding
  raw?: boolean; // callers: unresolved call sites by name
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
  lang?: string; // resolution: one language's row
  positional?: string; // e.g. the grep pattern or search query
  positionals: string[]; // every positional; only `callpath` takes two
  substring?: boolean; // find: match the name by inclusion
  includeBody?: boolean; // find: attach each declaration's source
  concise?: boolean; // find/refs/outline: name/kind/file/line only
  files?: boolean; // callpath: walk the file graph instead of the symbol graph
  withCaller?: boolean; // callers: name each site's enclosing symbol
}

function parseFlags(args: string[]): CliFlags {
  const flags: CliFlags = { repo: process.cwd(), include: [], exclude: [], gitignore: true, ignoreDirs: [], noAst: false, fuzzy: true, semantic: false, positionals: [] };
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
    // A trailing separator (`build/`, shell completion's spelling) still names
    // the directory `build`; the walk compares bare names.
    else if (a === "--ignore-dir") flags.ignoreDirs.push(next().replace(/(.)[\\/]+$/, "$1"));
    else if (a === "--max-files") flags.maxFiles = num();
    else if (a === "--max-bytes") flags.maxBytes = num();
    else if (a === "--max-calls") flags.maxCalls = num();
    else if (a === "--ignore-case") flags.ignoreCase = true;
    else if (a === "--max-hits") flags.maxHits = num();
    else if (a === "--budget-tokens") flags.budgetTokens = num();
    else if (a === "--min-files") flags.minFiles = num();
    else if (a === "--min-count") flags.minCount = num();
    else if (a === "--include-tests") flags.includeTests = true;
    else if (a === "--include-inferred") flags.includeInferred = true;
    else if (a === "--include-tail") flags.includeTail = true;
    else if (a === "--kinds") {
      const v = next();
      if (v !== "callable" && v !== "all") throw new Error(`--kinds expects callable|all, got "${v}"`);
      flags.kinds = v;
    }
    else if (a === "--no-ast") flags.noAst = true;
    else if (a === "--index") flags.indexDir = next();
    else if (a === "--no-index-cache") flags.noIndexCache = true;
    else if (a === "--full-hash") flags.fullHash = true;
    else if (a === "--check") flags.check = true;
    else if (a === "--why") flags.why = next();
    else if (a === "--skipped") flags.skipped = true;
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
    else if (a === "--lsp") flags.lsp = true;
    else if (a === "--recall") flags.recall = true;
    else if (a === "--raw") flags.raw = true;
    else if (a === "--run") flags.run = true;
    else if (a === "--probe") flags.probe = true;
    else if (a === "--base") flags.base = next();
    else if (a === "--staged") flags.staged = true;
    else if (a === "--depth") flags.depth = num();
    else if (a === "--kind") {
      // Validated here, like --direction: an unknown kind filtered the walk
      // down to nothing and answered an empty list on exit 0.
      const v = next();
      const kinds = v.split(",").map((k) => k.trim()).filter(Boolean);
      const bad = kinds.filter((k) => !(EDGE_KINDS as readonly string[]).includes(k));
      if (!kinds.length || bad.length) throw new Error(`--kind expects a comma-separated list of ${EDGE_KINDS.join("|")}, got "${bad.join(",") || v}"`);
      flags.kind = kinds.join(",");
    }
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
    else if (a === "--lang") flags.lang = next();
    else if (a === "--substring") flags.substring = true;
    else if (a === "--include-body") flags.includeBody = true;
    else if (a === "--concise") flags.concise = true;
    else if (a === "--files") flags.files = true;
    else if (a === "--with-caller") flags.withCaller = true;
    // A second positional is kept, not rejected here: `callpath <A> <B>`
    // takes two. runCli refuses it for every other command.
    else if (!a.startsWith("--") && flags.positionals.length < 2) {
      flags.positionals.push(a);
      flags.positional ??= a;
    } else throw new Error(`unknown flag: ${a}`);
  }
  return flags;
}

function emit(content: string | Uint8Array, out?: string): void {
  if (out) writeFileSync(out, content);
  else process.stdout.write(content);
}

// Replace an index artifact in one step: write a sibling temp file, then
// rename it over the target (atomic on POSIX). graph.json, symbols.json and
// cache.json used to be truncated and rewritten in place, so a reader polling
// them mid-index — CI, an editor plugin, the MCP server's artifact preload —
// saw an empty or half-written file, and a crash mid-write left torn JSON until
// the next index. The temp name is one the self-index guard skips (scan.ts), so
// even an --out at the repo root never indexes a leftover. Where the temp file
// or the rename is refused (a Windows reader holding the target open), fall
// back to the historical in-place write rather than failing the index.
function writeArtifact(path: string, data: string | Uint8Array): void {
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, data);
    renameSync(temp, path);
    return;
  } catch {
    rmSync(temp, { force: true });
  }
  writeFileSync(path, data);
}

// Path flags that cannot mean what was typed, reported once on stderr (stdout
// carries the command's output). Each used to be a silent empty or unfiltered
// result: `--ignore-dir src/gen` compares directory NAMES and so skipped
// nothing, while still replacing the default set; a mistyped --scope
// answered for zero files with exit 0.
function warnPathFlags(flags: CliFlags): void {
  for (const name of flags.ignoreDirs) {
    if (!/[\\/]/.test(name)) continue;
    process.stderr.write(
      `codeindex: warning: --ignore-dir takes a directory name, and "${name}" is a path that matches nothing — use --exclude '${name}/**' to leave that directory out\n`,
    );
  }
  if (flags.scope === undefined) return;
  const scope = normalizeScope(flags.repo, flags.scope);
  if (scope === ".." || scope.startsWith("../") || isAbsolute(scope)) {
    process.stderr.write(`codeindex: warning: --scope ${flags.scope} is outside --repo ${flags.repo} — nothing matches\n`);
  } else if (scope && !/[*?[]/.test(scope) && !existsSync(join(flags.repo, scope))) {
    process.stderr.write(`codeindex: warning: --scope ${flags.scope} does not exist under ${flags.repo} — nothing matches\n`);
  }
}

// The warning for a scan that kept no file at all. Include globs are rooted at
// the repo, which is the usual surprise: `*.py` is the top-level files only.
function warnEmptyScan(flags: CliFlags): void {
  const rooted = flags.include.find((g) => !g.includes("/"));
  process.stderr.write(
    `codeindex: warning: no file of ${flags.repo} was indexed — check --scope/--include/--exclude and the ignore rules` +
      (rooted ? ` (globs are rooted at the repo: '${rooted}' matches top-level paths only, '**/${rooted}' any depth)` : "") +
      "\n",
  );
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
    fullHash: flags.fullHash,
    // The index the read commands consult is excluded from what they scan,
    // exactly as `index` excludes its --out (which overrides this there). An
    // in-repo custom dir (`index --out idx` + `--index idx`) was otherwise
    // scanned as three config files: search answered "graph" with
    // idx/graph.json, and the scan never matched the index that `index` built
    // without them, so its artifacts were never reused. The default
    // .codeindex is pruned by the walk already; this is a no-op there.
    out: indexDirPath(flags.repo, flags.indexDir),
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
// Commands that walk the tree but never extract a file: no grammar warm, and so
// no warm-up walk either — they walk once, themselves.
const WALK_ONLY_COMMANDS = new Set(["scan", "status"]);

// The one-line reason a NAMED --index could not be used (see tryPreload).
const UNUSABLE_INDEX: Record<UnusableIndex, string> = {
  absent: "no cache.json there",
  unreadable: "cache.json cannot be read",
  corrupt: "cache.json is not a valid index",
  schema: "written for another schema version",
  extractor: "written by another extractor version",
};

// `index` over an index with nothing to write: every kept file at its recorded
// (size, mtime), each code file extracted at the tier this run uses, the same
// extraction profile and commit, and artifacts (embeddings included) that are
// the recorded bytes. That is the fastpath with a clean cache — no cache.json
// rewrite, no artifact written — proven from freshness.json alone, so the
// 142MB cache.json of typescript-go is never parsed for it. Returns the proven
// tree's size, or undefined to take the full path.
function unchangedIndex(
  repo: string,
  opts: FreshnessScanOptions,
  maxCalls: number | undefined,
  outDir: string,
  embedFresh: (embed: PersistedMeta["embed"]) => boolean,
): { files: number; capped: boolean } | undefined {
  // Grammars are warmed by now: the tier is known, not predicted.
  const proof = proveFresh(repo, opts, grammarReady, outDir);
  if (!proof) return undefined;
  const { fresh, walked, drift } = proof;
  const kinds = walked.map((f) => ({ kind: classify(f.rel, f.ext), ext: f.ext }));
  if (
    drift.unchanged !== walked.length ||
    drift.indexed !== walked.length ||
    fresh.meta.commit !== proof.commit ||
    !sameExtractionProfile(fresh.meta.extraction, extractionProfile(kinds, maxCalls, grammarReady)) ||
    !embedFresh(fresh.meta.embed)
  ) {
    return undefined;
  }
  const onDisk = persistedArtifacts(repo, { contentUnchanged: true, commit: proof.commit }, fresh.meta, outDir);
  if (!onDisk?.bytes("symbols") || !onDisk.bytes("graph")) return undefined;
  return { files: walked.length, capped: proof.capped };
}

// Flags for `codeindex mcp`. Kept separate from parseFlags on purpose (see the
// dispatch site). `--repo` is resolved to an absolute path and must exist: a
// server pinned to a typo'd directory would otherwise answer every tool call
// with the same confusing per-call error instead of failing at startup.
export function parseMcpFlags(argv: string[]): {
  defaultRepo?: string;
  serverInfo?: { name?: string };
  maxResponseBytes?: number;
  profile?: string;
  watch?: boolean;
} {
  let defaultRepo: string | undefined;
  let name: string | undefined;
  let maxResponseBytes: number | undefined;
  let profile: string | undefined;
  let watch = false;
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
    } else if (a === "--tools") {
      const v = argv[++i];
      if (!v) throw new Error(`--tools requires a profile: ${profileNames().join(", ")}`);
      // Validate HERE, at startup, rather than on the first tools/list: a typo'd
      // profile that silently advertised everything would look like it worked.
      toolsInProfiles(v);
      profile = v === "all" ? undefined : v;
    } else if (a === "--watch") {
      watch = true;
    } else {
      throw new Error(`unknown flag for \`mcp\`: ${a}`);
    }
  }
  if (defaultRepo && !existsSync(defaultRepo)) throw new Error(`--repo path does not exist: ${defaultRepo}`);
  if (watch && !defaultRepo) throw new Error("--watch requires --repo <dir>");
  return { defaultRepo, serverInfo: name ? { name } : undefined, maxResponseBytes, profile, watch };
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
  "--tools",
  "--workers",
  "--index",
  "--max-response-bytes",
  "--base",
  "--depth",
  "--kind",
  "--rank",
  "--direction",
  "--lang",
  "--why",
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
  if (flags.positionals.length > 1 && cmd !== "callpath") throw new Error(`unknown flag: ${flags.positionals[1]}`);
  if (!existsSync(flags.repo)) throw new Error(`--repo path does not exist: ${flags.repo}`);
  if (!statSync(flags.repo).isDirectory()) throw new Error(`--repo path is not a directory: ${flags.repo}`);
  warnPathFlags(flags);

  // Warm ONLY the grammars for languages actually present, and only for commands
  // that scan the file tree. Scan-less commands (grep, churn, coupling,
  // workspaces, embed status|pull|serve) load no grammar at all; version/help/mcp
  // already returned above. The walk is done ONCE here to derive the present
  // extensions, then handed to the scan via precomputedWalk so the tree is
  // traversed a single time. --no-ast keeps the regex tier: no walk, no warm —
  // scanRepo walks itself, exactly as before.
  // `workspaces --check` reads the link-graph, so it scans like any graph command.
  const scans =
    (!SCANLESS_COMMANDS.has(cmd) || (cmd === "workspaces" && flags.check === true)) &&
    !(cmd === "embed" && flags.positional !== "build");
  let precomputedWalk: WalkResult | undefined;
  if (scans && !flags.noAst && !WALK_ONLY_COMMANDS.has(cmd)) {
    // The scan's own walk options, path filter included, so the grammars
    // warmed are those of the files in scope and the scan can reuse this walk.
    precomputedWalk = walk(flags.repo, scanWalkOptions(flags.repo, scanOptions(flags)));
  }
  let grammarsWarmed = false;
  const warmPresentGrammars = async (): Promise<void> => {
    if (grammarsWarmed || flags.noAst || !precomputedWalk) return;
    await ensureGrammars(grammarKeysForExts(precomputedWalk.files.map((f) => f.ext)));
    grammarsWarmed = true;
  };

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
  type Preloaded = Pick<PreloadedSession, "scan" | "arts" | "loadArtifacts" | "artifacts">;
  let preloadTried = false;
  let preloadPromise: Promise<Preloaded | undefined> | undefined;
  let preloaded: Preloaded | undefined;
  // A read command answering from a scan that kept no file says so once, as
  // `index` and `scan` do: an empty answer otherwise looks like "no match".
  let warnedEmpty = false;
  const noteEmpty = (scan: RepoScan): RepoScan => {
    if (scan.files.length === 0 && !warnedEmpty) {
      warnedEmpty = true;
      warnEmptyScan(flags);
    }
    return scan;
  };
  const tryPreload = async (): Promise<typeof preloaded> => {
    if (preloadPromise) return preloadPromise;
    if (preloadTried) return preloaded;
    preloadTried = true;
    if (flags.noIndexCache) return undefined;
    preloadPromise = preloadSessionLazy(
      flags.repo,
      { ...scanOptions(flags, precomputedWalk), workers: flags.workers, ast: !flags.noAst },
      warmPresentGrammars,
      indexDir,
    ).then((p) => {
      if (p) preloaded = { scan: noteEmpty(p.scan), arts: p.arts, loadArtifacts: p.loadArtifacts, artifacts: p.artifacts };
      // The default location being empty is the normal first run; an index the
      // user NAMED being unusable is a mistake worth one line (a typo'd path
      // otherwise just looks like a slow command).
      else if (flags.indexDir !== undefined) {
        const read = inspectPersistedIndex(flags.repo, indexDir);
        const why = UNUSABLE_INDEX["unusable" in read ? read.unusable : "unreadable"];
        process.stderr.write(
          `codeindex: no usable index at ${indexDirPath(flags.repo, indexDir)} (${why}) — building from scratch\n`,
        );
      }
      return preloaded;
    });
    return preloadPromise;
  };
  let readScanPromise: Promise<RepoScan> | undefined;
  const readScan = async (): Promise<RepoScan> => {
    const preloadedScan = (await tryPreload())?.scan;
    if (preloadedScan) return preloadedScan;
    return (readScanPromise ??= warmPresentGrammars().then(() =>
      scanRepoParallel(flags.repo, {
        ...scanOptions(flags, precomputedWalk),
        workers: flags.workers,
      }).then(noteEmpty),
    ));
  };
  let readArtifactsPromise: Promise<IndexArtifacts> | undefined;
  const readArtifacts = async (): Promise<IndexArtifacts> => {
    const p = await tryPreload();
    if (p?.arts) return p.arts;
    if (p) return (p.arts ??= p.loadArtifacts?.() ?? buildArtifactsFromScan(p.scan, scanOptions(flags, precomputedWalk)));
    return (readArtifactsPromise ??= readScan().then((scan) => buildArtifactsFromScan(scan, scanOptions(flags, precomputedWalk))));
  };
  // The artifacts of an index that freshness.json alone proves fresh — no
  // cache.json parse, no records (see freshness.ts). Tried first, at most once,
  // by the commands that need nothing but artifacts; undefined sends them to
  // the preload, which reaches the same verdict the slower way.
  let freshTried = false;
  let fresh: PersistedArtifacts | undefined;
  const freshIndex = (): PersistedArtifacts | undefined => {
    if (!freshTried) {
      freshTried = true;
      const proven = flags.noIndexCache
        ? undefined
        : freshArtifacts(flags.repo, { ...scanOptions(flags, precomputedWalk), ast: !flags.noAst }, indexDir);
      if (proven?.fileCount === 0 && !warnedEmpty) {
        warnedEmpty = true;
        warnEmptyScan(flags);
      }
      fresh = proven?.artifacts;
    }
    return fresh;
  };
  // A command that needs ONE artifact reads only that file of a fresh index:
  // readArtifacts loads both, so `rules` or `impact` parsed an 80MB
  // symbols.json they never looked at. Anything the persisted index cannot
  // vouch for falls back to readArtifacts, unchanged.
  const readGraph = async (): Promise<Graph> => {
    const graph = freshIndex()?.graph();
    if (graph) return graph;
    const p = await tryPreload();
    return p?.arts?.graph ?? p?.artifacts?.graph() ?? (await readArtifacts()).graph;
  };
  // An artifact the command prints whole: the verified on-disk bytes ARE the
  // render of a fresh build (see PersistedArtifacts.bytes), so they are written
  // out as they are instead of being parsed and re-rendered: about a second
  // each on typescript-go's 80MB symbols.json, plus the GC, for the same bytes.
  const readArtifactBytes = async (name: ArtifactName): Promise<Buffer | undefined> =>
    freshIndex()?.bytes(name) ?? (await tryPreload())?.artifacts?.bytes(name);

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
    type CacheMeta = Pick<PersistedMeta, "engineVersion" | "commit" | "graphSha1" | "symbolsSha1" | "embed">;
    await warmPresentGrammars();
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
    // Whether embeddings.bin is what this run would write: no model, or the
    // recorded sidecar of this model on disk.
    const embedFresh = (embed: CacheMeta["embed"]): boolean =>
      !model ||
      (embed !== undefined &&
        embed.embedVersion === EMBED_VERSION &&
        embed.modelId === model.modelId &&
        embed.sha1 !== undefined &&
        artifactSha(embedPath) === embed.sha1);

    // NOTHING TO WRITE, decided from freshness.json before cache.json is even
    // parsed: 2.3s plus a second of GC on typescript-go, for a run that then
    // wrote nothing. The fastpath below with a clean cache, exactly — see
    // unchangedIndex — so anything short of it takes the full path.
    const unchanged = flags.noIndexCache || flags.fullHash
      ? undefined
      : unchangedIndex(flags.repo, { ...scanOptions(flags, precomputedWalk), out: outDir }, flags.maxCalls, outDir, embedFresh);
    if (unchanged) {
      if (unchanged.files === 0) warnEmptyScan(flags);
      process.stderr.write(
        `codeindex: ${unchanged.files} files → ${outDir}/graph.json + symbols.json${unchanged.capped ? " (capped)" : ""} (unchanged — artifacts reused)\n`,
      );
      return;
    }

    // --no-index-cache is the documented "always build from scratch": it used
    // to be read only by the query commands, so `index` kept trusting a
    // cache.json whose (size, mtime) keys hid a same-size edit made under a
    // restored mtime, with no escape hatch short of deleting the file by hand.
    const persisted = flags.noIndexCache ? undefined : readPersistedIndex(flags.repo, outDir);
    const meta: CacheMeta = persisted?.meta ?? {};
    // Grammars are loaded (or deliberately not, under --no-ast), so the tier
    // this run extracts each language at is known exactly: keep only records
    // extracted the same way — see compatibleEntries.
    const cache = persisted && compatibleEntries(persisted.cacheMap, persisted.meta.extraction, {
      maxCallsPerFile: flags.maxCalls,
      ast: grammarReady,
    });
    const scan = await scanRepoParallel(flags.repo, {
      ...scanOptions(flags, precomputedWalk),
      cache,
      out: outDir,
      workers: flags.workers,
    });
    const extraction = extractionProfile(scan.files, flags.maxCalls, grammarReady);
    if (scan.files.length === 0) warnEmptyScan(flags);
    const freshnessPath = join(outDir, FRESHNESS_FILE);
    // freshness.json (see freshness.ts) for the cache.json now on disk: always
    // written after it, and only when its bytes change — so a fastpath run on an
    // index that predates it adds it, and an unchanged index rewrites nothing.
    const writeFreshness = (out: Pick<CacheMeta, "graphSha1" | "symbolsSha1" | "embed">): void => {
      let cacheStat: { size: number; mtimeMs: number };
      try {
        cacheStat = statSync(cachePath);
      } catch {
        return;
      }
      const text = renderFreshness(scan, out, extraction, { size: cacheStat.size, mtimeMs: cacheStat.mtimeMs });
      let current: string | undefined;
      try {
        current = readFileSync(freshnessPath, "utf8");
      } catch {
        current = undefined;
      }
      if (current !== text) writeArtifact(freshnessPath, text);
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
      writeArtifact(
        cachePath,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          extractorVersion: EXTRACTOR_VERSION,
          engineVersion: ENGINE_VERSION,
          commit: scan.commit,
          graphSha1: out.graphSha1,
          symbolsSha1: out.symbolsSha1,
          embed: out.embed,
          extraction,
          files,
        }) + "\n",
      );
      writeFreshness(out);
    };

    // FASTPATH GUARD — skip the whole downstream pipeline only when this scan
    // is proven identical to the run that wrote the on-disk artifacts:
    // contentUnchanged means this scan's records are object-identical to that
    // run's; downstream is a pure function of (records, docText, commit,
    // meta-opts) and the CLI never sets meta/previousCommunities;
    // engineVersion pins the version stamp; the shas prove the on-disk bytes
    // are that run's output (persistedArtifacts, the guard the read commands
    // use). graph.json also embeds the commit, so under a new HEAD over the
    // same tree only its stamp changes: it is restamped from its own parse
    // and symbols.json kept, where the whole pipeline used to rerun (4.5s on
    // typescript-go, after every commit of already-indexed edits). ANY other
    // failure — deleted or tampered artifacts included — falls through to the
    // full build, which rewrites everything (self-healing).
    const embedUnchanged = embedFresh(meta.embed);
    const onDisk = embedUnchanged ? persistedArtifacts(flags.repo, scan, meta, outDir) : undefined;
    const symbolsReused = onDisk?.bytes("symbols") !== undefined;
    const fastpath = symbolsReused && onDisk!.bytes("graph") !== undefined;
    const restampedGraph = symbolsReused && !fastpath && meta.commit !== scan.commit ? onDisk!.graph() : undefined;

    if (fastpath) {
      // Artifacts verified byte-identical to what this build would produce —
      // leave them untouched. Rewrite cache.json only when the scan says its
      // bytes would change (e.g. an mtime drifted) or its extraction profile
      // would (a cache written before profiles existed, or a --max-calls switch
      // on a tree with no code to re-extract); the meta is carried forward
      // verbatim since the guard just proved it describes the disk.
      if (scan.cacheDirty || !sameExtractionProfile(persisted?.meta.extraction, extraction)) writeCache(meta);
      else writeFreshness(meta);
      process.stderr.write(
        `codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${scan.capped ? " (capped)" : ""} (unchanged — artifacts reused)\n`,
      );
    } else if (restampedGraph) {
      const graphJson = renderGraphJson(restampedGraph);
      writeArtifact(graphPath, graphJson);
      writeCache({ graphSha1: sha1(graphJson), symbolsSha1: meta.symbolsSha1, embed: meta.embed });
      process.stderr.write(
        `codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${scan.capped ? " (capped)" : ""} (unchanged at a new commit — graph.json restamped, symbols.json reused)\n`,
      );
    } else {
      const { graph, symbols } = buildArtifactsFromScan(scan);
      const graphJson = renderGraphJson(graph);
      const symbolsJson = renderSymbolsJson(symbols);
      writeArtifact(graphPath, graphJson);
      writeArtifact(symbolsPath, symbolsJson);
      // Deterministic embeddings sidecar: written next to graph.json ONLY when a
      // model asset is present (opt-in). Silently skipped otherwise — no model, no
      // embeddings.bin, no impact on the graph/symbols consumers.
      let embedNote = "";
      let embedMeta: CacheMeta["embed"];
      if (model) {
        const index = buildEmbeddingIndex(scan, model);
        const bytes = serializeEmbeddings(index);
        writeArtifact(embedPath, bytes);
        embedMeta = { embedVersion: EMBED_VERSION, modelId: model.modelId, sha1: sha1(bytes) };
        embedNote = ` + embeddings.bin (${index.records.length} records, model ${model.modelId})`;
      }
      // cache.json is written LAST so its meta always describes artifacts that
      // are already on disk — a crash mid-way leaves stale meta whose shas
      // fail the guard on the next run (safe: it just rebuilds).
      writeCache({ graphSha1: sha1(graphJson), symbolsSha1: sha1(symbolsJson), embed: embedMeta });
      process.stderr.write(`codeindex: ${scan.files.length} files → ${outDir}/graph.json + symbols.json${embedNote}${scan.capped ? " (capped)" : ""}\n`);
      // Config the resolver could not use (an unparseable tsconfig, a missing
      // `extends` base…) turns resolvable imports into externals without a
      // trace in the artifacts. The build just paid for the resolve context, so
      // saying so costs nothing; `resolution` reports the same list on demand.
      for (const w of [...new Set(resolveContextFor(scan).warnings)].sort()) {
        process.stderr.write(`codeindex: warning: ${w}\n`);
      }
    }
  } else if (cmd === "scan") {
    if (flags.why !== undefined && flags.skipped) throw new Error("scan takes --why <path> or --skipped, not both");
    if (flags.why !== undefined) {
      emit(JSON.stringify(whyPath(flags.repo, flags.why, scanOptions(flags)), null, 2) + "\n", flags.out);
    } else {
      // Summary-only: a file count and a language histogram need the walk and
      // the path-based classifiers, never a read or a parse. Same numbers as
      // before by construction — scanSummary and scanRepo share the keptFiles
      // loop. The skips are observed on the same walk.
      const skips: ScanSkip[] = [];
      const s = scanSummary(flags.repo, { ...scanOptions(flags), onSkip: (skip) => skips.push(skip) });
      if (s.fileCount === 0) warnEmptyScan(flags);
      if (flags.skipped) {
        emit(JSON.stringify(skips.sort(byKey((skip) => skip.rel)), null, 2) + "\n", flags.out);
      } else {
        const summary = {
          engineVersion: ENGINE_VERSION,
          commit: s.commit,
          fileCount: s.fileCount,
          languages: s.languages,
          capped: s.capped,
          excluded: s.excluded,
          skipped: skipHistogram(skips),
        };
        emit(JSON.stringify(summary, null, 2) + "\n", flags.out);
      }
    }
  } else if (cmd === "status") {
    // The index the read commands would consult, judged under THIS run's scan
    // flags: an index built with --scope src is stale for a whole-repo read.
    const status = indexStatus(flags.repo, { ...scanOptions(flags), ast: !flags.noAst }, indexDir);
    emit(JSON.stringify(status, null, 2) + "\n", flags.out);
    if (flags.check && !status.artifactsFresh) process.exitCode = 1;
  } else if (cmd === "graph") {
    emit((await readArtifactBytes("graph")) ?? renderGraphJson(await readGraph()), flags.out);
  } else if (cmd === "symbols") {
    emit((await readArtifactBytes("symbols")) ?? renderSymbolsJson((await readArtifacts()).symbols), flags.out);
  } else if (cmd === "scip") {
    const scan = await readScan();
    const bytes = renderScip(scan, { projectRoot: flags.projectRoot });
    const out = flags.out ?? resolve("index.scip");
    if (out === "-") process.stdout.write(Buffer.from(bytes));
    else {
      writeFileSync(out, bytes);
      process.stderr.write(`codeindex: SCIP index → ${out} (${bytes.length} bytes)\n`);
    }
  } else if (cmd === "callers") {
    if (flags.lsp && !flags.positional) throw new Error("callers --lsp requires a symbol: callers <name> --lsp");
    if (flags.raw && (flags.lsp || flags.recall)) throw new Error("callers --raw lists call sites before any binding: it takes neither --lsp nor --recall");
    if (flags.raw && flags.withCaller) throw new Error("callers --raw already names each site's enclosing symbol: it takes no --with-caller");
    const scan = await readScan();
    const ref = flags.positional;
    if (flags.raw) {
      if (ref) {
        emit(JSON.stringify(rawCallersOf(scan, ref), null, 2) + "\n", flags.out);
      } else {
        const obj: Record<string, unknown> = {};
        for (const [name, sites] of buildRawCallerIndex(scan)) obj[name] = sites;
        emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
      }
    } else if (ref) {
      // Only the names the ref can denote are bound — the whole-repo index is
      // the expensive part of a one-shot query, and nothing else needs it.
      const index = callerIndexForNames(scan, refNames(ref), { recall: flags.recall });
      const found = lookupCallerEntry(index, ref);
      const entry = found && flags.withCaller ? withCallerIds(scan, found) : found;
      const answer = entry ?? explainNoCallers(scan, ref, index);
      if (!answer) {
        const named = rawCallerSitesFor(scan, ref).length;
        throw new Error(
          `no symbol named "${ref}" in the index` +
            (named ? ` (${named} call site(s) use the name; \`callers --raw ${ref}\` lists them)` : ""),
        );
      }
      // The LSP tier parses `Parent/name@file`; hand it that spelling of
      // whichever ref form was used.
      const reading = resolveSymbolRef(scan, ref)?.reading;
      const result = flags.lsp ? await callersWithLsp(scan, flags.repo, reading ? formatSymbolRef(reading) : ref, answer) : answer;
      emit(JSON.stringify(result, null, 2) + "\n", flags.out);
    } else {
      const index = buildCallerIndex(scan, undefined, { recall: flags.recall });
      const obj: Record<string, unknown> = {};
      for (const [name, entry] of index) obj[name] = flags.withCaller ? withCallerIds(scan, entry) : entry;
      emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
    }
  } else if (cmd === "hierarchy") {
    const scan = await readScan();
    const hierarchy = hierarchyFor(scan);
    if (flags.positional) {
      const entry = typeEntry(hierarchy, flags.positional, resolveSymbolRef(scan, flags.positional)?.defs);
      if (!entry) throw new Error(`no type named ${flags.positional}`);
      emit(JSON.stringify(entry, null, 2) + "\n", flags.out);
    } else {
      const obj: Record<string, unknown> = {};
      for (const [key, entry] of hierarchy) obj[key] = entry;
      emit(JSON.stringify(obj, null, 2) + "\n", flags.out);
    }
  } else if (cmd === "implementations") {
    if (!flags.positional) throw new Error("implementations needs a type name: cli.mjs implementations <Name> --repo <dir>");
    const scan = await readScan();
    const hierarchy = hierarchyFor(scan);
    const declarations = resolveSymbolRef(scan, flags.positional)?.defs;
    if (!typeEntry(hierarchy, flags.positional, declarations)) throw new Error(`no type named ${flags.positional}`);
    emit(
      JSON.stringify(
        { name: flags.positional, implementations: implementationsOf(hierarchy, flags.positional, declarations) },
        null,
        2,
      ) + "\n",
      flags.out,
    );
  } else if (cmd === "callgraph") {
    if (!flags.positional) throw new Error("callgraph needs a symbol: cli.mjs callgraph <Symbol> --repo <dir>");
    const scan = await readScan();
    const graph = symbolGraphFor(scan);
    const result = neighborhood(graph, flags.positional, {
      ...(flags.depth !== undefined ? { depth: flags.depth } : {}),
      ...(flags.direction ? { direction: flags.direction } : {}),
    });
    if (!result.root.length) throw new Error(`no symbol named ${flags.positional}`);
    emit(JSON.stringify(result, null, 2) + "\n", flags.out);
  } else if (cmd === "find" || cmd === "refs" || cmd === "outline") {
    // The MCP find_symbol / find_references / symbols_overview answers, same
    // bytes: signatures, docs, parents and spans were reachable from an MCP
    // client only, while `symbols` prints name → {file, line, kind}.
    if (!flags.positional) {
      const usage = { find: "find <name|Parent/name>", refs: "refs <symbol>", outline: "outline <file>" }[cmd];
      throw new Error(`${cmd} needs an argument: cli.mjs ${usage} --repo <dir>`);
    }
    if (flags.lsp && cmd !== "refs") throw new Error("--lsp applies to `callers <name>` and `refs <symbol>` only");
    const scan = await readScan();
    let result: unknown;
    if (cmd === "find") {
      result = findSymbol(scan, flags.positional, {
        substring: flags.substring,
        includeBody: flags.includeBody,
        concise: flags.concise,
        maxResults: flags.limit,
      });
    } else if (cmd === "refs") {
      // An unknown name still answers (defs: []): referencingFiles may name an
      // out-of-repo symbol (`useState`), which is exactly what one asks here.
      const statik = findReferences(scan, flags.positional);
      const leaf = resolveSymbolRef(scan, flags.positional)?.reading.name ?? flags.positional;
      const refs = flags.lsp ? await referencesWithLsp(scan, flags.repo, leaf, statik) : statik;
      result = flags.concise ? conciseReferences(refs) : refs;
    } else {
      // A file with no symbols answers []; one the index does not hold is an
      // error, as it is for `complexity`.
      const known = new Set(scan.files.map((f) => f.rel));
      const rel = resolveFileArg(flags.repo, flags.positional, (r) => known.has(r));
      if (rel === undefined) throw new Error(`no such file in the index: ${flags.positional}`);
      const overview = symbolsOverview(scan, rel);
      result = flags.concise ? overview.map((s) => symbolLocation(s, s.name)) : overview;
    }
    emit(JSON.stringify(result, null, 2) + "\n", flags.out);
  } else if (cmd === "callpath") {
    const [from, to] = flags.positionals;
    if (!from || !to) throw new Error("callpath needs two arguments: cli.mjs callpath <from> <to> --repo <dir> (--files: two file paths)");
    if (flags.includeInferred && !flags.files) throw new Error("--include-inferred applies to `impact` and `callpath --files` only");
    const opts = { depth: flags.depth, maxPaths: flags.limit };
    let result: unknown;
    if (flags.files) {
      const { graph } = await readArtifacts();
      const known = new Set(graph.files.map((f) => f.rel));
      const [a, b] = [from, to].map((arg) => {
        const rel = resolveFileArg(flags.repo, arg, (r) => known.has(r));
        if (rel === undefined) throw new Error(`no such file in the index: ${arg}`);
        return rel;
      });
      result = dependencyPath(graph, a!, b!, { ...opts, includeInferred: flags.includeInferred });
    } else {
      const path = callPath(symbolGraphFor(await readScan()), from, to, opts);
      if (!path.from.length) throw new Error(`no symbol named ${from}`);
      if (!path.to.length) throw new Error(`no symbol named ${to}`);
      result = path;
    }
    emit(JSON.stringify(result, null, 2) + "\n", flags.out);
  } else if (cmd === "symbol-at") {
    // `file:line`, or `file:line:col` as compilers and `grep -n` print it (the
    // column is ignored). The file part may itself hold a colon (`C:\x.ts`).
    const m = flags.positional ? /^(.+?):(\d+)(?::\d+)?$/.exec(flags.positional) : null;
    if (!m || Number(m[2]) < 1) throw new Error("symbol-at needs <file:line>: cli.mjs symbol-at src/a.ts:42 --repo <dir>");
    const scan = await readScan();
    const files = new Set(scan.files.map((f) => f.rel));
    const rel = resolveFileArg(flags.repo, m[1]!, (r) => files.has(r));
    if (rel === undefined) throw new Error(`no such file in the index: ${m[1]}`);
    emit(JSON.stringify(symbolAt(scan, rel, Number(m[2])), null, 2) + "\n", flags.out);
  } else if (cmd === "search") {
    if (!flags.positional) throw new Error('search needs a query: cli.mjs search "<query>" --repo <dir>');
    const scan = await readScan();
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
      const scan = await readScan();
      const index = buildEmbeddingIndex(scan, model);
      writeArtifact(join(flags.out, "embeddings.bin"), serializeEmbeddings(index));
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
    emit(JSON.stringify(await lspStatus(await readScan(), flags.repo, flags.probe === true), null, 2) + "\n", flags.out);
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
        // The AST tier can be live (pullNeeded false) while the EXTENDED
        // grammars are missing — the npm layout ships only the core ones — and
        // those languages then run on the regex tier until a pull.
        extendedPullNeeded: extended.length < EXTENDED_GRAMMARS.size,
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
    const graph = await readGraph();
    const violations = checkRules(graph, rules);
    const errors = violations.filter((v) => v.severity === "error").length;
    emit(JSON.stringify({ errors, warnings: violations.length - errors, violations }, null, 2) + "\n", flags.out);
    if (errors > 0) process.exitCode = 1; // the CI gate
  } else if (cmd === "workspaces") {
    const info = detectWorkspaces(flags.repo);
    const check = flags.check ? checkWorkspaceDeps(info, (await readArtifacts()).graph) : undefined;
    emit(JSON.stringify(workspaceReport(info, check), null, 2) + "\n", flags.out);
    if (check && !check.ok) process.exitCode = 1; // the CI gate, like `rules`
  } else if (cmd === "churn") {
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    const sorted: Record<string, number> = {};
    for (const k of [...churn.keys()].sort()) sorted[k] = churn.get(k)!;
    emit(JSON.stringify({ ok, churn: sorted }, null, 2) + "\n", flags.out);
  } else if (cmd === "repomap") {
    const graph = await readGraph();
    emit(renderRepoMap(await readScan(), graph, { budgetTokens: flags.budgetTokens }), flags.out);
  } else if (cmd === "hotspots") {
    const scan = await readScan();
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, hotspots: rankHotspots(scan, churn) }, null, 2) + "\n", flags.out);
  } else if (cmd === "coupling") {
    const { ok, couplings } = changeCoupling(flags.repo, { since: flags.since });
    emit(JSON.stringify({ ok, couplings }, null, 2) + "\n", flags.out);
  } else if (cmd === "deadcode") {
    const dead = findDeadCode(await readScan(), { kinds: flags.kinds, includeTail: flags.includeTail });
    emit(JSON.stringify(capDeadCode(dead, flags.limit), null, 2) + "\n", flags.out);
  } else if (cmd === "literals") {
    const report = findLiteralDuplications(await readScan(), {
      minFiles: flags.minFiles,
      minCount: flags.minCount,
      includeTests: flags.includeTests,
    });
    emit(JSON.stringify(report, null, 2) + "\n", flags.out);
  } else if (cmd === "complexity") {
    const scan = await readScan();
    let rel = flags.positional;
    if (rel !== undefined) {
      // An unknown file answered [] on exit 0, exactly like a file with no
      // symbols: say which it is.
      const known = new Set(scan.files.map((f) => f.rel));
      const hit = fileArgReadings(flags.repo, rel).find((r) => known.has(r));
      if (hit === undefined) throw new Error(`no such file in the index: ${rel}`);
      rel = hit;
    }
    emit(JSON.stringify(symbolComplexity(scan, rel, flags.limit), null, 2) + "\n", flags.out);
  } else if (cmd === "risk") {
    const scan = await readScan();
    const { churn, ok } = gitChurn(flags.repo, { since: flags.since });
    emit(JSON.stringify({ churnOk: ok, risks: riskHotspots(scan, churn, flags.limit) }, null, 2) + "\n", flags.out);
  } else if (cmd === "delta") {
    const { graph, symbols } = await readArtifacts();
    const res = deltaFor(flags.repo, graph, symbols, {
      base: flags.base,
      staged: flags.staged,
      depth: flags.depth,
    });
    if ("error" in res) throw new Error(res.error);
    emit(flags.json ? JSON.stringify(res, null, 2) + "\n" : formatDeltaPanel(res), flags.out);
  } else if (cmd === "impact") {
    if (!flags.positional) throw new Error("impact needs a target: cli.mjs impact <file|module> --repo <dir>");
    const graph = await readGraph();
    let res: ReturnType<typeof impactOf>;
    for (const target of fileArgReadings(flags.repo, flags.positional)) {
      res = impactOf(graph, target, flags.depth ?? Infinity, { includeInferred: flags.includeInferred });
      if (res) break;
    }
    if (!res) throw new Error(`no such file or module in the index: ${flags.positional}`);
    emit(JSON.stringify(res, null, 2) + "\n", flags.out);
  } else if (cmd === "neighbors") {
    if (!flags.positional) throw new Error("neighbors needs a target: cli.mjs neighbors <file|module> --repo <dir>");
    const graph = await readGraph();
    const kinds = flags.kind ? new Set(flags.kind.split(",")) : undefined; // validated by parseFlags
    let res: ReturnType<typeof neighborsOf>;
    for (const target of fileArgReadings(flags.repo, flags.positional)) {
      res = neighborsOf(graph, target, flags.depth ?? 1, kinds);
      if (res) break;
    }
    if (!res) throw new Error(`no such file or module in the index: ${flags.positional}`);
    emit(JSON.stringify(res, null, 2) + "\n", flags.out);
  } else if (cmd === "resolution") {
    const report = resolutionReport(await readScan(), { lang: flags.lang, limit: flags.limit });
    emit(JSON.stringify(report, null, 2) + "\n", flags.out);
  } else if (cmd === "mermaid") {
    emit(renderMermaid(await readGraph(), { module: flags.positional }), flags.out);
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
