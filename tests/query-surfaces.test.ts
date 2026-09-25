import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, type RepoScan } from "../src/scan.js";
import { findReferences, findSymbol, symbolAt, symbolsOverview } from "../src/query.js";

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
});
