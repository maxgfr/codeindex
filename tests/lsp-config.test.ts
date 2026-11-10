import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMcpFlags } from "../src/engine-cli.js";
import { loadLspConfig, parseLspConfig, resolveLspConfigPath, startupTimeoutFor, timeoutFor, userLspConfigPath } from "../src/lsp/config.js";
import { callersWithLsp, lspStatus, referencesWithLsp } from "../src/lsp/index.js";
import { findReferences } from "../src/query.js";
import { scanRepo } from "../src/scan.js";

// A repository's own .codeindex/lsp.json names a command to spawn. Read without
// the reader's consent, a cloned repo could run anything on `refs --lsp` or an
// agent's find_references call — so it is read only when trusted.

const ENV_KEYS = ["CODEINDEX_LSP_CONFIG", "CODEINDEX_TRUST_LSP_CONFIG", "XDG_CONFIG_HOME"] as const;
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  // A per-test config home, so a developer's own ~/.config never leaks in.
  home = mkdtempSync(join(tmpdir(), "ci-lsp-home-"));
  process.env.XDG_CONFIG_HOME = home;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// A repo whose lsp.json would run `sh -c 'touch <marker>'` if it were spawned.
function hostileRepo(): { repo: string; marker: string; config: string } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ci-lsp-hostile-")));
  const marker = join(repo, "PWNED");
  mkdirSync(join(repo, ".codeindex"));
  const config = join(repo, ".codeindex", "lsp.json");
  writeFileSync(
    config,
    JSON.stringify({ version: 1, servers: [{ id: "x", languages: ["typescript"], command: "sh", args: ["-c", `touch ${marker}`] }] }),
  );
  writeFileSync(join(repo, "a.ts"), "export function target(): number { return 1; }\nexport const use = target();\n");
  return { repo, marker, config };
}

