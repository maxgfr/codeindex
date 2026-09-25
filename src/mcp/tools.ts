// The MCP tool catalogue: the tool definitions, their display metadata, and
// the per-protocol-version view of the list a client actually receives.
//
// Split out of mcp.ts because it is pure data plus one projection function —
// nothing here scans a repo or touches the wire — and because it is the part a
// reader most often wants to consult on its own.
import { ANNOTATIONS_SINCE, PROTOCOL_VERSIONS, RICH_TOOLS_SINCE } from "./protocol.js";

const repoProp = { repo: { type: "string", description: "Absolute path to the repository root" } };
// One symbol syntax for every navigation tool (src/symref.ts).
const symbolRefDescription = "name, name@file, file#name, file#Parent/name (a call_graph id) or Parent/name";
const sinceProp = {
  type: "string",
  description: 'Only count commits after this ref (tag, branch, sha) or since this date ("2024-01-01", "6 months ago"); anything else is an error',
};
const conciseProp = { concise: { type: "boolean", description: "Return declaration locations (name/kind/file/line, plus parent for a member) without full symbol metadata. Keeps every result, reference tier and confidence label (default false)." } };
const scopeProps = {
  scope: { type: "string", description: "Restrict to one directory or file (repo-relative); ANDed with include/exclude" },
  include: { type: "array", items: { type: "string" }, description: "Include globs, rooted at the repo: '*.ts' is top-level only, '**/*.ts' any depth" },
  exclude: { type: "array", items: { type: "string" }, description: "Exclude globs (rooted, like include)" },
};

