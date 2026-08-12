// Runs the playground's whole command palette against a real index.
//
// This suite exists because of the failure mode it prevents. The palette maps
// ~23 commands onto engine functions whose signatures are not uniform —
// `impactOf(graph, target, depth)` takes a number where one assumes an option
// bag, `buildSymbolGraph(scan, importPairs)` needs a second argument, hierarchy
// commands take a prebuilt Map rather than a scan. Get any of those wrong and
// the command does not crash: it returns undefined, or an empty list, and the
// playground quietly shows "no results" for a repo that plainly has some.
//
// So every available command is executed here, with arguments taken from the
// index itself, and asserted to return something. The commands marked
// unavailable are asserted to refuse for a stated reason rather than silently
// return nothing — the honesty guarantee, tested.

import { describe, it, expect, beforeAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PALETTE = new URL("../site/playground/commands.js", import.meta.url).href;
const REPORT = new URL("../site/playground/report.js", import.meta.url).href;
const BUNDLE = new URL("../scripts/engine.browser.mjs", import.meta.url).href;
const GRAMMARS = join(REPO_ROOT, "scripts", "grammars");
const MOUNT = "/repo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let engine: Any;
let commands: Any;
let session: Any;
// commands.js is hand-written browser JS with no declarations — imported
// dynamically so TypeScript does not try to resolve types for it.
let buildCommandTable: Any;
let runCommand: Any;
let describeCommands: Any;
let summariseIndex: Any;

function collect(dir: string, base: string): { path: string; size: number; bytes: Uint8Array }[] {
  const out: { path: string; size: number; bytes: Uint8Array }[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...collect(abs, base));
    else {
      const bytes = new Uint8Array(readFileSync(abs));
      out.push({ path: `${MOUNT}/${relative(base, abs).split(/[\\/]/).join("/")}`, size: bytes.byteLength, bytes });
    }
  }
  return out;
}

beforeAll(async () => {
  engine = await import(/* @vite-ignore */ BUNDLE);
  ({ buildCommandTable, runCommand, describeCommands } = await import(/* @vite-ignore */ PALETTE));
  ({ summariseIndex } = await import(/* @vite-ignore */ REPORT));
  commands = buildCommandTable(engine, MOUNT);

  const dir = mkdtempSync(join(tmpdir(), "codeindex-palette-"));
  cpSync(join(REPO_ROOT, "tests", "fixtures", "mini-repo"), join(dir, "repo"), { recursive: true });

  engine.resetVfs();
  const files = collect(join(dir, "repo"), join(dir, "repo"));
  engine.mountFiles(files);

  const keys: string[] = engine.grammarKeysForExts(new Set(files.map((f) => extname(f.path).toLowerCase())));
  engine.mountRuntime(new Uint8Array(readFileSync(join(GRAMMARS, engine.RUNTIME_WASM))));
  for (const key of keys) engine.mountGrammar(key, new Uint8Array(readFileSync(join(GRAMMARS, engine.grammarWasmName(key)))));
  await engine.ensureGrammars(keys);

  session = {
    owner: "test",
    repo: "mini-repo",
    ref: "main",
    artifacts: engine.buildIndexArtifacts(MOUNT),
    grammars: { tier: "ast", loaded: keys, failed: [] },
  };
});

/** Arguments drawn from the index itself, so they are always valid for it. */
function argsFor(name: string): string {
  const firstFile = session.artifacts.graph.files.find((f: Any) => f.rel.endsWith(".ts"))?.rel ?? session.artifacts.graph.files[0].rel;
  const someSymbol = Object.keys(session.artifacts.symbols.defs)[0] ?? "";
  const someModule = session.artifacts.graph.modules[0]?.slug ?? "";
  switch (name) {
    case "search":
      return "client";
    case "grep":
      return "export";
    case "symbols":
      return firstFile;
    case "find":
    case "refs":
    case "callgraph":
      return someSymbol;
    case "hierarchy":
    case "implementations":
      return "";
    case "impact":
    case "neighbors":
      return firstFile;
    case "mermaid":
      return someModule;
    case "repomap":
      return "1500";
    case "complexity":
      return "";
    case "rules":
      return JSON.stringify({ rules: [] });
    case "rewrite":
      return "rg --files-with-matches TODO";
    default:
      return "";
  }
}