describe("a repository's lsp.json is read only when trusted", () => {
  it("is ignored, and named as ignored, by default", () => {
    const { repo, config } = hostileRepo();
    expect(resolveLspConfigPath(repo)).toEqual({ path: undefined, source: "none", ignored: config });
    expect(loadLspConfig(repo)).toBeUndefined();
  });

  it("is read with the trust option or CODEINDEX_TRUST_LSP_CONFIG=1", () => {
    const { repo, config } = hostileRepo();
    expect(resolveLspConfigPath(repo, { trustRepoConfig: true })).toEqual({ path: config, source: "repo" });
    process.env.CODEINDEX_TRUST_LSP_CONFIG = "1";
    expect(resolveLspConfigPath(repo)).toEqual({ path: config, source: "repo" });
  });

  it("falls back to the per-user config, still naming the ignored one", () => {
    const { repo, config } = hostileRepo();
    mkdirSync(join(home, "codeindex"));
    writeFileSync(userLspConfigPath(), JSON.stringify({ version: 1, servers: [] }));
    expect(userLspConfigPath()).toBe(join(home, "codeindex", "lsp.json"));
    expect(resolveLspConfigPath(repo)).toEqual({ path: userLspConfigPath(), source: "user", ignored: config });
  });

  it("CODEINDEX_LSP_CONFIG still wins, and off still disables", () => {
    const { repo } = hostileRepo();
    const own = join(home, "mine.json");
    process.env.CODEINDEX_LSP_CONFIG = own;
    expect(resolveLspConfigPath(repo)).toEqual({ path: own, source: "env" });
    process.env.CODEINDEX_LSP_CONFIG = "off";
    expect(resolveLspConfigPath(repo, { trustRepoConfig: true })).toEqual({ path: undefined, source: "none" });
  });

  it("refs --lsp, callers --lsp and lsp status never spawn an untrusted command", async () => {
    const { repo, marker, config } = hostileRepo();
    const scan = scanRepo(repo);
    const refs = await referencesWithLsp(scan, repo, "target", findReferences(scan, "target"));
    expect(refs.lsp?.ok).toBe(false);
    expect(refs.lsp?.reason).toContain(`${config} ignored`);
    const callers = await callersWithLsp(scan, repo, "target", { callers: [] });
    expect(callers.lsp?.reason).toContain(`${config} ignored`);
    const status = await lspStatus(scan, repo, true);
    expect(status.mode).toBe("none");
    expect(status.ignoredConfig?.path).toBe(config);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("--trust-lsp-config on the CLI and the MCP server", () => {
  const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
  const status = (repo: string, ...flags: string[]) =>
    JSON.parse(execFileSync(process.execPath, [CLI, "lsp", "status", "--repo", repo, ...flags], { encoding: "utf8" })) as {
      source: string;
      ignoredConfig?: { path: string };
    };

  it("lsp status names the ignored config, and reads it once trusted", () => {
    const { repo, config } = hostileRepo();
    expect(status(repo)).toMatchObject({ source: "none", ignoredConfig: { path: config } });
    expect(status(repo, "--trust-lsp-config")).toMatchObject({ source: "repo" });
  });

  // One MCP session over stdio: `lsp_status` for each repo named, then stdin ends.
  const mcpStatuses = (flags: string[], repos: (string | undefined)[]) => {
    const messages = [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } },
      ...repos.map((repo, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: { name: "lsp_status", arguments: { probe: true, ...(repo ? { repo } : {}) } },
      })),
    ];
    const run = spawnSync(process.execPath, [CLI, "mcp", ...flags], {
      encoding: "utf8",
      input: messages.map((m) => JSON.stringify(m)).join("\n") + "\n",
      // Nothing to trust in the working directory either.
      cwd: home,
    });
    const replies = new Map<number, { result: { content: { text: string }[] } }>();
    for (const line of run.stdout.split("\n")) if (line.trim()) replies.set(JSON.parse(line).id, JSON.parse(line));
    return repos.map((_, i) => JSON.parse(replies.get(i + 1)!.result.content[0]!.text) as { source: string; ignoredConfig?: { path: string } });
  };

  it("on a pinned mcp server, the flag trusts the pinned repository only", () => {
    const pinned = hostileRepo();
    const other = hostileRepo();
    const [own, named] = mcpStatuses(["--repo", pinned.repo, "--trust-lsp-config"], [undefined, other.repo]);
    expect(own).toMatchObject({ source: "repo" });
    // The repository a call names was not the one the operator trusted: its
    // config is reported as ignored, and its command never ran.
    expect(named).toMatchObject({ source: "none", ignoredConfig: { path: other.config } });
    expect(existsSync(other.marker)).toBe(false);
  });

  it("an unpinned mcp server has no repository to mean: the flag covers each call", () => {
    const { repo } = hostileRepo();
    expect(mcpStatuses(["--trust-lsp-config"], [repo])[0]).toMatchObject({ source: "repo" });
    expect(mcpStatuses([], [repo])[0]).toMatchObject({ source: "none" });
  });

  it("codeindex mcp accepts --trust-lsp-config", () => {
    expect(parseMcpFlags(["--trust-lsp-config"])).toMatchObject({ trustLspConfig: true });
    expect(parseMcpFlags([]).trustLspConfig).toBeUndefined();
  });
});

describe("lsp.json budgets", () => {
  const server = (extra: Record<string, unknown>) => ({ version: 1, servers: [{ id: "s", languages: ["go"], command: "gopls", ...extra }] });

  it.each([0, -1, Number.NaN, "5000"])("rejects timeoutMs %s", (value) => {
    expect(() => parseLspConfig(server({ timeoutMs: value }))).toThrow(/timeoutMs must be a positive number/);
    expect(() => parseLspConfig(server({ startupTimeoutMs: value }))).toThrow(/startupTimeoutMs must be a positive number/);
  });

  it("caps a budget at the longest delay a timer takes", () => {
    const one = parseLspConfig(server({ timeoutMs: 1e10, startupTimeoutMs: 1e10 })).servers[0]!;
    expect(timeoutFor(one)).toBe(2_147_483_647);
    expect(startupTimeoutFor(one)).toBe(2_147_483_647);
    process.env.CODEINDEX_LSP_TIMEOUT_MS = "10000000000";
    process.env.CODEINDEX_LSP_STARTUP_TIMEOUT_MS = "10000000000";
    try {
      const plain = parseLspConfig(server({})).servers[0]!;
      expect(timeoutFor(plain)).toBe(2_147_483_647);
      expect(startupTimeoutFor(plain)).toBe(2_147_483_647);
    } finally {
      delete process.env.CODEINDEX_LSP_TIMEOUT_MS;
      delete process.env.CODEINDEX_LSP_STARTUP_TIMEOUT_MS;
    }
  });

  it("keeps a positive budget", () => {
    expect(parseLspConfig(server({ timeoutMs: 250, startupTimeoutMs: 900 })).servers[0]).toMatchObject({ timeoutMs: 250, startupTimeoutMs: 900 });
  });
});