export const TOOLS = [
  {
    name: "scan_summary",
    description:
      "Deterministically scan a repository: file count, per-language file histogram, HEAD commit, and whether the walk was capped. Fast first look at any codebase.",
    inputSchema: { type: "object", properties: { ...repoProp, ...scopeProps }, required: ["repo"] },
  },
  {
    name: "graph",
    description:
      "Build the full typed cross-file link-graph (import/call/use/doc-link/mention edges, module grouping, PageRank centrality, Louvain communities, tests-map). Returns graph.json. Large on big repos — prefer scan_summary/symbols/callers for targeted questions.",
    inputSchema: { type: "object", properties: { ...repoProp, ...scopeProps }, required: ["repo"] },
  },
  {
    name: "symbols",
    description:
      "Where is a symbol defined and which files reference it? Returns the definition sites (file, line, kind, exported) and referencing files. Omit `name` for the full symbol index.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, ...conciseProp, name: { type: "string", description: "Symbol name to look up" } },
      required: ["repo"],
    },
  },
  {
    name: "callers",
    description:
      "Who calls a function? Per-symbol caller index: each defined symbol with the exact (file, line) call sites that bind to it. Omit `name` for the full index. An unknown symbol is an error; a known one no site binds to answers with its defs and how many call sites name it anyway (`unresolvedSites`, `sample`).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...conciseProp,
        name: { type: "string", description: symbolRefDescription },
        lsp: { type: "boolean", description: "Append incoming calls from configured language servers and agreement with static callers. Requires name; name@file disambiguates. Unsupported servers and failures keep the static answer with a stated reason (default false)." },
        recall: {
          type: "boolean",
          description:
            "Recall-oriented binding: add the name-only matches precision mode rejects (a unique JS/TS name with no import, a same-file homonym whatever the receiver, a proximity guess in Go or into tests), labelling each site corroborated|unique-name (default false = precision)",
        },
        raw: {
          type: "boolean",
          description:
            "Every call site of `name` as written, before any binding: {name, sites:[{file, line, receiver?, enclosingSymbol?}]}. Requires name (default false)",
        },
        withCaller: {
          type: "boolean",
          description: "Add `caller` to each site: the symbol id of the declaration the call sits in (a call_graph node id), so the answer names functions, not just lines (default false)",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "workspaces",
    description:
      "Detect monorepo packages (npm/pnpm/yarn/lerna/nx/cargo/go modules/maven/gradle/uv/composer) with the workspace dependency graph, one cycle if present, a topological build order, and warnings for malformed manifests. `check: true` also compares each package's declared sibling dependencies with the imports it really makes: `undeclared` (imported, not declared — breaks isolated installs and publishing) and `unusedDeclared` (declared, never imported).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        check: {
          type: "boolean",
          description: "Compare declared workspace dependencies with resolved cross-package imports (builds the link-graph; default false)",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "churn",
    description:
      "Per-file git commit counts (whole history, or a since window) — the churn half of hotspot analysis. Paths are relative to repo; `shallow: true` means a shallow clone (counts are lower bounds), `error` says why `ok` is false.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: sinceProp },
      required: ["repo"],
    },
  },
  {
    name: "symbols_overview",
    description:
      "All symbols declared in ONE file (name, kind, line span, exported, parent), in declaration order — the fastest way to understand a file without reading it.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, ...conciseProp, file: { type: "string", description: "Repo-relative file path" } },
      required: ["repo", "file"],
    },
  },
  {
    name: "find_symbol",
    description:
      "Find symbol declarations by name or name path ('Class/method' matches a method inside Class). Each match carries its COMPLETE SIGNATURE (parameters and return type) by default, because \"what shape is it\" is the question that follows \"where is it\" almost every time and one round trip beats two. Options: substring matching, includeBody for the declaration's source, concise to drop everything but name/kind/file/line (and a member's parent) when you genuinely only want a location. Exact-name matches rank first.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        namePath: { type: "string", description: "Symbol name or Parent/child path" },
        substring: { type: "boolean" },
        includeBody: { type: "boolean" },
        concise: {
          type: "boolean",
          description:
            "Return only name/kind/file/line (plus parent for a member) — drop the signature, line span, visibility and language. Roughly 2.5x smaller; use it when you are resolving a path and nothing more (default false).",
        },
        maxResults: { type: "number", minimum: 1, description: "Cap matches (default 50)" },
      },
      required: ["repo", "namePath"],
    },
  },
  {
    name: "find_references",
    description:
      "Who references a symbol? Three labeled tiers: defs (declarations), callSites (line-precise, import-corroborated call bindings), referencingFiles (file-level identifier/doc mentions — may include homonyms). Confidence decreases across tiers; the labels let you decide what to trust.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        name: { type: "string", description: `${symbolRefDescription}; a bare name covers every homonym` },
        ...conciseProp,
        lsp: {
          type: "boolean",
          description:
            "Also ask a configured language server (see lsp_status) and append an `lsp` block: its references plus an `agreement` matrix (both / lspOnly / staticOnly). The three static tiers are unchanged either way. `staticOnly` can indicate homonyms or an incomplete language-server answer. No config, no binary, a crash or a timeout all degrade to the static answer with a stated reason (default false).",
        },
      },
      required: ["repo", "name"],
    },
  },
  {
    name: "symbol_at",
    description:
      "Which symbol is at file:line? The innermost declaration holding the line (full metadata plus its symbol `id`, the form callers/call_graph/call_path read) and the declarations around it, outermost first. Turns a grep hit, a stack frame or a diagnostic into something the navigation tools accept. `symbol` is null outside every declaration; `approximate: true` means the file has no AST spans, so it is only the nearest declaration above.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        file: { type: "string", description: "Repo-relative file path" },
        line: { type: "number", minimum: 1, description: "1-based line number" },
      },
      required: ["repo", "file", "line"],
    },
  },
  {
    name: "lsp_status",
    description:
      "Is the optional LSP tier configured, and would it answer? Reports the config path and its source, each server with whether its command is on PATH and how many files in this repo it claims, and the languages no server covers. Opt-in by asset: the tier is active only when <repo>/.codeindex/lsp.json exists (or CODEINDEX_LSP_CONFIG points at one). `probe: true` additionally starts each server to read the capabilities it really advertises. The tier never touches graph.json/symbols.json — it annotates query answers only.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        probe: { type: "boolean", description: "Start each server and read its real capabilities (default false: no spawn)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "onboard",
    description:
      "One call that says what this repository IS: its own tagline, size and language mix, monorepo layout when there is one, a token-budgeted map of the highest-PageRank files with their key signatures, and where git says work concentrates. Composes scan_summary + workspaces + repo_map + hotspots so the first four round trips of a session become one, and persists the result as the `onboarding` memory (read_memory) so the next session does not repeat them. Set remember:false to skip the write.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        budgetTokens: { type: "number", minimum: 1, description: "Token budget for the key-files section (default 900)" },
        remember: { type: "boolean", description: "Persist the brief as the `onboarding` memory (default true)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "repo_map",
    description:
      "Token-budgeted map of the repository: the most central production files (PageRank over the edges production code creates; tests left out) with their public types, functions and methods first, deterministically rendered to fit `budgetTokens` (default 1024). The densest single read to understand an unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, budgetTokens: { type: "number", minimum: 1, description: "Approximate token budget (default 1024)" } },
      required: ["repo"],
    },
  },
  {
    name: "hotspots",
    description:
      "Where does work concentrate? Files changed in the window, ranked by git churn × size (commits × log2 lines); test files carry `test: true`. High-scoring files are where changes and defects cluster.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        since: sinceProp,
        limit: { type: "number", minimum: 1, description: "Max files (default 20)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "coupling",
    description:
      "Change coupling: pairs of indexed files that repeatedly change in the same commits. strength 1.0 = every change to one touched the other; ranked by `confidence` (the strength a pair's history supports); `linked: false` = no graph edge joins them — a hidden dependency.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        since: sinceProp,
        hidden: { type: "boolean", description: "Only pairs no graph edge links (default false)" },
        minTogether: { type: "number", minimum: 1, description: "Commits a pair must share (default 3)" },
        maxCommitFiles: { type: "number", minimum: 1, description: "Skip commits touching more files, as mass refactors (default 30)" },
        limit: { type: "number", minimum: 1, description: "Max pairs (default 100)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "replace_symbol_body",
    description:
      "WRITE: replace a symbol's whole declaration with `body` (verbatim, supply full indentation). The symbol is resolved by name path ('Class/method'); ambiguity errors list the candidates — qualify with `file`. Line spans come from the AST index.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        namePath: { type: "string" },
        body: { type: "string" },
        file: { type: "string", description: "Disambiguate: repo-relative file containing the symbol" },
      },
      required: ["repo", "namePath", "body"],
    },
  },
  {
    name: "insert_after_symbol",
    description:
      "WRITE: insert `body` after a symbol's declaration (blank-line separation preserved for definition-like kinds). Resolved like replace_symbol_body.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, namePath: { type: "string" }, body: { type: "string" }, file: { type: "string" } },
      required: ["repo", "namePath", "body"],
    },
  },
  {
    name: "insert_before_symbol",
    description:
      "WRITE: insert `body` before a symbol's declaration (blank-line separation preserved). Resolved like replace_symbol_body.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, namePath: { type: "string" }, body: { type: "string" }, file: { type: "string" } },
      required: ["repo", "namePath", "body"],
    },
  },
  {
    name: "write_memory",
    description:
      "Persist a named markdown note under <repo>/.codeindex/memories/ (names may use topic/name form). Write small, focused notes: project map, build commands, conventions.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string" }, content: { type: "string" } },
      required: ["repo", "name", "content"],
    },
  },
  {
    name: "read_memory",
    description: "Read one persisted memory by name.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string" } },
      required: ["repo", "name"],
    },
  },
  {
    name: "list_memories",
    description: "List persisted memory names — load this first, then read individual memories on relevance.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "delete_memory",
    description: "Delete one persisted memory by name.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string" } },
      required: ["repo", "name"],
    },
  },
  {
    name: "dead_code",
    description:
      "Dead-code candidates in two labeled tiers: 'unreferenced' (no call site binds AND no other file names it) and 'uncalled' (named elsewhere — import, type position, base-class list, a same-name call site — but no call binds). Exported callables only unless `kinds: \"all\"`; test and tail files (examples, docs, fixtures, scripts — `includeTail` to include them), the package's public API (manifest entry points and what they re-export), language protocol names and overrides of live methods are never candidates. On a large repo this list runs to thousands of entries — pass `limit`, or `scope` to one subdirectory.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        limit: { type: "number", minimum: 0, description: "Cap entries (default: all)" },
        kinds: { type: "string", enum: ["callable", "all"], description: "Candidate kinds (default callable; all adds types, properties and constants, unreferenced only)" },
        includeTail: { type: "boolean", description: "Also report examples, docs, fixtures and scripts" },
      },
      required: ["repo"],
    },
  },
  {
    name: "duplicated_literals",
    description:
      "Values with no single source of truth: one literal written out across many files. Three labeled tiers — 'competing' (two or more exported constants hold the same value), 'bypassed' (a constant holds it and other files rewrite it anyway), 'uncentralized' (nothing holds it). Path-like values are also grouped into namespace families, so a whole route space reports once instead of once per route. Covers config files (JSON/YAML/TOML) as well as code, which is where the dangerous cases live: a threshold declared in TypeScript and again in a rules JSON is checked by no compiler. Use it to answer 'what breaks if this value changes' and 'is there already a helper for this'.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        minFiles: { type: "number", minimum: 1, description: "Distinct files a value must span (default 2)" },
        minCount: { type: "number", minimum: 1, description: "Total occurrences required (default 3)" },
        includeTests: { type: "boolean", description: "Count test files too (default false)" },
        limit: { type: "number", minimum: 0, description: "Cap duplications (default: all)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "complexity",
    description:
      "Cyclomatic-complexity estimates (branch-token counting over AST line spans, comments and string literals aside), most-complex first; functions and methods only — containers are not ranked, and nested functions score on their own. Pass `file` for one file's symbols, omit for the repo-wide top. Combine with hotspots: the `risk` field of this tool's sibling ranks complexity × churn.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        file: { type: "string" },
        risk: { type: "boolean", description: "Return complexity × git-churn risk ranking instead" },
        since: { ...sinceProp, description: "Only count risk churn after this ref (tag, branch, sha) or since this date" },
        top: { type: "number", minimum: 1, description: "Cap ranked symbols" },
      },
      required: ["repo"],
    },
  },
  {
    name: "mermaid",
    description:
      "Mermaid diagram of the module graph (renders inline in Claude/GitHub — no graph database). Optionally scoped to one module's neighborhood.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        module: { type: "string", description: "Module slug to focus on" },
        maxEdges: { type: "number", minimum: 1, description: "Cap rendered edges" },
      },
      required: ["repo"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression (ripgrep when available, a deterministic JS scan otherwise — same results either way). Returns hits sorted by (file, line): {file, line, col, text}, `col` being the 1-based UTF-16 column of the first match and `text` the line, cut to a window around the match when longer than 300 chars. Capped at maxHits (default 200): set `withMeta: true` to get `{ hits, truncated, filesMatched, notes? }` and know whether the list is complete. A pattern too slow for the JS engine is stopped at `timeoutMs` (default 10000) and the response is then always that envelope, with `timedOut: true`.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        pattern: { type: "string", description: "JavaScript regular expression to search for" },
        scope: {
          type: "string",
          description: "Restrict to one directory or file (repo-relative). ANDed with `globs`",
        },
        globs: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict to matching paths. Rooted at the repo: '*.ts' matches root-level files only, '**/*.ts' any depth; a '!' prefix excludes (exclusion wins)",
        },
        ignoreCase: { type: "boolean" },
        maxHits: { type: "number", minimum: 1 },
        filesWithMatches: {
          type: "boolean",
          description: "One hit per matching file (its first match); maxHits then caps files",
        },
        withMeta: {
          type: "boolean",
          description: "Return { hits, truncated, filesMatched, notes? } instead of the bare hit array",
        },
        timeoutMs: { type: "number", minimum: 1, description: "Wall-clock budget for the JS regex engine (default 10000)" },
      },
      required: ["repo", "pattern"],
    },
  },
  {
    name: "search",
    description:
      'Natural-language-ish lexical search: BM25F ranking over SIX weighted fields — symbol names (camelCase/snake_case subtokens), path segments, markdown headings, the file summary, per-symbol DOC COMMENTS, and the prose body (comment + short-literal words). The last two are why "where is rate limiting handled" works: the phrase lives in a comment, not in a name. Results carry `matchedFields`, a `line` anchor and `symbolHits` (name/kind/line). NOT embeddings by default — deterministic, diacritic-folded, zero API keys. Answers "where is auth handled?"-style queries with ranked files, matched terms and top symbols. Query terms with zero document frequency get a deterministic trigram-fuzzy fallback (typo-tolerant) unless `fuzzy: false`. Set `semantic: true` to RRF-fuse an embedding tier (HTTP endpoint, else a local static model) with lexical — the response then wraps the ranked list as `{ results, tier, degradedReason? }`, `tier` being "endpoint"/"static" when fusion happened or "lexical" (with `degradedReason`) when it did not (see embed_status). Without `semantic`, the response is the bare ranked array, unchanged.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        query: { type: "string", description: "Natural-language or identifier query" },
        limit: { type: "number", minimum: 1, description: "Max results, a whole number (default 20)" },
        fuzzy: {
          type: "boolean",
          description:
            "Fallback for query terms with zero document frequency: a morphological stem match first (\"caching\" finds \"cache\"), then trigram similarity for typos (default true)",
        },
        rank: {
          type: "string",
          enum: ["lexical", "graph"],
          description:
            'Structural prior: "graph" multiplies the lexical score by the file\'s PageRank over the resolved import graph relative to an average file (a leaf ×0.95, a hub well above ×1; Go files unchanged); "lexical" (default) scores on text alone. Measured a wash — it helps some queries and hurts as many — see SearchOptions.rank.',
        },
        exact: {
          type: "boolean",
          description:
            "Drop results that carry no verbatim query-term match — the ones the stem/trigram bridge produced (default false).",
        },
        explain: {
          type: "boolean",
          description:
            "Wrap the response as `{ results, explain }` with the query verdict (default false = bare array). See explain_search.",
        },
        semantic: {
          type: "boolean",
          description:
            'RRF-fuse an embedding tier with lexical (default false). Precedence: the HTTP endpoint (CODEINDEX_EMBED_ENDPOINT) if set, else a local static model. The response reports the effective tier as a top-level `tier` field ("endpoint"/"static" on success, "lexical" plus `degradedReason` when neither is available/reachable) instead of degrading silently — see embed_status. `exact` and `rank` apply to the lexical side; `explain: true` adds an `explain` key to that object, restated for the fused rows (with `semanticOnlyResults`).',
        },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "explain_search",
    description:
      'Search, and say whether the query actually found anything. Returns `{ results, explain }` where explain.verdict is "match" (a verbatim term matched), "weak" (results exist but rest on a near match, or the identifier you asked for has document frequency 0) or "none". Use this instead of `search` whenever an empty-feeling or surprising result matters: a query for an identifier that is NOT in the indexed tree still returns confident-looking rows built from its subtokens — searching "nullGipStep7" in a repo that only has "nullGipStep2" ranks files matching "null" and "gip" — and only the verdict distinguishes that from a real hit. Also names the terms dropped as stopwords, the terms that exist nowhere, and what each near match bridged to.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        query: { type: "string", description: "Natural-language or identifier query" },
        limit: { type: "number", minimum: 1, description: "Max results, a whole number (default 20)" },
        fuzzy: { type: "boolean", description: "Stem/trigram fallback for zero-document-frequency terms (default true)" },
        exact: { type: "boolean", description: "Drop results carrying no verbatim term match (default false)" },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "embed_status",
    description:
      "Report the embedding tier: the effective mode (none/static/endpoint; endpoint > static model), the resolved model (opt-in, never shipped in the package) with its modelId/dim, EMBED_VERSION, and the configured HTTP endpoint with its reachability. A model.json that is present but fails to load is reported as `model: { present: true, error }` with mode none. Use to check whether `search` with semantic:true will fuse embeddings or degrade to lexical.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "type_hierarchy",
    description:
      "How do types relate? For one type: the base classes it extends, the interfaces/traits it implements, and — the reverse direction, which no other tool answers — what extends or implements IT, plus any declared supertype with no definition in this repo. Omit `name` for the whole hierarchy.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string", description: `Type to look up — ${symbolRefDescription}` } },
      required: ["repo"],
    },
  },
  {
    name: "implementations",
    description:
      "Who implements this interface (or extends this class)? Walks the hierarchy TRANSITIVELY, so a class implementing a sub-interface of the one asked about is included. Go states no implementations: a Go type counts when a `var _ I = (*T)(nil)` assertion says so, or when its methods (own and promoted by embedding) cover the interface's by name and parameter count — those are marked `structural: true`. The tool to reach for before changing an interface.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, name: { type: "string", description: `Interface/trait/class — ${symbolRefDescription}` } },
      required: ["repo", "name"],
    },
  },
  {
    name: "call_graph",
    description:
      "What does this symbol reach, and what reaches it? A bounded symbol-to-symbol neighborhood around `symbol` — `depth` hops (default 2) following `calls`/`extends`/`implements`/`overrides` edges, `direction` out (callees) | in (callers) | both. Dispatch is followed: walking out through a method also reaches the methods overriding it, and walking in to an override reaches the callers of the method it overrides. Answers impact questions the one-hop `callers` tool cannot.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        symbol: { type: "string", description: `Symbol to centre on — ${symbolRefDescription}` },
        depth: { type: "number", minimum: 1, maximum: 5, description: "Hops to follow (default 2, max 5)" },
        direction: { type: "string", enum: ["out", "in", "both"], description: "out | in | both (default both)" },
      },
      required: ["repo", "symbol"],
    },
  },
  {
    name: "call_path",
    description:
      "How does `from` reach `to`? The shortest chains of calls between two symbols (a call to a method may dispatch to an override: `via: \"dispatch\"`), listed in id order with the total count of equally short ones. No path within `depth` hops answers hops: null, plus `reverseHops` when `to` reaches `from` instead. With files: true, `from` and `to` are file paths and the steps are import/use/call edges of the link-graph — why does A depend on B (a path only name-inferred calls would open is reported as `inferredHops` unless includeInferred).",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        from: { type: "string", description: `Start — ${symbolRefDescription}; a file path with files: true` },
        to: { type: "string", description: `End — ${symbolRefDescription}; a file path with files: true` },
        depth: { type: "number", minimum: 1, description: "Longest path to look for, in hops (default 8, max 16)" },
        maxPaths: { type: "number", minimum: 1, description: "Shortest paths to list (default 5)" },
        files: { type: "boolean", description: "Walk the file link-graph instead of the symbol graph (default false)" },
        includeInferred: { type: "boolean", description: "files: true only — also step through calls inferred from a name alone (default false)" },
      },
      required: ["repo", "from", "to"],
    },
  },
  {
    name: "impact",
    description:
      "What breaks if I change this file or module? The reverse dependency closure over the link-graph: every file that transitively imports, uses or calls `target`, nearest first, with the modules touched. A Go import reaches every non-test file of the package it names. A call inferred from a name alone is counted (`inferredDependents`) but not followed unless includeInferred. Answers from the persisted graph — no need to pull the whole `graph`.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        target: { type: "string", description: "Repo-relative file path or module slug" },
        depth: { type: "number", minimum: 1, description: "Hops to follow (default: the full closure)" },
        includeInferred: { type: "boolean", description: "Also follow call edges inferred from a name alone (default false)" },
      },
      required: ["repo", "target"],
    },
  },
  {
    name: "neighbors",
    description:
      "What sits next to this file or module in the link-graph, both directions: every edge kind linking each neighbour (import, call, use, extends, implements, doc-link, mention, contains), strongest evidence first, out to `depth` hops. Hubs are listed but not expanded through, so depth 2 stays an answer rather than a dump.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        target: { type: "string", description: "Repo-relative file path or module slug" },
        depth: { type: "number", minimum: 1, description: "Hops to follow (default 1)" },
        kinds: { type: "array", items: { type: "string" }, description: "Edge kinds to traverse (default all)" },
      },
      required: ["repo", "target"],
    },
  },
  {
    name: "check_rules",
    description:
      'Validate dependency-cruiser-style architecture rules against the link-graph. Rules (inline JSON array): forbidden edges {name, from, to, kind?, severity?, comment?} with glob paths, plus builtins {name, builtin: "cycles"|"orphans"|"literals"} (module-level import cycles; code files nothing connects to; values with no single source of truth, narrowed by tiers?/minFiles?/minCount?/includeTests?). Unknown keys are rejected; a forbidden rule whose globs match no indexed file comes back as an `unmatched` warning. Returns deterministic violations with severity error|warn — a CI gate.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        rules: { type: "array", description: "Rules array (inline JSON — see description)" },
        configPath: {
          type: "string",
          description:
            "Read the rules from this JSON file instead — the CLI's --config. Repo-relative, or absolute; either way it must resolve inside the repository. Ignored when `rules` is given.",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "resolution_report",
    description:
      "Can the link-graph be trusted for a language? Per importer language: how many imports resolved to in-repo files, went external (third-party/stdlib), dangle (local target missing, by reason) or are unsupported (no resolver for that language), the top dangling specs with an example importer, the top external packages, and the config warnings (unparseable tsconfig/package.json, missing `extends`) that silently turn imports external. Check it before relying on impact, callers or dead_code for a language.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        lang: { type: "string", description: "Only this language (as scan_summary names it)" },
        limit: { type: "number", minimum: 1, description: "Entries per top list (default 10)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "index_status",
    description:
      "Is the persisted index (<repo>/.codeindex, written by `codeindex index`) fresh for this tree? Returns whether its cache.json is usable (or why not: absent/unreadable/corrupt/schema/extractor), the indexed vs HEAD commit, per-file drift counts (unchanged, touched, modified, added, deleted, reextract), artifactsFresh and the reasons it is not. Cheap: reads cache.json, walks and stats, hashes only stat-changed files, never extracts. A fresh index is what makes the first graph-shaped call on a large repo fast; a stale one is rebuilt in memory, so answers stay correct either way.",
    inputSchema: { type: "object", properties: { ...repoProp, ...scopeProps }, required: ["repo"] },
  },
  {
    name: "delta",
    description:
      "What does my change break? Maps the git diff (the branch against its merge-base with the default branch, uncommitted and untracked work included; or the staged changeset) onto the graph: each changed file with the symbols enclosing its hunks, and per module a 0-100 risk score (HIGH/MEDIUM/LOW) in which every point comes with its reason — exported API changed, hub, blast radius, test gap, a deleted or renamed file that is still imported (`broken`, with its importers), dangling imports. `open` names the files to read first. Call it after editing.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...conciseProp,
        base: { type: "string", description: "Branch or ref to review against (default: origin/HEAD, origin/main, origin/master, main, master; else HEAD)" },
        staged: { type: "boolean", description: "Review the staged changeset against HEAD instead (default false)" },
        depth: { type: "number", minimum: 1, description: "Blast-radius hops (default 2)" },
        limit: { type: "number", minimum: 1, description: "Max modules, highest score first (default: all)" },
        format: { type: "string", enum: ["json", "text"], description: '"text" returns the compact human panel instead of JSON (default "json")' },
      },
      required: ["repo"],
    },
  },
] as const;


