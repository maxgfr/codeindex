import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "../src/scan.js";
import { codeOnly, complexityOfSource, riskHotspots, symbolComplexity } from "../src/complexity.js";

describe("complexity counts code, not prose", () => {
  it("comments and strings hold no branches", () => {
    expect(complexityOfSource("// This is used when the handler, if any, matches for each case")).toBe(1);
    expect(complexityOfSource('const msg = "if this, or for that, while the other";')).toBe(1);
    expect(complexityOfSource("/* if\n for */ if (a && b) {}")).toBe(3);
  });

  it("a Python docstring is prose, and `and`/`or` are branches", () => {
    const src = 'def f(a, b, c):\n    """Return when if for, for each case."""\n    # if for\n    return a and b or c\n';
    expect(complexityOfSource(src, "python")).toBe(3);
    // `//` is floor division in Python, not a comment.
    expect(complexityOfSource("x = a // b if c else d\n", "python")).toBe(2);
  });

  it("a keyword read as a member is not a branch", () => {
    expect(complexityOfSource("m = re.match(p, s)\n", "python")).toBe(1);
  });

  it("codeOnly keeps every line break and knows each family's literals", () => {
    const ts = "let s = `a ${x}\nb`; // if\nconst r = 'it\\'s'; /* x\ny */ if (a) {}";
    const out = codeOnly(ts, "typescript");
    expect(out.split("\n")).toHaveLength(ts.split("\n").length);
    expect(out).not.toMatch(/it|x\b|y\b|\/\//);
    expect(out).toMatch(/if \(a\)/);
    // A Rust lifetime is not a string opener; a char literal is blanked.
    const rs = codeOnly("fn f<'a>(x: &'a str) -> char { if x { 'c' } else { '\\n' } }", "rust");
    expect(rs).toContain("if x");
    expect(rs).toContain("else");
    expect(rs).not.toContain("'c'");
    // A Go raw string spans lines.
    expect(codeOnly("x := `raw\nif` + \"q\" // c", "go")).toBe(`x :=     \n    +${" ".repeat(9)}`);
  });
});

describe("symbolComplexity ranks functions", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-cx-"));
  writeFileSync(
    join(root, "app.py"),
    [
      "class App:",
      "    def run(self, a, b):",
      '        """Run when ready: if debug, for each host, while serving, case by case."""',
      "        if a:",
      "            return 1",
      "        for x in b:",
      "            pass",
      "        return 2",
      "",
      "    def send(self):",
      '        """If the file exists, for each range, when cached, if modified."""',
      "        return 3",
      "",
      "",
      "def outer(xs):",
      "    def inner(y):",
      "        if y and y > 1:",
      "            return y",
      "        return 0",
      "",
      "    return [inner(x) for x in xs]",
      "",
    ].join("\n"),
  );
  const scan = scanRepo(root);
  const ranked = symbolComplexity(scan);
  const score = (name: string): number | undefined => ranked.find((c) => c.name === name)?.complexity;

  it("scores only the code of each body", () => {
    expect(score("run")).toBe(3); // if + for
    expect(score("send")).toBe(1); // docstring only
  });

  it("leaves containers out of the ranking", () => {
    expect(score("App")).toBeUndefined();
  });

  it("a nested function scores on its own, not inside its parent", () => {
    expect(score("inner")).toBe(3); // if + and
    expect(score("outer")).toBe(2); // the comprehension's for
  });

  it("risk reads the same code-only counts", () => {
    const [risk] = riskHotspots(scan, new Map([["app.py", 1]]));
    // run: if, for · inner: if, and · outer: for — the docstrings add nothing.
    expect(risk).toMatchObject({ file: "app.py", complexity: 6, score: 12 });
  });
});