describe("playground command palette", () => {
  const available = () => describeCommands(commands).filter((c: Any) => !c.unavailable);

  it("exposes the commands the UI advertises", () => {
    const names = describeCommands(commands).map((c: Any) => c.name);
    expect(names).toContain("search");
    expect(names).toContain("repomap");
    expect(names).toContain("scip");
    // Every entry must carry a description; the palette renders it.
    for (const command of describeCommands(commands)) expect(command.describe.length).toBeGreaterThan(0);
  });

  it("runs every available command without throwing, and returns a shaped result", () => {
    const failures: string[] = [];
    for (const { name } of available()) {
      // hierarchy/implementations need a type that exists; mini-repo may have
      // none, and "no such type" is a legitimate answer rather than a bug.
      if (name === "hierarchy" || name === "implementations") continue;
      try {
        const result = runCommand(commands, session, name, argsFor(name));
        expect(result, `${name} returned nothing`).toBeTruthy();
        expect(typeof result.kind, `${name} has no result kind`).toBe("string");
        expect(result.data, `${name} returned no data`).toBeDefined();
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("returns real content for the commands the playground leads with", () => {
    // A signature mistake usually shows up as an empty result, not a throw —
    // so the headline commands are checked for substance, not just shape.
    const search = runCommand(commands, session, "search", "client");
    expect(search.data.length).toBeGreaterThan(0);
    expect(search.data[0].file).toBeTruthy();
    // A query that really matched carries no caveat — the banner and the
    // "no exact match" meta line must stay off for an ordinary search.
    expect(search.verdict).toBe("match");
    expect(search.note).toBeUndefined();

    const grep = runCommand(commands, session, "grep", "export");
    expect(grep.data.length).toBeGreaterThan(0);

    const symbols = runCommand(commands, session, "symbols", argsFor("symbols"));
    expect(symbols.data.length).toBeGreaterThan(0);
    expect(symbols.data[0].name).toBeTruthy();

    const repomap = runCommand(commands, session, "repomap", "1500");
    expect(repomap.data.length).toBeGreaterThan(0);

    const mermaid = runCommand(commands, session, "mermaid", "");
    expect(mermaid.data).toContain("graph");

    const modules = runCommand(commands, session, "modules", "");
    expect(modules.data.length).toBeGreaterThan(0);

    const scip = runCommand(commands, session, "scip", "");
    expect(scip.data.byteLength).toBeGreaterThan(0);

    const artifacts = runCommand(commands, session, "index", "");
    expect(artifacts.data["graph.json"]).toContain('"files"');
    expect(artifacts.data["symbols.json"]).toContain('"defs"');

    const neighbors = runCommand(commands, session, "neighbors", argsFor("neighbors"));
    expect(neighbors.data).toBeTruthy();
  });

  it("refuses the git-dependent commands with a stated reason", () => {
    for (const name of ["churn", "coupling", "hotspots", "risk", "delta"]) {
      expect(() => runCommand(commands, session, name, "")).toThrow(/git history/);
    }
    expect(() => runCommand(commands, session, "embed", "")).toThrow(/model/);
    expect(() => runCommand(commands, session, "mcp", "")).toThrow(/stdio/);
  });

  it("asks for a repository before anything is loaded", () => {
    expect(() => runCommand(commands, null, "search", "x")).toThrow(/Load a repository/);
  });

  it("reports a summary with every number the page displays defined", () => {
    // A wrong field name here does not throw — it renders "undefined" in a stat
    // tile. `graph.edges` (the field is `fileEdges`) got through review exactly
    // that way, so every reported number is asserted to be a real number.
    const summary = summariseIndex(engine, session, {
      manifestFiles: 20,
      walkedFiles: 14,
      selected: 14,
      excluded: 6,
      pruned: 6,
      unreadable: 0,
      capped: false,
      cappedBy: "",
      elapsedMs: 42,
    });

    for (const field of [
      "manifestFiles",
      "walkedFiles",
      "selectedFiles",
      "indexedFiles",
      "excluded",
      "pruned",
      "unreadable",
      "elapsedMs",
      "residentBytes",
      "symbolCount",
      "edgeCount",
      "moduleEdgeCount",
      "moduleCount",
    ]) {
      expect(Number.isFinite(summary[field]), `summary.${field} is not a number: ${summary[field]}`).toBe(true);
    }

    expect(summary.indexedFiles).toBeGreaterThan(0);
    expect(summary.symbolCount).toBeGreaterThan(0);
    expect(summary.moduleCount).toBeGreaterThan(0);
    expect(Object.keys(summary.languages).length).toBeGreaterThan(0);
    expect(summary.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(summary.grammars.tier).toBe("ast");
  });

  it("names the missing argument instead of returning empty", () => {
    expect(() => runCommand(commands, session, "search", "")).toThrow(/needs a query/);
    expect(() => runCommand(commands, session, "symbols", "")).toThrow(/needs a repo-relative file path/);
    expect(() => runCommand(commands, session, "impact", "no/such/file.ts")).toThrow(/not a file or module/);
  });
});

// The playground could not raise the result cap or turn the fuzzy fallback off:
// every token after the command name went through as query text, so
// `search --limit 50 foo` searched for the words "limit 50 foo" and the cap
// stayed pinned at the engine default of 20. That made any playground-versus-CLI
// comparison meaningless on a query with more than 20 hits.
describe("search flags", () => {
  it("parses --limit instead of searching for the word 'limit'", () => {
    const capped = runCommand(commands, session, "search", "--limit 1 client");
    expect(capped.data).toHaveLength(1);
    // …and the query itself is what is left over, not the flag tokens.
    expect(capped.data[0].file).toBe(runCommand(commands, session, "search", "client").data[0].file);
  });

  it("parses --no-fuzzy, and --exact drops the bridge-only rows", () => {
    expect(runCommand(commands, session, "search", "clientt").data.length).toBeGreaterThan(0);
    expect(runCommand(commands, session, "search", "clientt --no-fuzzy").data).toHaveLength(0);
    expect(runCommand(commands, session, "search", "--exact clientt").data).toHaveLength(0);
  });

  it("refuses an unknown flag rather than searching for it", () => {
    // "--smantic" returning nothing is indistinguishable from a real miss.
    expect(() => runCommand(commands, session, "search", "--smantic client")).toThrow(/Unknown flag/);
    expect(() => runCommand(commands, session, "search", "--limit abc client")).toThrow(/positive number/);
  });

  it("surfaces the verdict and the note for a phantom identifier", () => {
    const result = runCommand(commands, session, "search", "clientt");
    expect(result.verdict).toBe("weak");
    expect(result.note).toContain("client");
    expect(result.data.every((hit: { bridgedOnly?: true }) => hit.bridgedOnly)).toBe(true);
  });
});