// --- output schemas ----------------------------------------------------------
// `outputSchema` (protocol 2025-06-18) lets a client validate and type a tool's
// result instead of re-parsing an opaque string, and `structuredContent` carries
// that result alongside the text block.
//
// Only tools whose response is a JSON OBJECT for EVERY argument combination are
// declared here, because the spec requires structuredContent to be an object and
// requires it to conform whenever an outputSchema is present. That rules out:
//
//   * array responses — symbols_overview, find_symbol, grep, check_rules,
//     list_memories. Wrapping them in `{ items: [...] }` would make
//     structuredContent diverge from the text block, and changing the text block
//     itself would break every existing client. Omitting the schema is the only
//     option that breaks neither.
//   * argument-dependent shapes — dead_code (array, object with `limit`),
//     complexity (array, object with `risk`), search (array, object with
//     `semantic` or `explain`), delta (object, text with `format: "text"`). A schema that cannot describe every response is
//     worse than none: it would make a conforming client reject valid output.
//     `explain_search` exists precisely because of this rule — it is the same
//     answer with ONE shape, so it can carry a schema where `search` cannot.
//   * text responses — repo_map, mermaid, read_memory, which are not JSON.
//
// Shapes are deliberately open (no `additionalProperties: false`): a later
// engine adding a field must not turn a strict client's success into a failure.
//
// Every root is `type: "object"`, including the ones whose alternatives live in
// a `oneOf`. The spec types Tool.outputSchema as an object schema, and the
// official TypeScript SDK enforces it when it parses tools/list: a bare
// `{ oneOf: [...] }` root made its client reject the WHOLE list, so every
// SDK-based host saw zero tools. tests/mcp-output.test.ts pins this for every
// declared schema, including ones added later.
const strArr = { type: "array", items: { type: "string" } };
const anyObj = { type: "object" };
// git-history answers (churn, hotspots, coupling): why `ok` is false, and
// whether a shallow clone truncated the history. Present only when they apply.
const historyProps = { error: { type: "string" }, shallow: { type: "boolean" }, note: { type: "string" } };

