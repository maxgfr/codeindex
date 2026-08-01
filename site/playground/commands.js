// The command palette: every codeindex command that means something in a
// browser, mapped onto the library function behind it.
//
// Kept separate from worker.js so it can be tested in Node against a real
// index, with no Worker, no fetch and no DOM. That separation is not
// bookkeeping — this table is where a wrong argument shape hides (the engine's
// read APIs take (graph, target, depth) and (scan, importPairs) far more often
// than the option bags one assumes), and a failure here surfaces as an empty
// result rather than a crash. tests/playground-commands.test.ts runs the whole
// table so those mistakes fail loudly and immediately.
//
// The Node CLI is deliberately NOT reused: engine-cli.ts is 978 lines of argv
// parsing, stdout writing and process exits, none of which mean anything here.

/**
 * Build the command table.
 *
 * @param engine the browser engine bundle (or the Node barrel, under test)
 * @param mount  VFS path the repository is mounted at
 */
export function buildCommandTable(engine, mount) {
  // Derived structures several commands share. Each is a pure function of the
  // scan, so they are memoised per session instead of rebuilt per keystroke.
  const importPairs = (session) => (session.importPairs ??= engine.computeImportPairs(session.artifacts.scan));
  const hierarchy = (session) => (session.hierarchy ??= engine.buildTypeHierarchy(session.artifacts.scan, importPairs(session)));
  const symbolGraph = (session) => (session.symbolGraph ??= engine.buildSymbolGraph(session.artifacts.scan, importPairs(session)));

  const arg = (args, what) => {
    const value = (args ?? "").trim();
    if (!value) throw new Error(`This command needs ${what}.`);
    return value;
  };

  // Map instances do not survive a structured clone in a readable shape, and
  // JSON.stringify renders them as {}. Convert before they leave the worker.
  const plain = (value) =>
    value instanceof Map ? Object.fromEntries([...value].map(([k, v]) => [k, v instanceof Map ? Object.fromEntries(v) : v])) : value;

  return {
    scan: {
      hint: "",
      describe: "File count, language histogram, capped flag",
      // Takes a root, not a scan — the same call the CLI makes. Re-walking the
      // VFS is cheap because it is entirely in memory.
      run: () => ({ kind: "json", data: engine.scanSummary(mount) }),
    },
    search: {
      hint: "<query>",
      describe: "BM25 over symbol names, path segments, headings and summaries",
      run: (session, args) => ({ kind: "hits", data: engine.searchIndex(session.artifacts.scan, arg(args, "a query")) }),
    },
    grep: {
      hint: "<pattern>",
      describe: "Regex over file contents — the pure-JS backend, no ripgrep here",
      run: (session, args) => ({ kind: "grep", data: engine.grepRepo(mount, arg(args, "a pattern"), { maxHits: 200 }) }),
    },
    symbols: {
      hint: "<file>",
      describe: "Symbols declared in one file, with signature, doc and parent",
      run: (session, args) => {
        const rel = arg(args, "a repo-relative file path");
        const found = engine.symbolsOverview(session.artifacts.scan, rel);
        if (!found.length) throw new Error(`No symbols for "${rel}" — check the path, or try: search ${rel}`);
        return { kind: "symbols", data: found };
      },
    },
    find: {
      hint: "<name>",
      describe: "Locate a symbol by name, or by a Class/method path",
      run: (session, args) => ({
        kind: "json",
        data: engine.findSymbol(session.artifacts.scan, arg(args, "a symbol name"), { substring: true, maxResults: 50 }),
      }),
    },
    refs: {
      hint: "<name>",
      describe: "Definitions, call sites and referencing files for a symbol",
      run: (session, args) => ({ kind: "json", data: engine.findReferences(session.artifacts.scan, arg(args, "a symbol name")) }),
    },
    callers: {
      hint: "",
      describe: "Per-symbol caller index",
      run: (session) => ({ kind: "json", data: plain(engine.buildCallerIndex(session.artifacts.scan, importPairs(session))) }),
    },
    hierarchy: {
      hint: "<type>",
      describe: "What a type extends and implements, and what extends it",
      run: (session, args) => {
        const name = arg(args, "a type name");
        const entry = engine.typeEntry(hierarchy(session), name);
        if (!entry) throw new Error(`No type named "${name}" in this index.`);
        return { kind: "json", data: entry };
      },
    },
    implementations: {
      hint: "<type>",
      describe: "Everything implementing or extending a type, transitively",
      run: (session, args) => ({ kind: "json", data: engine.implementationsOf(hierarchy(session), arg(args, "a type name")) }),
    },
    callgraph: {
      hint: "<symbol>",
      describe: "Bounded symbol-to-symbol neighbourhood",
      run: (session, args) => ({ kind: "json", data: engine.neighborhood(symbolGraph(session), arg(args, "a symbol"), { depth: 2 }) }),
    },
    impact: {
      hint: "<file|module>",
      describe: "Everything that transitively imports, uses or calls a file",
      run: (session, args) => {
        const target = arg(args, "a file or module");
        const result = engine.impactOf(session.artifacts.graph, target);
        if (!result) throw new Error(`"${target}" is not a file or module in this index.`);
        return { kind: "json", data: result };
      },
    },
    neighbors: {
      hint: "<file|module>",
      describe: "Graph neighbours of a file or module, both directions",
      run: (session, args) => {
        const target = arg(args, "a file or module");
        const result = engine.neighborsOf(session.artifacts.graph, target, 1);
        if (!result) throw new Error(`"${target}" is not a file or module in this index.`);
        return { kind: "json", data: result };
      },
    },
    modules: {
      hint: "",
      describe: "Module grouping with PageRank, community and test map",
      run: (session) => ({ kind: "modules", data: session.artifacts.graph.modules }),
    },
    workspaces: {
      hint: "",
      describe: "Monorepo packages and their dependency graph",
      run: () => ({ kind: "json", data: engine.detectWorkspaces(mount) }),
    },
    repomap: {
      hint: "[budget]",
      describe: "Token-budgeted map of the highest-PageRank files",
      run: (session, args) => ({
        kind: "text",
        data: engine.renderRepoMap(session.artifacts.scan, session.artifacts.graph, { budgetTokens: Number((args ?? "").trim()) || 2000 }),
      }),
    },
    mermaid: {
      hint: "[module]",
      describe: "Mermaid diagram of the module graph",
      run: (session, args) => {
        const module = (args ?? "").trim();
        return { kind: "mermaid", data: engine.renderMermaid(session.artifacts.graph, module ? { module } : {}) };
      },
    },
    deadcode: {
      hint: "",
      describe: "Dead-code candidates in two labelled tiers",
      run: (session) => ({ kind: "json", data: engine.findDeadCode(session.artifacts.scan) }),
    },
    complexity: {
      hint: "[file]",
      describe: "Cyclomatic-complexity estimates, most complex first",
      run: (session, args) => ({ kind: "json", data: engine.symbolComplexity(session.artifacts.scan, (args ?? "").trim() || undefined) }),
    },
    graph: {
      hint: "",
      describe: "The full link-graph as graph.json",
      run: (session) => ({ kind: "download", filename: "graph.json", data: engine.renderGraphJson(session.artifacts.graph) }),
    },
    index: {
      hint: "",
      describe: "Both artifacts, exactly as `codeindex index` writes them",
      run: (session) => ({
        kind: "artifacts",
        data: {
          "graph.json": engine.renderGraphJson(session.artifacts.graph),
          "symbols.json": engine.renderSymbolsJson(session.artifacts.symbols),
        },
      }),
    },
    scip: {
      hint: "",
      describe: "SCIP code-intelligence index (protobuf), downloadable",
      run: (session) => ({
        kind: "binary",
        filename: "index.scip",
        data: engine.renderScip(session.artifacts.scan, { projectRoot: `${session.owner}/${session.repo}` }),
      }),
    },
    rules: {
      hint: "<json>",
      describe: "Validate architecture rules against the link-graph",
      run: (session, args) => {
        const raw = arg(args, "a rules config as inline JSON");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new Error(`The rules config is not valid JSON: ${error.message}`);
        }
        return { kind: "json", data: engine.checkRules(session.artifacts.graph, engine.parseRules(parsed)) };
      },
    },
    rewrite: {
      hint: "<command line>",
      describe: "Map a tree-wide search onto its indexed equivalent",
      run: (session, args) => ({
        kind: "text",
        data: engine.rewriteCommand(arg(args, "a command line")) ?? "(no opinion — run the original command)",
      }),
    },
    grammars: {
      hint: "",
      describe: "Which tree-sitter grammars loaded, and the active tier",
      run: (session) => ({ kind: "json", data: { ...session.grammars, resolution: engine.resolveGrammarsTier() } }),
    },

    // Listed, disabled, and told why. A command that needs git history cannot
    // work against a tree fetched file-by-file from a CDN — and saying so beats
    // both hiding it and returning a confidently empty result.
    churn: { hint: "", describe: "Per-file git commit counts", unavailable: "needs git history" },
    coupling: { hint: "", describe: "Files that change together", unavailable: "needs git history" },
    hotspots: { hint: "", describe: "Churn × size ranking", unavailable: "needs git history" },
    risk: { hint: "", describe: "Complexity × churn ranking", unavailable: "needs git history" },
    delta: { hint: "", describe: "Review panel for a git diff", unavailable: "needs git history" },
    embed: { hint: "", describe: "Embedding tier for semantic search", unavailable: "needs a model download" },
    mcp: { hint: "", describe: "Run as an MCP server", unavailable: "needs a stdio transport" },
  };
}

/** Run one command, with the same error vocabulary the UI shows. */
export function runCommand(commands, session, name, args = "") {
  const command = commands[name];
  if (!command) throw new Error(`Unknown command "${name}". Press ⌘K for the list.`);
  if (command.unavailable) throw new Error(`"${name}" ${command.unavailable} — not available in the browser.`);
  if (!session) throw new Error("Load a repository first.");
  return command.run(session, args);
}

/** The palette, as the UI renders it: one source of truth for what exists. */
export function describeCommands(commands) {
  return Object.entries(commands).map(([name, command]) => ({
    name,
    hint: command.hint,
    describe: command.describe,
    unavailable: command.unavailable ?? "",
  }));
}
