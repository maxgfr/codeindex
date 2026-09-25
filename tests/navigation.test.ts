import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, type RepoScan } from "../src/scan.js";
import { buildCallerIndex, callerIndexForNames, lookupCallerEntry, rawCallerSitesFor, refNames, buildRawCallerIndex } from "../src/callers.js";
import { buildTypeHierarchy, implementationsOf, typeEntry } from "../src/relations.js";
import { buildSymbolGraph, neighborhood } from "../src/symbolgraph.js";
import { explainNoCallers, findReferences, resolveSymbolRef } from "../src/query.js";
import { importPairsFor } from "../src/derived.js";
import { formatSymbolRef, refMatches, symbolRefReadings } from "../src/symref.js";

// One symbol syntax across callers / hierarchy / implementations / callgraph /
// find_references, the "no tracked callers" diagnosis, and the CLI surface
// around them (exit codes, --raw, --limit, file-argument spellings).

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

const FILES: Record<string, string> = {
  // Two homonyms of `greet`; each caller imports exactly one of them.
  "src/lib/greet.ts": [
    "export function greet(name: string): string {",
    '  return "hi " + name;',
    "}",
    "export class Greeter {",
    "  hello(): string {",
    '    return greet("x");',
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/other/greet2.ts": "export function greet(n: number): number {\n  return n;\n}\n",
  "src/homonym.ts": 'import { greet } from "./other/greet2.js";\nexport function useHomonym(): number {\n  return greet(2);\n}\n',
  "src/app.ts": 'import { greet } from "./lib/greet.js";\nexport function main(): void {\n  greet("a");\n}\n',
  "src/lonely.ts": "export function lonely(): void {}\n",
  // Two homonym interfaces. The implementing Circle is itself the SECOND
  // `Circle` (a decoy sorts first), which the transitive walk used to lose.
  "src/shapes/a/shape.ts": "export interface Shape {\n  area(): number;\n}\n",
  "src/shapes/b/shape.ts": "export interface Shape {\n  label(): string;\n}\n",
  "src/aaa/circle.ts": "export class Circle {}\n",
  "src/shapes/b/circle.ts": 'import { Shape } from "./shape.js";\nexport class Circle implements Shape {\n  label(): string {\n    return "c";\n  }\n}\n',
  "src/shapes/b/ring.ts": 'import { Circle } from "./circle.js";\nexport class Ring extends Circle {}\n',
  // Python: `helper` defined twice at equal distance from the caller, so no
  // call site can be bound (flask's register_blueprint, in miniature).
  "pkg/a/x.py": "def helper():\n    return 1\n",
  "pkg/b/y.py": "def helper():\n    return 2\n",
  "pkg/main.py": "def run():\n    helper()\n    helper()\n    external_thing()\n",
};

let repo: string;
let scan: RepoScan;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ci-navigation-"));
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  scan = scanRepo(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("symbol ref readings", () => {
  it("reads every documented form, literal first", () => {
    expect(symbolRefReadings("greet")).toEqual([{ name: "greet" }]);
    expect(symbolRefReadings("greet@src/a.ts")).toEqual([{ name: "greet@src/a.ts" }, { name: "greet", file: "src/a.ts" }]);
    expect(symbolRefReadings("src/a.ts#Greeter/hello")).toEqual([
      { name: "src/a.ts#Greeter/hello" },
      { name: "hello", parent: "Greeter", file: "src/a.ts" },
    ]);
    expect(symbolRefReadings("Outer/Inner/m")).toEqual([{ name: "Outer/Inner/m" }, { name: "m", parent: "Outer/Inner" }]);
    // A path holding "@" or "#" still yields the right split among the readings.
    expect(symbolRefReadings("src/@types/x.ts#Foo")).toContainEqual({ name: "Foo", file: "src/@types/x.ts" });
    expect(symbolRefReadings("Foo@src/@types/x.ts")).toContainEqual({ name: "Foo", file: "src/@types/x.ts" });
    // Ruby's unary minus is a name that ends in "@": read literally only.
    expect(symbolRefReadings("-@")).toEqual([{ name: "-@" }]);
  });

  it("matches a parent path against the ancestor path, segment-aligned", () => {
    const s = { name: "m", file: "f.ts", parent: "Inner", parentPath: "Outer/Inner" };
    expect(refMatches({ name: "m", parent: "Inner" }, s)).toBe(true);
    expect(refMatches({ name: "m", parent: "Outer/Inner" }, s)).toBe(true);
    expect(refMatches({ name: "m", parent: "nner" }, s)).toBe(false);
    expect(refMatches({ name: "m", parent: "Other" }, s)).toBe(false);
    expect(formatSymbolRef({ name: "m", parent: "Inner", file: "f.ts" })).toBe("Inner/m@f.ts");
  });

  it("resolves declarations from the first reading that matches", () => {
    expect(resolveSymbolRef(scan, "greet")!.defs.map((d) => d.file)).toEqual(["src/lib/greet.ts", "src/other/greet2.ts"]);
    expect(resolveSymbolRef(scan, "greet@src/other/greet2.ts")!.defs.map((d) => d.file)).toEqual(["src/other/greet2.ts"]);
    expect(resolveSymbolRef(scan, "src/lib/greet.ts#Greeter/hello")!.defs.map((d) => [d.name, d.line])).toEqual([["hello", 5]]);
    expect(resolveSymbolRef(scan, "Greeter/hello")!.reading).toEqual({ name: "hello", parent: "Greeter" });
    expect(resolveSymbolRef(scan, "Nobody/hello")).toBeUndefined();
    expect(resolveSymbolRef(scan, "nope")).toBeUndefined();
  });
});

describe("callers: one syntax, and a single-name path that matches the full index", () => {
  it("reaches the FIRST homonym through every qualified form", () => {
    const index = buildCallerIndex(scan);
    const first = index.get("greet")!;
    expect(first.def.file).toBe("src/lib/greet.ts");
    for (const ref of ["greet@src/lib/greet.ts", "src/lib/greet.ts#greet"]) expect(lookupCallerEntry(index, ref)).toBe(first);
    const second = lookupCallerEntry(index, "src/other/greet2.ts#greet")!;
    expect(second.callers).toEqual([{ file: "src/homonym.ts", line: 3 }]);
    expect(lookupCallerEntry(index, "greet@src/other/greet2.ts")).toBe(second);
  });

  it("answers every ref exactly as the whole-repo index does, recall included", () => {
    const refs = ["greet", "greet@src/other/greet2.ts", "src/lib/greet.ts#greet", "Greeter/hello", "helper", "main", "lonely", "nope"];
    for (const recall of [false, true]) {
      const full = buildCallerIndex(scan, undefined, { recall });
      for (const ref of refs) {
        const one = lookupCallerEntry(callerIndexForNames(scan, refNames(ref), { recall }), ref);
        expect(one, `${ref} recall=${recall}`).toEqual(lookupCallerEntry(full, ref));
      }
    }
  });

  it("builds only the entries of the names asked for", () => {
    expect([...callerIndexForNames(scan, ["greet"]).keys()]).toEqual(["greet", "greet@src/other/greet2.ts"]);
  });

  it("explains a symbol nothing binds to, and has nothing to explain for an unknown one", () => {
    const index = buildCallerIndex(scan);
    expect(index.has("helper")).toBe(false);
    const miss = explainNoCallers(scan, "helper", index)!;
    expect(miss.defs.map((d) => d.file)).toEqual(["pkg/a/x.py", "pkg/b/y.py"]);
    expect(miss.unresolvedSites).toBe(2);
    expect(miss.sample).toEqual([
      { file: "pkg/main.py", line: 2 },
      { file: "pkg/main.py", line: 3 },
    ]);
    expect(miss.error).toBe('no tracked callers for "helper"');
    // Declared and simply never called.
    const lonely = explainNoCallers(scan, "lonely", index)!;
    expect(lonely.unresolvedSites).toBe(0);
    expect(lonely.hint).toMatch(/no call site/);
    // A homonym whose sites all bind to the OTHER declaration has none unresolved.
    expect(explainNoCallers(scan, "greet@src/other/greet2.ts", new Map())!.unresolvedSites).toBe(3);
    expect(explainNoCallers(scan, "greet@src/other/greet2.ts", index)!.unresolvedSites).toBe(0);
    // Not declared anywhere, though it is called: an unknown symbol.
    expect(explainNoCallers(scan, "external_thing", index)).toBeUndefined();
  });

  it("walks one name's raw sites exactly as the raw index holds them", () => {
    const raw = buildRawCallerIndex(scan);
    for (const name of ["greet", "helper", "external_thing", "nope"]) expect(rawCallerSitesFor(scan, name)).toEqual(raw.get(name) ?? []);
  });
});

describe("find_references across homonyms", () => {
  it("merges every declaring file's call sites under a bare name, each tagged with its declaration", () => {
    const refs = findReferences(scan, "greet");
    expect(refs.defs.map((d) => d.file)).toEqual(["src/lib/greet.ts", "src/other/greet2.ts"]);
    expect(refs.callSites).toEqual([
      { file: "src/app.ts", line: 3, def: "src/lib/greet.ts" },
      { file: "src/homonym.ts", line: 3, def: "src/other/greet2.ts" },
      { file: "src/lib/greet.ts", line: 6, def: "src/lib/greet.ts" },
    ]);
  });

  it("narrows a qualified ref to its own declaration and call sites", () => {
    const refs = findReferences(scan, "greet@src/other/greet2.ts");
    expect(refs.defs.map((d) => d.file)).toEqual(["src/other/greet2.ts"]);
    expect(refs.callSites).toEqual([{ file: "src/homonym.ts", line: 3 }]);
    expect(findReferences(scan, "src/other/greet2.ts#greet")).toEqual(refs);
  });

  it("hands out copies of the memoized caller sites", () => {
    for (const ref of ["greet", "greet@src/other/greet2.ts"]) {
      const first = findReferences(scan, ref);
      first.callSites[0]!.line = 999;
      first.callSites.push({ file: "poison.ts", line: 1 });
    }
    expect(findReferences(scan, "greet@src/other/greet2.ts").callSites).toEqual([{ file: "src/homonym.ts", line: 3 }]);
    expect(findReferences(scan, "greet").callSites.map((c) => c.line)).toEqual([3, 3, 6]);
  });
});

describe("hierarchy and implementations take the same refs", () => {
  it("finds the first homonym by name@file and file#name", () => {
    const hierarchy = buildTypeHierarchy(scan, importPairsFor(scan));
    const first = hierarchy.get("Shape")!;
    expect(first.file).toBe("src/shapes/a/shape.ts");
    expect(typeEntry(hierarchy, "Shape@src/shapes/a/shape.ts")).toBe(first);
    expect(typeEntry(hierarchy, "src/shapes/a/shape.ts#Shape")).toBe(first);
    expect(typeEntry(hierarchy, "Shape@src/shapes/b/shape.ts")!.file).toBe("src/shapes/b/shape.ts");
    expect(typeEntry(hierarchy, "Shape@nowhere.ts")).toBeUndefined();
  });

  it("walks through a subtype that is itself a second homonym", () => {
    const hierarchy = buildTypeHierarchy(scan, importPairsFor(scan));
    expect(hierarchy.get("Circle")!.file).toBe("src/aaa/circle.ts"); // the decoy holds the bare key
    const impls = implementationsOf(hierarchy, "Shape@src/shapes/b/shape.ts").map((r) => `${r.name}@${r.file}`);
    expect(impls).toEqual(["Circle@src/shapes/b/circle.ts", "Ring@src/shapes/b/ring.ts"]);
  });

  it("settles a parent-qualified ref through its resolved declarations", () => {
    const hierarchy = buildTypeHierarchy(scan, importPairsFor(scan));
    // Entries do not know their parent, so without declarations the ref is unknown.
    expect(typeEntry(hierarchy, "src/shapes/b/shape.ts#Shape")!.file).toBe("src/shapes/b/shape.ts");
    const declared = [{ name: "Shape", file: "src/shapes/b/shape.ts" }];
    expect(typeEntry(hierarchy, "Parent/Shape")).toBeUndefined();
    expect(typeEntry(hierarchy, "Parent/Shape", declared)!.file).toBe("src/shapes/b/shape.ts");
  });
});

describe("callgraph takes the same refs and says when it clamps", () => {
  it("roots at name@file, file#Parent/name and Parent/name", () => {
    const graph = buildSymbolGraph(scan, importPairsFor(scan));
    const ids = (ref: string): string[] => neighborhood(graph, ref, { depth: 1 }).root.map((n) => n.id);
    expect(ids("greet")).toEqual(["src/lib/greet.ts#greet", "src/other/greet2.ts#greet"]);
    expect(ids("greet@src/other/greet2.ts")).toEqual(["src/other/greet2.ts#greet"]);
    expect(ids("src/lib/greet.ts#Greeter/hello")).toEqual(["src/lib/greet.ts#Greeter/hello"]);
    expect(ids("Greeter/hello")).toEqual(["src/lib/greet.ts#Greeter/hello"]);
    expect(ids("hello@src/lib/greet.ts")).toEqual(["src/lib/greet.ts#Greeter/hello"]);
    expect(ids("Nobody/hello")).toEqual([]);
  });

  it("reports the hop limit it actually walked", () => {
    const graph = buildSymbolGraph(scan, importPairsFor(scan));
    expect(neighborhood(graph, "greet", { depth: 9 }).depthClamped).toBe(5);
    expect(neighborhood(graph, "greet", { depth: 5 }).depthClamped).toBeUndefined();
  });
});

describe("CLI navigation surface", () => {
  const cli = (...args: string[]) => {
    const res = spawnSync(process.execPath, [CLI, ...args, "--repo", repo, "--no-index-cache"], { encoding: "utf8" });
    return { status: res.status, out: res.stdout, err: res.stderr, json: () => JSON.parse(res.stdout) };
  };

  it("callers: exit 2 for an unknown symbol, a diagnosis for one nothing binds to", () => {
    const unknown = cli("callers", "external_thing");
    expect(unknown.status).toBe(2);
    expect(unknown.err).toMatch(/no symbol named "external_thing".*1 call site/);
    const miss = cli("callers", "helper");
    expect(miss.status).toBe(0);
    expect(miss.json()).toMatchObject({ name: "helper", unresolvedSites: 2 });
    expect(cli("callers", "src/other/greet2.ts#greet").json().callers).toEqual([{ file: "src/homonym.ts", line: 3 }]);
  });

  it("callers --raw lists sites before any binding, and refuses --recall", () => {
    const raw = cli("callers", "helper", "--raw").json();
    expect(raw.name).toBe("helper");
    expect(raw.sites.map((s: { line: number }) => s.line)).toEqual([2, 3]);
    expect(raw.sites[0].enclosingSymbol.name).toBe("run");
    // A qualified ref reads as the name it qualifies.
    expect(cli("callers", "greet@src/other/greet2.ts", "--raw").json().name).toBe("greet");
    expect(cli("callers", "helper", "--raw", "--recall").status).toBe(2);
  });

  it("hierarchy, implementations and callgraph accept the first homonym's name@file", () => {
    expect(cli("hierarchy", "Shape@src/shapes/a/shape.ts").json().file).toBe("src/shapes/a/shape.ts");
    expect(cli("implementations", "src/shapes/b/shape.ts#Shape").json().implementations).toHaveLength(2);
    const graph = cli("callgraph", "greet@src/lib/greet.ts", "--depth", "9").json();
    expect(graph.root.map((n: { id: string }) => n.id)).toEqual(["src/lib/greet.ts#greet"]);
    expect(graph.depthClamped).toBe(5);
    expect(cli("hierarchy", "Nope").status).toBe(2);
  });

  it("complexity and deadcode honour --limit; deadcode says it truncated", () => {
    expect(cli("complexity", "--limit", "2").json()).toHaveLength(2);
    const all = cli("deadcode").json();
    expect(all.length).toBeGreaterThan(1);
    expect(cli("deadcode", "--limit", "1").json()).toEqual({ total: all.length, shown: 1, truncated: true, candidates: all.slice(0, 1) });
  });

  it("deadcode --kinds all widens the candidates, and an unknown --kinds is an error", () => {
    const callables = cli("deadcode").json();
    const every = cli("deadcode", "--kinds", "all").json();
    expect(every.length).toBeGreaterThanOrEqual(callables.length);
    const bad = cli("deadcode", "--kinds", "types");
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/--kinds expects callable\|all, got "types"/);
  });

  it("accepts ./path, absolute and backslashed file arguments, and rejects an unknown file", () => {
    const want = cli("complexity", "src/lib/greet.ts").json();
    expect(want.length).toBeGreaterThan(0);
    for (const spelling of ["./src/lib/greet.ts", join(repo, "src/lib/greet.ts"), "src\\lib\\greet.ts"]) {
      expect(cli("complexity", spelling).json(), spelling).toEqual(want);
    }
    const missing = cli("complexity", "nope.ts");
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/no such file in the index: nope\.ts/);
    expect(cli("impact", "./src/lib/greet.ts").json().target).toBe("src/lib/greet.ts");
    expect(cli("neighbors", join(repo, "src/app.ts")).json().target).toBe("src/app.ts");
  });

  it("neighbors rejects an unknown --kind instead of answering nothing", () => {
    const bad = cli("neighbors", "src/app.ts", "--kind", "import,bogus");
    expect(bad.status).toBe(2);
    expect(bad.err).toMatch(/--kind expects .*got "bogus"/);
    const ok = cli("neighbors", "src/app.ts", "--kind", "import,extends").json();
    expect(ok.links.every((l: { kind: string }) => l.kind === "import")).toBe(true);
  });
});