export const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  call_graph: {
    type: "object",
    properties: {
      root: { type: "array", items: anyObj },
      nodes: { type: "array", items: anyObj },
      edges: { type: "array", items: anyObj },
      truncated: { type: "boolean" },
      depthClamped: { type: "integer" },
    },
    required: ["root", "nodes", "edges"],
  },
  // Symbol or file endpoints: `from`/`to` are node lists or file paths.
  call_path: {
    type: "object",
    properties: {
      from: {},
      to: {},
      hops: { type: ["integer", "null"] },
      paths: { type: "array", items: { type: "array", items: anyObj } },
      pathCount: { type: "integer" },
      truncated: { type: "boolean" },
      depthClamped: { type: "integer" },
      reverseHops: { type: "integer" },
      inferredHops: { type: "integer" },
    },
    required: ["from", "to", "hops", "paths", "pathCount"],
  },
  impact: {
    type: "object",
    properties: {
      target: { type: "string" },
      scope: { type: "string", enum: ["module", "file"] },
      seeds: strArr,
      files: { type: "array", items: anyObj },
      modules: strArr,
      inferredDependents: { type: "integer" },
    },
    required: ["target", "scope", "seeds", "files", "modules"],
  },
  neighbors: {
    type: "object",
    properties: {
      target: { type: "string" },
      scope: { type: "string", enum: ["module", "file"] },
      links: { type: "array", items: anyObj },
      members: strArr,
    },
    required: ["target", "scope", "links"],
  },
  scan_summary: {
    type: "object",
    properties: {
      engineVersion: { type: "string" },
      commit: { type: "string" },
      fileCount: { type: "integer" },
      languages: { type: "object", additionalProperties: { type: "integer" } },
      capped: { type: "boolean" },
    },
    required: ["engineVersion", "fileCount", "languages", "capped"],
  },
  graph: {
    type: "object",
    properties: {
      schemaVersion: { type: "integer" },
      version: { type: "string" },
      commit: { type: "string" },
      fileCount: { type: "integer" },
      languages: { type: "object", additionalProperties: { type: "integer" } },
      files: { type: "array", items: anyObj },
      modules: { type: "array", items: anyObj },
      fileEdges: { type: "array", items: anyObj },
      moduleEdges: { type: "array", items: anyObj },
    },
    required: ["schemaVersion", "files", "fileEdges", "modules", "moduleEdges"],
  },
  // Two shapes, both objects: the whole index, or one symbol's entry.
  symbols: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: { schemaVersion: { type: "integer" }, defs: anyObj, refs: anyObj },
        required: ["schemaVersion", "defs"],
      },
      {
        type: "object",
        properties: { name: { type: "string" }, defs: { type: "array", items: anyObj }, refs: strArr },
        required: ["name", "defs", "refs"],
      },
    ],
  },
  // The whole index (symbol name -> entry), one entry, the no-callers notice,
  // or (raw:true) one name's unresolved sites.
  callers: {
    type: "object",
    oneOf: [
      { type: "object", additionalProperties: anyObj },
      { type: "object", properties: { def: anyObj, callers: { type: "array", items: anyObj }, lsp: anyObj }, required: ["def", "callers"] },
      {
        type: "object",
        properties: {
          error: { type: "string" },
          defs: { type: "array", items: anyObj },
          unresolvedSites: { type: "integer" },
          sample: { type: "array", items: anyObj },
        },
        required: ["error"],
      },
      { type: "object", properties: { name: { type: "string" }, sites: { type: "array", items: anyObj } }, required: ["name", "sites"] },
    ],
  },
  workspaces: {
    type: "object",
    properties: {
      packages: { type: "array", items: anyObj },
      cycle: { type: ["array", "null"], items: { type: "string" } },
      topoOrder: strArr,
      warnings: strArr,
      check: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          undeclared: { type: "array", items: anyObj },
          unusedDeclared: { type: "array", items: anyObj },
        },
        required: ["ok", "undeclared", "unusedDeclared"],
      },
    },
    required: ["packages", "topoOrder"],
  },
  churn: {
    type: "object",
    properties: { ok: { type: "boolean" }, ...historyProps, churn: { type: "object", additionalProperties: { type: "integer" } } },
    required: ["ok", "churn"],
  },
  find_references: {
    type: "object",
    properties: {
      defs: { type: "array", items: anyObj },
      callSites: { type: "array", items: anyObj },
      referencingFiles: strArr,
    },
    required: ["defs", "callSites", "referencingFiles"],
  },
  symbol_at: {
    type: "object",
    properties: {
      file: { type: "string" },
      line: { type: "integer" },
      symbol: { type: ["object", "null"] },
      enclosing: strArr,
      approximate: { type: "boolean" },
    },
    required: ["file", "line", "symbol", "enclosing"],
  },
  lsp_status: {
    type: "object",
    properties: {
      lspVersion: { type: "number" },
      mode: { type: "string", enum: ["none", "configured"] },
      configPath: { type: ["string", "null"] },
      source: { type: "string", enum: ["env", "repo", "cwd", "none"] },
      servers: { type: "array", items: anyObj },
      unmappedLanguages: strArr,
    },
    required: ["lspVersion", "mode", "source", "servers", "unmappedLanguages"],
  },
  onboard: {
    type: "object",
    properties: { brief: { type: "string" }, memory: { type: "string" } },
    required: ["brief"],
  },
  explain_search: {
    type: "object",
    properties: {
      results: { type: "array", items: anyObj },
      explain: {
        type: "object",
        properties: {
          query: { type: "string" },
          terms: { type: "array", items: anyObj },
          droppedStopwords: strArr,
          unresolvedTerms: strArr,
          wholeIdentifier: anyObj,
          verdict: { type: "string", enum: ["match", "weak", "none"] },
          note: { type: "string" },
          bridgedOnlyResults: { type: "number" },
          resultCount: { type: "number" },
        },
        required: ["query", "terms", "droppedStopwords", "unresolvedTerms", "verdict", "bridgedOnlyResults", "resultCount"],
      },
    },
    required: ["results", "explain"],
  },
  hotspots: {
    type: "object",
    properties: { churnOk: { type: "boolean" }, ...historyProps, hotspots: { type: "array", items: anyObj } },
    required: ["churnOk", "hotspots"],
  },
  coupling: {
    type: "object",
    properties: { ok: { type: "boolean" }, ...historyProps, couplings: { type: "array", items: anyObj } },
    required: ["ok", "couplings"],
  },
  duplicated_literals: {
    type: "object",
    properties: {
      duplications: { type: "array", items: anyObj },
      families: { type: "array", items: anyObj },
    },
    required: ["duplications", "families"],
  },
  index_status: {
    type: "object",
    properties: {
      indexDir: { type: "string" },
      present: { type: "boolean" },
      usable: { type: "boolean" },
      reason: { type: "string", enum: ["absent", "unreadable", "corrupt", "schema", "extractor"] },
      engineVersion: anyObj,
      commit: anyObj,
      files: { type: ["object", "null"] },
      artifactsFresh: { type: "boolean" },
      stale: strArr,
    },
    required: ["indexDir", "present", "usable", "engineVersion", "commit", "files", "artifactsFresh", "stale"],
  },
  embed_status: {
    type: "object",
    properties: {
      embedVersion: { type: "integer" },
      mode: { type: "string", enum: ["none", "static", "endpoint"] },
      model: {},
      endpoint: {},
      endpointReachable: { type: "boolean" },
    },
    required: ["embedVersion", "mode"],
  },
  resolution_report: {
    type: "object",
    properties: {
      totals: anyObj,
      languages: { type: "array", items: anyObj },
      warnings: strArr,
    },
    required: ["totals", "languages", "warnings"],
  },
  write_memory: {
    type: "object",
    properties: { written: { type: "string" } },
    required: ["written"],
  },
  delete_memory: {
    type: "object",
    properties: { deleted: { type: "boolean" } },
    required: ["deleted"],
  },
};

