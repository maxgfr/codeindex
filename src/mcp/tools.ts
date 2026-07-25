// The MCP tool catalogue: the 26 tool definitions, their display metadata, and
// the per-protocol-version view of the list a client actually receives.
//
// Split out of mcp.ts because it is pure data plus one projection function —
// nothing here scans a repo or touches the wire — and because it is the part a
// reader most often wants to consult on its own.
import { ANNOTATIONS_SINCE, PROTOCOL_VERSIONS, RICH_TOOLS_SINCE } from "./protocol.js";

const repoProp = { repo: { type: "string", description: "Absolute path to the repository root" } };
const scopeProps = {
  scope: { type: "string", description: "Restrict to one directory (repo-relative)" },
  include: { type: "array", items: { type: "string" }, description: "Include globs" },
  exclude: { type: "array", items: { type: "string" }, description: "Exclude globs" },
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
      properties: { ...repoProp, name: { type: "string", description: "Symbol name to look up" } },
      required: ["repo"],
    },
  },
  {
    name: "callers",
    description:
      "Who calls a function? Per-symbol caller index: each defined symbol with the exact (file, line) call sites that bind to it. Omit `name` for the full index.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        name: { type: "string", description: "Symbol name to look up" },
        recall: {
          type: "boolean",
          description:
            "Recall-oriented binding: relax the JS/TS import gate to unique repo-wide names, labelling each site corroborated|unique-name (default false = precision)",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "workspaces",
    description:
      "Detect monorepo packages (npm/pnpm/yarn/lerna/nx/cargo/go.work/maven) with the workspace dependency graph, one cycle if present, and a topological build order.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "churn",
    description: "Per-file git commit counts (whole history, or since a ref) — the churn half of hotspot analysis.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: { type: "string", description: "Only count commits after this ref" } },
      required: ["repo"],
    },
  },
  {
    name: "symbols_overview",
    description:
      "All symbols declared in ONE file (name, kind, line span, exported, parent), in declaration order — the fastest way to understand a file without reading it.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, file: { type: "string", description: "Repo-relative file path" } },
      required: ["repo", "file"],
    },
  },
  {
    name: "find_symbol",
    description:
      "Find symbol declarations by name or name path ('Class/method' matches a method inside Class). Options: substring matching, includeBody to return the declaration's source. Exact-name matches rank first.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        namePath: { type: "string", description: "Symbol name or Parent/child path" },
        substring: { type: "boolean" },
        includeBody: { type: "boolean" },
        maxResults: { type: "number", description: "Cap matches (default 50)" },
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
      properties: { ...repoProp, name: { type: "string", description: "Symbol name" } },
      required: ["repo", "name"],
    },
  },
  {
    name: "repo_map",
    description:
      "Token-budgeted map of the repository: the highest-PageRank files with their key exported signatures, deterministically rendered to fit `budgetTokens` (default 1024). The densest single read to understand an unfamiliar codebase.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, budgetTokens: { type: "number", description: "Approximate token budget (default 1024)" } },
      required: ["repo"],
    },
  },
  {
    name: "hotspots",
    description:
      "Where does work concentrate? Files ranked by git churn × size (commits × log2 lines). High-scoring files are where changes and defects cluster.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: { type: "string", description: "Only count commits after this ref" } },
      required: ["repo"],
    },
  },
  {
    name: "coupling",
    description:
      "Change coupling: pairs of files that repeatedly change in the same commits — hidden dependencies no import shows. strength 1.0 = every change to one touched the other.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, since: { type: "string", description: "Only mine commits after this ref" } },
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
      "Dead-code candidates in two labeled tiers: 'unreferenced' (no call site binds AND nothing references the name) and 'uncalled' (referenced somewhere — re-export, type position — but never called). Exported symbols only; test files and entrypoint-looking files excluded as roots. On a large repo this list runs to thousands of entries — pass `limit`, or `scope` to one subdirectory.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        limit: { type: "number", description: "Cap entries (default: all)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "complexity",
    description:
      "Cyclomatic-complexity estimates (branch-token counting over AST line spans), most-complex first. Pass `file` for one file's symbols, omit for the repo-wide top. Combine with hotspots: the `risk` field of this tool's sibling ranks complexity × churn.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, file: { type: "string" }, risk: { type: "boolean", description: "Return complexity × git-churn risk ranking instead" } },
      required: ["repo"],
    },
  },
  {
    name: "mermaid",
    description:
      "Mermaid diagram of the module graph (renders inline in Claude/GitHub — no graph database). Optionally scoped to one module's neighborhood.",
    inputSchema: {
      type: "object",
      properties: { ...repoProp, module: { type: "string", description: "Module slug to focus on" } },
      required: ["repo"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents (ripgrep when available, deterministic JS fallback otherwise). Returns sorted (file, line, text) hits.",
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        pattern: { type: "string", description: "Regular expression to search for" },
        scope: { type: "string", description: "Restrict to one directory (repo-relative)" },
        globs: { type: "array", items: { type: "string" }, description: "Restrict to matching paths" },
        ignoreCase: { type: "boolean" },
        maxHits: { type: "number" },
      },
      required: ["repo", "pattern"],
    },
  },
  {
    name: "search",
    description:
      'Natural-language-ish lexical search: BM25 ranking (k1=1.2, b=0.75) over symbol names (camelCase/snake_case subtokens), file path segments, markdown headings and summary lines. NOT embeddings by default — deterministic, diacritic-folded, zero API keys. Answers "where is auth handled?"-style queries with ranked files, matched terms and top symbols. Query terms with zero document frequency get a deterministic trigram-fuzzy fallback (typo-tolerant) unless `fuzzy: false`. Set `semantic: true` to RRF-fuse an embedding tier (HTTP endpoint, else a local static model) with lexical — the response then wraps the ranked list as `{ results, tier, degradedReason? }`, `tier` being "endpoint"/"static" when fusion happened or "lexical" (with `degradedReason`) when it did not (see embed_status). Without `semantic`, the response is the bare ranked array, unchanged.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        query: { type: "string", description: "Natural-language or identifier query" },
        limit: { type: "number", description: "Max results (default 20)" },
        fuzzy: {
          type: "boolean",
          description:
            "Trigram fuzzy fallback for query terms with zero document frequency (default true)",
        },
        semantic: {
          type: "boolean",
          description:
            'RRF-fuse an embedding tier with lexical (default false). Precedence: the HTTP endpoint (CODEINDEX_EMBED_ENDPOINT) if set, else a local static model. The response reports the effective tier as a top-level `tier` field ("endpoint"/"static" on success, "lexical" plus `degradedReason` when neither is available/reachable) instead of degrading silently — see embed_status.',
        },
      },
      required: ["repo", "query"],
    },
  },
  {
    name: "embed_status",
    description:
      "Report the embedding tier: the effective mode (none/static/endpoint; endpoint > static model), the resolved model (opt-in, never shipped in the package) with its modelId/dim, EMBED_VERSION, and the configured HTTP endpoint with its reachability. Use to check whether `search` with semantic:true will fuse embeddings or degrade to lexical.",
    inputSchema: { type: "object", properties: { ...repoProp }, required: ["repo"] },
  },
  {
    name: "check_rules",
    description:
      'Validate dependency-cruiser-style architecture rules against the link-graph. Rules (inline JSON array): forbidden edges {name, from, to, kind?, severity?, comment?} with glob paths, plus builtins {name, builtin: "cycles"|"orphans"} (module-level import cycles; edge-less code files). Returns deterministic violations with severity error|warn — a CI gate.',
    inputSchema: {
      type: "object",
      properties: {
        ...repoProp,
        ...scopeProps,
        rules: { type: "array", description: "Rules array (inline JSON — see description)" },
        configPath: {
          type: "string",
          description:
            "Read the rules from this JSON file instead (repo-relative or absolute) — the CLI's --config. Ignored when `rules` is given.",
        },
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
//     `semantic`). A schema that cannot describe every response is worse than
//     none: it would make a conforming client reject valid output.
//   * text responses — repo_map, mermaid, read_memory, which are not JSON.
//
// Shapes are deliberately open (no `additionalProperties: false`): a later
// engine adding a field must not turn a strict client's success into a failure.
const strArr = { type: "array", items: { type: "string" } };
const anyObj = { type: "object" };

export const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
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
  // The whole index (symbol name -> entry), one entry, or the not-found notice.
  callers: {
    oneOf: [
      { type: "object", additionalProperties: anyObj },
      { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
    ],
  },
  workspaces: {
    type: "object",
    properties: {
      packages: { type: "array", items: anyObj },
      cycle: { type: ["array", "null"], items: { type: "string" } },
      topoOrder: strArr,
    },
    required: ["packages", "topoOrder"],
  },
  churn: {
    type: "object",
    properties: { ok: { type: "boolean" }, churn: { type: "object", additionalProperties: { type: "integer" } } },
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
  hotspots: {
    type: "object",
    properties: { churnOk: { type: "boolean" }, hotspots: { type: "array", items: anyObj } },
    required: ["churnOk", "hotspots"],
  },
  coupling: {
    type: "object",
    properties: { ok: { type: "boolean" }, couplings: { type: "array", items: anyObj } },
    required: ["ok", "couplings"],
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
// The hints matter operationally: they are what lets a host auto-approve the 23
// read-only tools and hold a confirmation for the 5 that write. Without them a
// client must treat `scan_summary` and `replace_symbol_body` alike.
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
  repo_map: { title: "Repository map" },
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
  complexity: { title: "Complexity" },
  mermaid: { title: "Mermaid module diagram" },
  grep: { title: "Grep file contents" },
  search: { title: "Lexical search", openWorld: true },
  embed_status: { title: "Embedding tier status", openWorld: true },
  check_rules: { title: "Check architecture rules" },
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
export function toolsFor(defaultRepo?: string, protocolVersion: string = PROTOCOL_VERSIONS[0]): readonly unknown[] {
  const withAnnotations = protocolVersion >= ANNOTATIONS_SINCE;
  // Tool.title and Tool.outputSchema both arrive in 2025-06-18.
  const withRich = protocolVersion >= RICH_TOOLS_SINCE;
  if (!defaultRepo && !withAnnotations && !withRich) return TOOLS;
  return TOOLS.map((t) => ({
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
