import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Smoke test for the competitor benchmark harness (scripts/bench/). Runs against
// the committed mini-repo fixture — no clone, no network, no competitor required
// — proving the harness executes cold-index + render end to end and degrades to
// `n/a` cells when every competitor is absent (--no-competitors). Kept fast
// (< 10s) and hermetic; the real measurement session (with competitors) is a
// separate, opt-in run.
const BENCH = fileURLToPath(new URL("../scripts/bench/bench.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

function runBench(args: string[]): string {
  return execFileSync(process.execPath, [BENCH, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Split a markdown table row into trimmed cells: ["", "mini-repo", …, ""].
const cellsOf = (row: string): string[] => row.split("|").map((c) => c.trim());

describe("bench harness smoke", () => {
  it("renders a coherent markdown report for our tool alone", { timeout: 30_000 }, () => {
    const md = runBench(["--repo-dir", FIXTURE, "--runs", "1", "--scenario", "cold", "--no-competitors"]);

    // Expected structure: title, the cold-index section, and the out-of-scope
    // environment block.
    expect(md).toContain("# codeindex — competitor benchmarks");
    expect(md).toContain("## Cold index");
    expect(md).toContain("## Environment");
    expect(md).toContain("mini-repo");

    // Our own cold-index cell must be a real integer millisecond value.
    const row = md.split("\n").find((l) => l.includes("| mini-repo |"));
    expect(row, "cold-index row for mini-repo").toBeTruthy();
    const cells = row!.split("|").map((c) => c.trim());
    expect(cells[3], "codeindex (ms) cell").toMatch(/^\d+$/);
  });

  it("never crashes when a competitor is missing — absent tools become n/a cells", { timeout: 30_000 }, () => {
    const md = runBench(["--repo-dir", FIXTURE, "--runs", "1", "--scenario", "cold", "--no-competitors"]);
    // ctags/scip/01x columns are present but reported n/a, not omitted or fatal.
    expect(md).toMatch(/n\/a \(/);
  });

  it("drives our own MCP server end to end while absent competitors stay n/a", { timeout: 120_000 }, () => {
    const md = runBench(["--repo-dir", FIXTURE, "--runs", "1", "--scenario", "mcp-sessions,mcp-tokens", "--no-competitors"]);

    expect(md).toContain("## MCP sessions");
    expect(md).toContain("## MCP token economy");

    // Hermetic self-server: the codeindex rows carry real numbers (the bench
    // spawns our own `codeindex mcp` over stdio — no competitor involved).
    const sessions = md.split("## MCP sessions")[1]!.split("\n## ")[0];
    const selfRow = sessions.split("\n").find((l) => l.startsWith("| mini-repo | codeindex |"));
    expect(selfRow, "codeindex mcp-sessions row").toBeTruthy();
    const cells = selfRow!.split("|").map((c) => c.trim());
    // [ , Repo, Server, Symbol, activate->ready, find-symbol, references, file-overview, ]
    for (const i of [4, 5, 6, 7]) expect(cells[i], `sessions cell ${i}`).toMatch(/^\d+$/);

    // Every competitor row is present and degrades to n/a — never a crash.
    for (const server of ["serena", "graphify", "falcon"]) {
      const row = sessions.split("\n").find((l) => l.startsWith(`| mini-repo | ${server} |`));
      expect(row, `${server} mcp-sessions row`).toBeTruthy();
      expect(row).toContain("n/a (--no-competitors)");
    }

    const tokens = md.split("## MCP token economy")[1]!.split("\n## ")[0];
    const tokRow = tokens.split("\n").find((l) => l.startsWith("| mini-repo | codeindex |"));
    expect(tokRow, "codeindex mcp-tokens row").toBeTruthy();
    const tokCells = tokRow!.split("|").map((c) => c.trim());
    for (const i of [3, 4, 5]) expect(tokCells[i], `tokens cell ${i}`).toMatch(/^\d+$/);
    for (const server of ["serena", "graphify", "falcon"]) {
      expect(tokens).toContain(`| mini-repo | ${server} | n/a (--no-competitors)`);
    }
  });

  it("full hermetic run stays exit-0 with n/a cells for serena/graphify/falcon in every new column", { timeout: 180_000 }, () => {
    // The exact hermetic validation command: all six scenarios that carry the
    // serena/graphify/falcon columns, no competitor detection. execFileSync
    // throws on a non-zero exit, so reaching the assertions IS the exit-0 check.
    const md = runBench([
      "--repo-dir", FIXTURE, "--runs", "1",
      "--scenario", "cold,mcp-sessions,mcp-tokens,determinism,size,install",
      "--no-competitors",
    ]);
    const NA = "n/a (--no-competitors)";
    const section = (title: string) => md.split(`## ${title}`)[1]!.split("\n## ")[0];

    // Cold index: the three new columns are APPENDED at the end (frozen earlier
    // indices untouched) — headers then Repo|Files|codeindex|ctags|scip|01x|serena|graphify|falcon.
    const coldRow = section("Cold index").split("\n").find((l) => l.startsWith("| mini-repo |"));
    expect(coldRow, "cold row").toBeTruthy();
    const cold = cellsOf(coldRow!);
    expect(cold.length, "cold column count").toBe(11); // "" + 9 columns + ""
    expect(cold[3], "codeindex (ms)").toMatch(/^\d+$/);
    for (const i of [7, 8, 9]) expect(cold[i], `cold new-competitor cell ${i}`).toBe(NA);

    // Determinism: Repo | codeindex | 01x | serena | graphify | falcon.
    const detRow = section("Determinism").split("\n").find((l) => l.startsWith("| mini-repo |"));
    expect(detRow, "determinism row").toBeTruthy();
    const det = cellsOf(detRow!);
    expect(det[2], "codeindex byte-identical").toBe("yes");
    for (const i of [4, 5, 6]) expect(det[i], `determinism cell ${i}`).toBe(NA);

    // Index size: Repo | codeindex | 01x | ctags | serena | graphify | falcon.
    const sizeRow = section("Index size").split("\n").find((l) => l.startsWith("| mini-repo |"));
    expect(sizeRow, "size row").toBeTruthy();
    const size = cellsOf(sizeRow!);
    for (const i of [5, 6, 7]) expect(size[i], `size cell ${i}`).toBe(NA);

    // Install footprint: one row per tool, each new competitor degraded to n/a.
    const install = section("Install footprint");
    for (const tool of ["serena", "graphify", "falcon"]) {
      const row = install.split("\n").find((l) => l.startsWith(`| ${tool} |`));
      expect(row, `${tool} install row`).toBeTruthy();
      expect(cellsOf(row!)[2], `${tool} install cell`).toBe(NA);
    }

    // MCP scenarios rendered too (same run) — competitor rows all n/a.
    for (const server of ["serena", "graphify", "falcon"]) {
      expect(section("MCP sessions")).toContain(`| mini-repo | ${server} | `);
      expect(section("MCP token economy")).toContain(`| mini-repo | ${server} | ${NA}`);
    }
  });

  it("registers mcp-sessions and mcp-tokens in the scenario order", { timeout: 30_000 }, () => {
    // An unknown scenario makes bench print the full SCENARIO_ORDER and exit
    // non-zero — asserting on that message pins the registered scenario ids
    // end to end (parseable flag -> SCENARIOS map -> SCENARIO_ORDER).
    let stderr = "";
    try {
      runBench(["--repo-dir", FIXTURE, "--runs", "1", "--scenario", "no-such-scenario", "--no-competitors"]);
      expect.unreachable("unknown scenario must exit non-zero");
    } catch (e: any) {
      stderr = String(e?.stderr ?? "");
    }
    expect(stderr).toContain("unknown scenario: no-such-scenario");
    expect(stderr).toContain("mcp-sessions");
    expect(stderr).toContain("mcp-tokens");
  });
});