// The three symbolic edits share one result shape (see src/edit.ts EditResult).
for (const name of ["replace_symbol_body", "insert_after_symbol", "insert_before_symbol"]) {
  OUTPUT_SCHEMAS[name] = {
    type: "object",
    properties: {
      file: { type: "string" },
      symbol: { type: "string" },
      startLine: { type: "integer" },
      endLine: { type: "integer" },
    },
    required: ["file"],
  };
}

// Per-tool display title and behaviour hints.
//
// The hints matter operationally: they are what lets a host auto-approve the
// read-only tools and hold a confirmation for the ones that write. Without them
// a client must treat `scan_summary` and `replace_symbol_body` alike.
//
// openWorldHint is true only where a call can leave this machine — `search`
// with semantic:true and `embed_status` may contact CODEINDEX_EMBED_ENDPOINT.
// Everything else reads the repo and nothing but the repo.
interface ToolMeta {
  title: string;
  write?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  openWorld?: boolean;
}

export const TOOL_META: Record<string, ToolMeta> = {
  scan_summary: { title: "Scan summary" },
  graph: { title: "Link graph" },
  symbols: { title: "Symbol index" },
  callers: { title: "Caller index" },
  workspaces: { title: "Monorepo workspaces" },
  churn: { title: "Git churn" },
  symbols_overview: { title: "File symbol overview" },
  find_symbol: { title: "Find symbol" },
  find_references: { title: "Find references" },
  symbol_at: { title: "Symbol at a line" },
  repo_map: { title: "Repository map" },
  onboard: { title: "Project brief", write: true, destructive: false, idempotent: true },
  hotspots: { title: "Hotspots" },
  coupling: { title: "Change coupling" },
  replace_symbol_body: { title: "Replace symbol body", write: true, destructive: true, idempotent: true },
  insert_after_symbol: { title: "Insert after symbol", write: true, destructive: false, idempotent: false },
  insert_before_symbol: { title: "Insert before symbol", write: true, destructive: false, idempotent: false },
  write_memory: { title: "Write memory", write: true, destructive: false, idempotent: true },
  read_memory: { title: "Read memory" },
  list_memories: { title: "List memories" },
  delete_memory: { title: "Delete memory", write: true, destructive: true, idempotent: true },
  dead_code: { title: "Dead-code candidates" },
  duplicated_literals: { title: "Values with no single source of truth" },
  complexity: { title: "Complexity" },
  mermaid: { title: "Mermaid module diagram" },
  grep: { title: "Grep file contents" },
  search: { title: "Lexical search", openWorld: true },
  explain_search: { title: "Search with a verdict", openWorld: true },
  // openWorld: it spawns a process the user configured, whose answer this
  // engine does not determine — the same honesty `search` and `embed_status`
  // already carry for reaching outside their own artifacts.
  lsp_status: { title: "LSP tier status", openWorld: true },
  embed_status: { title: "Embedding tier status", openWorld: true },
  type_hierarchy: { title: "Type hierarchy" },
  implementations: { title: "Implementations" },
  call_graph: { title: "Call graph neighborhood" },
  call_path: { title: "Shortest call path" },
  impact: { title: "Reverse dependency closure" },
  neighbors: { title: "Link-graph neighbours" },
  check_rules: { title: "Check architecture rules" },
  resolution_report: { title: "Import resolution report" },
  index_status: { title: "Index freshness" },
  delta: { title: "Review the diff" },
};

