import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, type RepoScan } from "../src/scan.js";
import { findReferences, findSymbol, symbolAt, symbolsOverview } from "../src/query.js";
import { shortestPaths } from "../src/paths.js";
import { callPath } from "../src/symbolgraph.js";
import { symbolGraphFor } from "../src/derived.js";

// The navigation queries each surface used to have only on one side: the CLI
// had no find / refs / outline (MCP-only), and MCP had no impact / neighbors
// (CLI-only). Neither answered "which symbol is at file:line" or "how does A
// reach B". These pin the new thin wrappers to the library answers they wrap.

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

const FILES: Record<string, string> = {
  "src/util.ts": [
    "/** Exponential backoff, capped. */",
    "export function backoff(attempt: number): number {",
    "  return Math.min(1000, 2 ** attempt);",
    "}",
    "",
  ].join("\n"),
  "src/client.ts": [
    'import { backoff } from "./util.js";',
    "export class Client {",
    "  send(): number {",
    "    return this.retry();",
    "  }",
    "  retry(): number {",
    "    return backoff(2);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/app.ts": [
    'import { Client } from "./client.js";',
    "export function main(): number {",
    "  const c = new Client();",
    "  return c.send();",
    "}",
    "",
  ].join("\n"),
  "src/empty.ts": "// nothing declared here\n",
  // Two equally short routes from top to bottom.
  "src/diamond.ts": [
    "export function top(): number {",
    "  return right() + left();",
    "}",
    "export function left(): number {",
    "  return bottom();",
    "}",
    "export function right(): number {",
    "  return bottom();",
    "}",
    "export function bottom(): number {",
    "  return 1;",
    "}",
    "",
  ].join("\n"),
  // total() calls Shape.area; only dispatch reaches the overrides, and only
  // Cube's calls side_len.
  "shapes/base.py": "class Shape:\n    def area(self):\n        raise NotImplementedError\n",
  "shapes/square.py": "from shapes.base import Shape\n\n\nclass Square(Shape):\n    def area(self):\n        return 1\n",
  "shapes/cube.py":
    "from shapes.square import Square\n\n\ndef side_len():\n    return 1\n\n\nclass Cube(Square):\n    def area(self):\n        return side_len() * 6\n",
  "shapes/total.py": "from shapes.base import Shape\n\n\ndef total(x: Shape):\n    return x.area()\n",
  // A Go import lands on one file of the package; it reaches all of them.
  "go.mod": "module example.com/m\n\ngo 1.21\n",
  "lib/a.go": "package lib\n\nfunc A() int { return 1 }\n",
  "lib/b.go": "package lib\n\nfunc B() int { return 2 }\n",
  "cmd/main.go": 'package main\n\nimport "example.com/m/lib"\n\nfunc main() { lib.B() }\n',
  "src/nested.ts": [
    "export class Outer {",
    "  run(): number {",
    "    const inner = () => {",
    "      return 1;",
    "    };",
    "    return inner();",
    "  }",
    "}",
    "",
  ].join("\n"),
};

let repo: string;
let scan: RepoScan;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ci-query-surfaces-"));
  for (const [rel, content] of Object.entries(FILES)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  scan = scanRepo(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const cli = (...args: string[]) => {
  const res = spawnSync(process.execPath, [CLI, ...args, "--repo", repo, "--no-index-cache"], { encoding: "utf8" });
  return { status: res.status, out: res.stdout, err: res.stderr, json: () => JSON.parse(res.stdout) };
};

describe("CLI find / refs / outline", () => {
  it("find answers what MCP find_symbol answers, signature and doc included", () => {
    const hit = cli("find", "Client/retry").json();
    expect(hit).toEqual(JSON.parse(JSON.stringify(findSymbol(scan, "Client/retry"))));
    expect(hit).toMatchObject([{ name: "retry", parent: "Client", file: "src/client.ts", line: 6, endLine: 8, signature: "retry(): number" }]);
    expect(cli("find", "backoff").json()[0].doc).toMatch(/Exponential backoff/);
    expect(cli("find", "RETR", "--substring", "--concise").json()).toEqual([{ name: "retry", kind: "method", file: "src/client.ts", line: 6 }]);
    expect(cli("find", "backoff", "--include-body").json()[0].body).toContain("Math.min(1000");
    expect(cli("find", "e", "--substring", "--limit", "1").json()).toHaveLength(1);
    const none = cli("find", "nothingLikeThis");
    expect(none.status).toBe(0);
    expect(none.json()).toEqual([]);
  });

  it("refs answers what MCP find_references answers", () => {
    const refs = cli("refs", "backoff").json();
    expect(refs).toEqual(JSON.parse(JSON.stringify(findReferences(scan, "backoff"))));
    expect(refs.callSites).toEqual([{ file: "src/client.ts", line: 7 }]);
    expect(cli("refs", "backoff@src/util.ts", "--concise").json().defs).toEqual([
      { name: "backoff", kind: "function", file: "src/util.ts", line: 2 },
    ]);
    // An out-of-repo or unknown name is still an answer, not an error.
    const unknown = cli("refs", "nothingLikeThis");
    expect(unknown.status).toBe(0);
    expect(unknown.json().defs).toEqual([]);
  });

  it("outline lists one file's symbols, reads any path spelling, and rejects an unknown file", () => {
    const want = JSON.parse(JSON.stringify(symbolsOverview(scan, "src/client.ts")));
    expect(want.map((s: { name: string }) => s.name)).toEqual(["Client", "send", "retry"]);
    for (const spelling of ["src/client.ts", "./src/client.ts", join(repo, "src/client.ts"), "src\\client.ts"]) {
      expect(cli("outline", spelling).json(), spelling).toEqual(want);
    }
    expect(cli("outline", "src/empty.ts").json()).toEqual([]);
    const missing = cli("outline", "nope.ts");
    expect(missing.status).toBe(2);
    expect(missing.err).toMatch(/no such file in the index: nope\.ts/);
  });

  it("refuses a missing argument, a stray second one, and --lsp outside refs", () => {
    expect(cli("find").err).toMatch(/find needs an argument/);
    expect(cli("outline", "src/a.ts", "src/b.ts").err).toMatch(/unknown flag: src\/b\.ts/);
    expect(cli("find", "backoff", "--lsp").status).toBe(2);
  });

  it("reads through the persisted index", () => {
    // Tamper with a record in cache.json and leave the file untouched: the
    // stat-fresh index is what answers, so the tampered signature shows up.
    const copy = mkdtempSync(join(tmpdir(), "ci-query-surfaces-index-"));
    try {
      for (const [rel, content] of Object.entries(FILES)) {
        mkdirSync(join(copy, rel, ".."), { recursive: true });
        writeFileSync(join(copy, rel), content);
      }
      const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, "--repo", copy], { encoding: "utf8" });
      expect(run("index", "--out", join(copy, ".codeindex")).status).toBe(0);
      const cachePath = join(copy, ".codeindex", "cache.json");
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      for (const s of cache.files["src/client.ts"].record.symbols) if (s.name === "retry") s.signature = "retry(): FROM_INDEX";
      writeFileSync(cachePath, JSON.stringify(cache));
      expect(JSON.parse(run("find", "retry").stdout)[0].signature).toBe("retry(): FROM_INDEX");
      expect(JSON.parse(run("outline", "src/client.ts").stdout)[2].signature).toBe("retry(): FROM_INDEX");
      expect(JSON.parse(run("find", "retry", "--no-index-cache").stdout)[0].signature).toBe("retry(): number");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe("symbol at file:line", () => {
  it("answers the innermost declaration, its id and the chain around it", () => {
    const at = symbolAt(scan, "src/nested.ts", 4)!;
    expect(at.symbol).toMatchObject({ name: "inner", line: 3, endLine: 5, id: "src/nested.ts#run/inner" });
    expect(at.enclosing).toEqual(["src/nested.ts#Outer", "src/nested.ts#Outer/run"]);
    expect(at.approximate).toBeUndefined();
    // A line of the method outside the closure is the method's.
    expect(symbolAt(scan, "src/nested.ts", 6)!.symbol!.id).toBe("src/nested.ts#Outer/run");
    // Outside every declaration: null, not an error; no such file: undefined.
    expect(symbolAt(scan, "src/client.ts", 1)).toEqual({ file: "src/client.ts", line: 1, symbol: null, enclosing: [] });
    expect(symbolAt(scan, "nope.ts", 1)).toBeUndefined();
  });

  it("CLI symbol-at reads file:line and file:line:col, in any path spelling", () => {
    const want = JSON.parse(JSON.stringify(symbolAt(scan, "src/client.ts", 7)));
    expect(want.symbol.id).toBe("src/client.ts#Client/retry");
    for (const arg of ["src/client.ts:7", "./src/client.ts:7:12", `${join(repo, "src/client.ts")}:7`]) {
      expect(cli("symbol-at", arg).json(), arg).toEqual(want);
    }
    // The id pastes straight into the symbol-ref commands.
    expect(cli("callgraph", want.symbol.id, "--depth", "1").json().root[0].id).toBe(want.symbol.id);
    expect(cli("symbol-at", "src/client.ts").status).toBe(2);
    expect(cli("symbol-at", "src/client.ts:0").status).toBe(2);
    expect(cli("symbol-at", "nope.ts:3").err).toMatch(/no such file in the index: nope\.ts/);
  });

  it("says when the answer is only the nearest declaration above (regex tier)", () => {
    const at = cli("symbol-at", "src/nested.ts:4", "--no-ast").json();
    expect(at.symbol.name).toBe("inner");
    expect(at.approximate).toBe(true);
  });
});

describe("callers --with-caller", () => {
  it("names the declaration each site sits in, by the id callgraph uses", () => {
    const plain = cli("callers", "retry").json();
    expect(plain.callers).toEqual([{ file: "src/client.ts", line: 4 }]);
    const sited = cli("callers", "retry", "--with-caller").json();
    expect(sited).toEqual({ ...plain, callers: [{ file: "src/client.ts", line: 4, caller: "src/client.ts#Client/send" }] });
    const edges = cli("callgraph", "Client/retry", "--direction", "in", "--depth", "1").json().edges;
    expect(edges).toContainEqual(expect.objectContaining({ from: "src/client.ts#Client/send", to: "src/client.ts#Client/retry", kind: "calls" }));
    // The whole index takes it too; without it no site carries the field.
    expect(cli("callers", "--with-caller").json().backoff.callers).toEqual([{ file: "src/client.ts", line: 7, caller: "src/client.ts#Client/retry" }]);
    expect(JSON.stringify(cli("callers").json())).not.toContain('"caller"');
    expect(cli("callers", "retry", "--raw", "--with-caller").status).toBe(2);
  });
});

describe("shortest paths", () => {
  // a → b → d, a → c → d, a → d2 → e → d: two shortest paths of two hops.
  const EDGES: Record<string, string[]> = { a: ["c", "b", "d2"], b: ["d"], c: ["d"], d2: ["e"], e: ["d"] };
  const next = (reverse: boolean) => (n: string) => (reverse ? [...(EDGES[n] ?? [])].reverse() : EDGES[n] ?? []).map((m) => [m, "calls"] as const);

  it("lists every shortest path in id order, whatever order successors come in", () => {
    for (const reverse of [false, true]) {
      const r = shortestPaths(["a"], new Set(["d"]), next(reverse), 5, 10);
      expect(r.hops).toBe(2);
      expect(r.pathCount).toBe(2);
      expect(r.paths.map((p) => p.map((h) => h.node).join(">"))).toEqual(["a>b>d", "a>c>d"]);
      expect(r.paths[0]![1]).toEqual({ node: "b", via: "calls" });
    }
  });

  it("counts the paths it does not list, stops at the hop limit, and answers 0 hops for a shared node", () => {
    const one = shortestPaths(["a"], new Set(["d"]), next(false), 5, 1);
    expect(one.paths).toHaveLength(1);
    expect(one.pathCount).toBe(2);
    expect(shortestPaths(["a"], new Set(["d"]), next(false), 1, 5)).toEqual({ hops: null, paths: [], pathCount: 0 });
    expect(shortestPaths(["a", "d"], new Set(["d"]), next(false), 5, 5)).toEqual({ hops: 0, paths: [[{ node: "d" }]], pathCount: 1 });
  });
});

describe("callpath", () => {
  it("answers the shortest call chains, ties in id order, with the count", () => {
    const r = callPath(symbolGraphFor(scan), "top", "bottom");
    expect(r.hops).toBe(2);
    expect(r.pathCount).toBe(2);
    expect(r.paths.map((p) => p.map((s) => s.name))).toEqual([["top", "left", "bottom"], ["top", "right", "bottom"]]);
    const cut = cli("callpath", "top", "bottom", "--limit", "1").json();
    expect(cut).toMatchObject({ hops: 2, pathCount: 2, truncated: true });
    expect(cut.paths).toEqual([JSON.parse(JSON.stringify(r.paths[0]))]);
  });

  it("follows dispatch to an override, and says when the question is backwards", () => {
    const r = cli("callpath", "total", "side_len").json();
    expect(r.hops).toBe(4);
    expect(r.paths[0].map((s: { id: string; via?: string }) => `${s.via ?? "start"} ${s.id}`)).toEqual([
      "start shapes/total.py#total",
      "calls shapes/base.py#Shape/area",
      "dispatch shapes/square.py#Square/area",
      "dispatch shapes/cube.py#Cube/area",
      "calls shapes/cube.py#side_len",
    ]);
    const back = cli("callpath", "bottom", "top").json();
    expect(back).toMatchObject({ hops: null, paths: [], pathCount: 0, reverseHops: 2 });
    expect(cli("callpath", "top", "bottom", "--depth", "1").json()).toMatchObject({ hops: null, pathCount: 0 });
    expect(cli("callpath", "top", "bottom", "--depth", "40").json().depthClamped).toBe(16);
  });

  it("walks the file graph with --files: why does A depend on B", () => {
    const r = cli("callpath", "src/app.ts", "./src/util.ts", "--files").json();
    expect(r).toMatchObject({ from: "src/app.ts", to: "src/util.ts", hops: 2, pathCount: 1 });
    expect(r.paths[0]).toEqual([{ file: "src/app.ts" }, { file: "src/client.ts", via: "import" }, { file: "src/util.ts", via: "import" }]);
    expect(cli("callpath", "src/util.ts", "src/app.ts", "--files").json()).toMatchObject({ hops: null, reverseHops: 2 });
    // The import resolves to one file of package lib; both files are one step away.
    for (const target of ["lib/a.go", "lib/b.go"]) {
      expect(cli("callpath", "cmd/main.go", target, "--files").json().paths[0][1], target).toEqual({ file: target, via: "import" });
    }
  });

  it("rejects an unknown symbol or file, a missing argument, and --include-inferred without --files", () => {
    expect(cli("callpath", "top", "nope").err).toMatch(/no symbol named nope/);
    expect(cli("callpath", "nope", "top").status).toBe(2);
    expect(cli("callpath", "top").err).toMatch(/callpath needs two arguments/);
    expect(cli("callpath", "src/app.ts", "nope.ts", "--files").err).toMatch(/no such file in the index: nope\.ts/);
    expect(cli("callpath", "top", "bottom", "--include-inferred").status).toBe(2);
  });
});

describe("MCP query surfaces", () => {
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
  const answer = async (name: string, args: Record<string, unknown>) => {
    const res = await call(name, args);
    expect(res.isError, `${name}: ${res.content?.[0]?.text}`).not.toBe(true);
    return JSON.parse(res.content[0].text);
  };

  it("symbol_at answers what the CLI answers, and errors on a bad file or line", async () => {
    expect(await answer("symbol_at", { file: "./src/nested.ts", line: 4 })).toEqual(cli("symbol-at", "src/nested.ts:4").json());
    expect(await answer("symbol_at", { file: "src/client.ts", line: "7" })).toMatchObject({ symbol: { id: "src/client.ts#Client/retry" } });
    for (const args of [{ file: "nope.ts", line: 1 }, { file: "src/client.ts", line: 1.5 }, { file: "src/client.ts" }]) {
      expect((await call("symbol_at", args)).isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("impact and neighbors answer what the CLI answers, from any path spelling", async () => {
    const impact = await answer("impact", { target: "./src/util.ts" });
    expect(impact).toEqual(cli("impact", "src/util.ts").json());
    expect(impact.files.map((f: { rel: string }) => f.rel)).toEqual(["src/client.ts", "src/app.ts"]);
    expect((await answer("impact", { target: "src/util.ts", depth: 1 })).files.map((f: { rel: string }) => f.rel)).toEqual(["src/client.ts"]);
    const neighbors = await answer("neighbors", { target: join(repo, "src/client.ts"), kinds: ["import"] });
    expect(neighbors).toEqual(cli("neighbors", "src/client.ts", "--kind", "import").json());
    expect(neighbors.links.map((l: { node: string; direction: string }) => `${l.direction}:${l.node}`)).toEqual(["out:src/util.ts", "in:src/app.ts"]);
    expect(await answer("neighbors", { target: "src/client.ts", depth: 2 })).toEqual(cli("neighbors", "src/client.ts", "--depth", "2").json());
  });

  it("callers withCaller answers what the CLI answers, concise included", async () => {
    expect(await answer("callers", { name: "retry", withCaller: true })).toEqual(cli("callers", "retry", "--with-caller").json());
    expect((await answer("callers", { name: "retry", withCaller: true, concise: true })).callers).toEqual([
      { file: "src/client.ts", line: 4, caller: "src/client.ts#Client/send" },
    ]);
    expect((await call("callers", { name: "retry", raw: true, withCaller: true })).isError).toBe(true);
  });

  it("call_path answers what the CLI answers, symbols and files", async () => {
    expect(await answer("call_path", { from: "total", to: "side_len" })).toEqual(cli("callpath", "total", "side_len").json());
    expect(await answer("call_path", { from: "top", to: "bottom", maxPaths: 1 })).toEqual(cli("callpath", "top", "bottom", "--limit", "1").json());
    expect(await answer("call_path", { from: "src/app.ts", to: "src/util.ts", files: true })).toEqual(
      cli("callpath", "src/app.ts", "src/util.ts", "--files").json(),
    );
    for (const args of [{ from: "top", to: "nope" }, { from: "top" }, { from: "src/app.ts", to: "nope.ts", files: true }, { from: "top", to: "bottom", includeInferred: true }]) {
      expect((await call("call_path", args)).isError, JSON.stringify(args)).toBe(true);
    }
  });

  it("impact and neighbors reject an unknown target or edge kind", async () => {
    for (const [tool, args] of [
      ["impact", { target: "nope.ts" }],
      ["neighbors", { target: "nope.ts" }],
      ["neighbors", { target: "src/client.ts", kinds: ["import", "bogus"] }],
      ["neighbors", { target: "src/client.ts", kinds: [] }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
    expect((await call("neighbors", { target: "src/client.ts", kinds: ["bogus"] })).content[0].text).toMatch(/bogus/);
  });
});