describe("MCP navigation errors and raw sites", () => {
  let client: any;
  beforeAll(async () => {
    const { startMcpClient } = await import(/* @vite-ignore */ new URL("../scripts/bench/mcp-client.mjs", import.meta.url).href);
    client = startMcpClient(process.execPath, [CLI, "mcp", "--repo", repo], { timeoutMs: 30_000 });
    expect((await client.handshake()).ok).toBe(true);
  });
  afterAll(async () => {
    await client?.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => (await client.request("tools/call", { name, arguments: args })).result;

  it("reports an unknown symbol as an error in every navigation tool", async () => {
    for (const [tool, args] of [
      ["callers", { name: "nope" }],
      ["type_hierarchy", { name: "nope" }],
      ["implementations", { name: "nope" }],
      ["call_graph", { symbol: "nope" }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.isError, tool).toBe(true);
      expect(res.content[0].text, tool).toMatch(/no (symbol|type) named/);
    }
    const miss = await call("callers", { name: "helper" });
    expect(miss.isError).not.toBe(true);
    expect(JSON.parse(miss.content[0].text).unresolvedSites).toBe(2);
  });

  it("lists one name's raw sites and resolves the first homonym's qualified ref", async () => {
    const raw = await call("callers", { name: "helper", raw: true });
    expect(JSON.parse(raw.content[0].text).sites).toHaveLength(2);
    expect((await call("callers", { raw: true })).isError).toBe(true);
    const typed = await call("type_hierarchy", { name: "Shape@src/shapes/a/shape.ts" });
    expect(JSON.parse(typed.content[0].text).file).toBe("src/shapes/a/shape.ts");
    const refs = await call("find_references", { name: "greet@src/other/greet2.ts" });
    expect(JSON.parse(refs.content[0].text).callSites).toEqual([{ file: "src/homonym.ts", line: 3 }]);
  });
});