export function annotationsFor(name: string): Record<string, boolean> | undefined {
  const meta = TOOL_META[name];
  if (!meta) return undefined;
  return {
    readOnlyHint: !meta.write,
    ...(meta.write ? { destructiveHint: meta.destructive === true, idempotentHint: meta.idempotent === true } : {}),
    openWorldHint: meta.openWorld === true,
  };
}

// The advertised tool list, for one negotiated protocol version.
//
// Without a server-level repo pin and on 2024-11-05 this is TOOLS verbatim —
// byte-compat for every existing consumer. A pin drops `repo` from each
// `required` set and documents the default, so a client that omits it is
// spec-correct rather than relying on the server being lenient. Newer protocol
// revisions additionally get `title` and `annotations`.
/**
 * Named subsets of the tool list, by the question they answer.
 *
 * Every advertised tool's full JSON Schema sits in an agent's context on EVERY
 * turn, so the whole catalogue is a standing cost paid whether or not the
 * session ever touches a graph. A profile trims what is advertised, not what
 * exists: the server still answers a tool that was not advertised, so nothing
 * breaks for a client that knows a name from elsewhere.
 *
 * Every tool belongs to at least one profile (tests/mcp.test.ts checks it):
 * a tool in none can only be reached by a client that already knows its name,
 * which is how write_memory went unadvertised by every narrowed server while
 * read_memory was on offer.
 *
 * The default is `all`, deliberately. Narrowing by default would silently
 * remove capability from every existing configuration.
 */
