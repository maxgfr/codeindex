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
});
