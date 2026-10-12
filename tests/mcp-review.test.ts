import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcp } from "./oracles/real-world.js";
import { parseRules } from "../src/rules.js";
import { relFromUri } from "../src/lsp/protocol.js";
import { referencesWithLsp } from "../src/lsp/index.js";
import { findReferences } from "../src/query.js";
import { scanRepo } from "../src/scan.js";
import { trustRepoLspConfig } from "./lsp-trust.js";

// MCP and LSP robustness fixes of the 2026-10 review.

const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fixtures/lsp/fake-server.mjs", import.meta.url));

async function oneCall(args: string[], tool: string, toolArgs: Record<string, unknown>) {
  const mcp = startMcp(args);
  try {
    await mcp.init();
    return await mcp.call(tool, toolArgs);
  } finally {
    await mcp.close();
  }
}

describe("the response cap bounds what goes on the wire", () => {
  it("withholds a response whose text fits but whose wire form does not", { timeout: 60_000 }, async () => {
    const full = await oneCall(["--repo", REPO], "graph", {});
    const textBytes = Buffer.byteLength(full.text);
    // structuredContent repeats the graph and the text is JSON-escaped: the
    // wire form is far larger than the text.
    expect(full.wireBytes).toBeGreaterThan(textBytes * 1.5);
    const cap = Math.floor((textBytes + full.wireBytes) / 2);
    const capped = await oneCall(["--repo", REPO, "--max-response-bytes", String(cap)], "graph", {});
    expect(capped.isError).toBe(true);
    expect(JSON.parse(capped.text)).toMatchObject({ truncated: true, tool: "graph", maxBytes: cap });
    expect(capped.wireBytes).toBeLessThanOrEqual(cap);
  });

  it("quotes a repository path with a space in the command it suggests", { timeout: 60_000 }, async () => {
    const repo = join(mkdtempSync(join(tmpdir(), "ci-mcp cap-")), "my repo");
    cpSync(REPO, repo, { recursive: true });
    const capped = await oneCall(["--repo", repo, "--max-response-bytes", "200"], "graph", {});
    expect(JSON.parse(capped.text).artifactNote).toContain(`codeindex index --repo '${repo}' --out '${join(repo, ".codeindex")}'`);
  });
});

describe("limits are whole numbers of at least 1", () => {
  it.each([
    ["dead_code", { limit: 2.5 }, /`limit` must be a whole number, got 2.5/],
    ["dead_code", { limit: 0 }, /`limit` must be at least 1/],
    ["duplicated_literals", { limit: 0 }, /`limit` must be at least 1/],
    ["search", { query: "client", limit: 1.5 }, /`limit` must be a whole number/],
  ])("%s %j is refused", { timeout: 60_000 }, async (tool, args, message) => {
    const res = await oneCall(["--repo", REPO], tool, args);
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(message);
  });
});

describe("check_rules", () => {
  it("answers the CLI's shape", { timeout: 60_000 }, async () => {
    const res = await oneCall(["--repo", REPO], "check_rules", { rules: [{ name: "no-cycles", builtin: "cycles" }] });
    expect(Object.keys(JSON.parse(res.text))).toEqual(["errors", "warnings", "violations"]);
  });

  it("refuses an empty kind list, which used to mean every kind", () => {
    expect(() => parseRules([{ name: "r", from: "src/**", to: "docs/**", kind: [] }])).toThrow(/`kind` must be a non-empty array/);
  });

  it("the CLI finds --config under --repo when the working directory has none", () => {
    const repo = mkdtempSync(join(tmpdir(), "ci-rules-cfg-"));
    cpSync(REPO, repo, { recursive: true });
    writeFileSync(join(repo, "rules.json"), JSON.stringify([{ name: "no-cycles", builtin: "cycles" }]));
    const elsewhere = mkdtempSync(join(tmpdir(), "ci-rules-cwd-"));
    const r = spawnSync(process.execPath, [CLI, "rules", "--repo", repo, "--config", "rules.json"], { cwd: elsewhere, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ errors: 0 });
  });
});

describe("LSP answers under another spelling of the root", () => {
  trustRepoLspConfig();

  it("keeps the references a server reports under the repo's real path", { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-lsp-real-"));
    const real = join(dir, "repo");
    cpSync(REPO, real, { recursive: true });
    mkdirSync(join(real, ".codeindex"), { recursive: true });
    writeFileSync(
      join(real, ".codeindex", "lsp.json"),
      JSON.stringify({
        version: 1,
        servers: [{
          id: "fake",
          languages: ["typescript"],
          command: process.execPath,
          args: [FAKE],
          // The server answers with the REAL path, as tsserver and pyright do.
          env: { FAKE_LSP_ROOT: realpathSync(real), FAKE_LSP_REFS: JSON.stringify([{ file: "src/index.ts", line: 2 }]) },
          timeoutMs: 4000,
          startupTimeoutMs: 8000,
        }],
      }),
    );
    const link = join(dir, "link"); // --repo reached through a symlink
    symlinkSync(real, link);
    const scan = scanRepo(link);
    const res = await referencesWithLsp(scan, link, "HttpClient", findReferences(scan, "HttpClient"));
    expect(res.lsp?.refs.map((r) => r.file)).toContain("src/index.ts");
  });

  it("a URI under the root's real path is the repository's", () => {
    expect(relFromUri("/tmp/x", "file:///private/tmp/x/a.ts")).toBeUndefined();
    expect(relFromUri(["/tmp/x", "/private/tmp/x"], "file:///private/tmp/x/a.ts")).toBe("a.ts");
    expect(relFromUri(["/tmp/x", "/private/tmp/x"], "file:///tmp/x/b/c.ts")).toBe("b/c.ts");
    expect(relFromUri(["/tmp/x", "/private/tmp/x"], "file:///elsewhere/a.ts")).toBeUndefined();
  });
});