export const TOOL_PROFILES: Record<string, readonly string[]> = {
  // Land in an unfamiliar repository and get your bearings — and keep what
  // was learned: onboard persists its brief, write_memory anything else.
  // index_status says whether a persisted index makes the first call fast.
  orient: ["scan_summary", "index_status", "repo_map", "onboard", "workspaces", "mermaid", "graph", "read_memory", "list_memories", "write_memory"],
  // Locate a thing. embed_status says whether `search` semantic:true fuses.
  find: ["search", "explain_search", "grep", "find_symbol", "symbols", "symbols_overview", "symbol_at", "embed_status"],
  // Decide whether changing it is safe.
  impact: ["find_references", "callers", "call_graph", "call_path", "impact", "neighbors", "dead_code", "type_hierarchy", "implementations", "lsp_status", "resolution_report", "delta"],
  // Change it.
  edit: ["find_symbol", "symbols_overview", "symbol_at", "replace_symbol_body", "insert_after_symbol", "insert_before_symbol"],
  // Where the work and the risk concentrate.
  risk: ["hotspots", "churn", "coupling", "complexity", "check_rules", "duplicated_literals", "dead_code", "delta"],
  // The project notes, whole: write, read, list, delete.
  memory: ["write_memory", "read_memory", "list_memories", "delete_memory"],
};

export function profileNames(): string[] {
  return ["all", ...Object.keys(TOOL_PROFILES).sort()];
}

/** Resolve one or more comma-separated profile names to a tool-name set. */
export function toolsInProfiles(spec: string): Set<string> {
  const names = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (const name of names) {
    if (name === "all") return new Set(TOOLS.map((t) => t.name));
    // Own keys only — `--tools constructor` must be an unknown profile, not
    // Object.prototype.constructor failing to iterate.
    const profile = Object.hasOwn(TOOL_PROFILES, name) ? TOOL_PROFILES[name] : undefined;
    if (!profile) throw new Error(`unknown tool profile "${name}" — one of: ${profileNames().join(", ")}`);
    for (const tool of profile) out.add(tool);
  }
  return out;
}

export function toolsFor(
  defaultRepo?: string,
  protocolVersion: string = PROTOCOL_VERSIONS[0],
  profile?: string,
): readonly unknown[] {
  const withAnnotations = protocolVersion >= ANNOTATIONS_SINCE;
  // Tool.title and Tool.outputSchema both arrive in 2025-06-18.
  const withRich = protocolVersion >= RICH_TOOLS_SINCE;
  const allowed = profile ? toolsInProfiles(profile) : undefined;
  const TOOLS_ = allowed ? TOOLS.filter((t) => allowed.has(t.name)) : TOOLS;
  if (!defaultRepo && !withAnnotations && !withRich) return TOOLS_;
  return TOOLS_.map((t) => ({
    ...t,
    ...(withRich && TOOL_META[t.name] ? { title: TOOL_META[t.name]!.title } : {}),
    ...(withRich && OUTPUT_SCHEMAS[t.name] ? { outputSchema: OUTPUT_SCHEMAS[t.name] } : {}),
    ...(withAnnotations ? { annotations: annotationsFor(t.name) } : {}),
    inputSchema: !defaultRepo
      ? t.inputSchema
      : {
          ...t.inputSchema,
          properties: {
            ...t.inputSchema.properties,
            repo: {
              type: "string",
              description: `Absolute path to the repository root (optional — defaults to ${defaultRepo})`,
            },
          },
          required: (t.inputSchema.required as readonly string[]).filter((r) => r !== "repo"),
        },
  }));
}
