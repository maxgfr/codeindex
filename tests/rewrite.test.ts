import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hoistLeadingFlags } from "../src/engine-cli.js";
import { rewriteCommand, shellQuote, tokenize } from "../src/rewrite.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const haveTools = ["rg", "git", "grep"].every((t) => spawnSync(t, ["--version"]).status === 0);

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("grep -r foo src")).toEqual(["grep", "-r", "foo", "src"]);
  });

  it("keeps quoted spans whole", () => {
    expect(tokenize(`grep -r "two words" src`)).toEqual(["grep", "-r", "two words", "src"]);
    expect(tokenize(`grep -r 'two words' src`)).toEqual(["grep", "-r", "two words", "src"]);
  });

  it("preserves an intentionally empty argument", () => {
    expect(tokenize(`grep -r "" src`)).toEqual(["grep", "-r", "", "src"]);
  });

  it("refuses an unterminated quote rather than guessing", () => {
    expect(tokenize(`grep -r "unclosed`)).toBeUndefined();
  });
});

describe("shellQuote", () => {
  it("leaves shell-safe tokens bare", () => {
    expect(shellQuote("foo")).toBe("foo");
    expect(shellQuote("src/lib.ts")).toBe("src/lib.ts");
  });

  it("quotes tokens containing spaces", () => {
    expect(shellQuote("two words")).toBe("'two words'");
  });

  it("round-trips an embedded single quote", () => {
    // The '\'' idiom: close, escaped literal, reopen.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    // Round-trip through a real shell to prove the escaping is correct.
    const out = execFileSync("sh", ["-c", `printf %s ${shellQuote("it's")}`], { encoding: "utf8" });
    expect(out).toBe("it's");
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("rewriteCommand — rewrites it understands", () => {
  it("maps a recursive grep onto the indexed search over the same committed files", () => {
    // --ignore-dir .codeindex lifts the default vendor/build/out/tmp skips —
    // grep, rg and git grep make none of them.
    expect(rewriteCommand("grep -r foo .")).toBe("codeindex grep foo --ignore-dir .codeindex");
  });

  it("treats a subdirectory or file argument as a scope, normalising ./ and a trailing /", () => {
    expect(rewriteCommand("grep -r foo src")).toBe("codeindex grep foo --scope src --ignore-dir .codeindex");
    expect(rewriteCommand("grep -r foo ./src/")).toBe("codeindex grep foo --scope src --ignore-dir .codeindex");
    expect(rewriteCommand("grep -r foo gin.go")).toBe("codeindex grep foo --scope gin.go --ignore-dir .codeindex");
  });

  it("expands bundled short flags and carries --ignore-case across", () => {
    expect(rewriteCommand("grep -rni foo .")).toBe("codeindex grep foo --ignore-case --ignore-dir .codeindex");
    expect(rewriteCommand("grep -r --ignore-case foo .")).toBe("codeindex grep foo --ignore-case --ignore-dir .codeindex");
  });

  it("turns base-name globs into any-depth globs, in every spelling", () => {
    const want = "codeindex grep foo --include '**/*.ts' --ignore-dir .codeindex";
    expect(rewriteCommand("grep -r --include=*.ts foo .")).toBe(want);
    expect(rewriteCommand("grep -r --include '*.ts' foo .")).toBe(want);
    expect(rewriteCommand("rg -g '*.ts' foo")).toBe(want);
    expect(rewriteCommand("rg -g '!*_test.go' foo")).toBe("codeindex grep foo --exclude '**/*_test.go' --ignore-dir .codeindex");
    // A scope stays a separate, ANDed predicate.
    expect(rewriteCommand("grep -r --include=*.md foo binding")).toBe(
      "codeindex grep foo --scope binding --include '**/*.md' --ignore-dir .codeindex",
    );
  });

  it("restates the pattern dialect as JavaScript", () => {
    expect(rewriteCommand("grep -r 'x+y' .")).toBe("codeindex grep 'x\\+y' --ignore-dir .codeindex"); // BRE: + is literal
    expect(rewriteCommand("grep -r 'a\\+b' .")).toBe("codeindex grep 'a+b' --ignore-dir .codeindex"); // GNU BRE \+
    expect(rewriteCommand("grep -rE 'a+b' .")).toBe("codeindex grep 'a+b' --ignore-dir .codeindex");
    expect(rewriteCommand("grep -r '[[:digit:]]x' .")).toBe("codeindex grep '[0-9]x' --ignore-dir .codeindex");
    expect(rewriteCommand("rg -F 'a.b('")).toBe("codeindex grep 'a\\.b\\(' --ignore-dir .codeindex");
    expect(rewriteCommand("rg -w id")).toBe("codeindex grep '\\bid\\b' --ignore-dir .codeindex");
  });

  it("guards a pattern that starts with - behind --", () => {
    expect(rewriteCommand("grep -r -e --out src")).toBe("codeindex grep -- --out --scope src --ignore-dir .codeindex");
    expect(rewriteCommand("grep -r -- --foo .")).toBe("codeindex grep -- --foo --ignore-dir .codeindex");
  });

  it("re-quotes a pattern with the shell's own backslash and quote rules", () => {
    expect(rewriteCommand(`grep -r "two words" .`)).toBe("codeindex grep 'two words' --ignore-dir .codeindex");
    expect(rewriteCommand(`grep -r "say \\"hi\\"" .`)).toBe(`codeindex grep 'say "hi"' --ignore-dir .codeindex`);
    expect(rewriteCommand("grep -r a\\.b .")).toBe("codeindex grep a.b --ignore-dir .codeindex"); // the shell eats the \\
  });

  it("reads shell metacharacters only where the shell does", () => {
    expect(rewriteCommand(`rg 'foo|bar'`)).toBe("codeindex grep 'foo|bar' --ignore-dir .codeindex");
    expect(rewriteCommand(`rg "foo|bar"`)).toBe("codeindex grep 'foo|bar' --ignore-dir .codeindex");
  });

  it("covers the common agent forms: types, smart case, -l, git grep", () => {
    expect(rewriteCommand("rg -tpy 'def main'")).toBe("codeindex grep 'def main' --include '**/*.py' --include '**/*.pyi' --ignore-dir .codeindex");
    expect(rewriteCommand("rg -S foo")).toBe("codeindex grep foo --ignore-case --ignore-dir .codeindex");
    expect(rewriteCommand("rg -S Foo")).toBe("codeindex grep Foo --ignore-dir .codeindex");
    expect(rewriteCommand("rg -l foo")).toBe("codeindex grep foo --files-with-matches --ignore-dir .codeindex");
    expect(rewriteCommand("git grep -n foo -- '*.ts'")).toBe("codeindex grep foo --include '**/*.ts' --ignore-dir .codeindex");
  });

  it("drops purely presentational flags codeindex already satisfies", () => {
    expect(rewriteCommand("grep -r -n -H foo .")).toBe("codeindex grep foo --ignore-dir .codeindex");
    expect(rewriteCommand("rg --no-heading -n --color=never foo")).toBe("codeindex grep foo --ignore-dir .codeindex");
  });

  it("respects a caller-supplied binary name", () => {
    expect(rewriteCommand("grep -r foo .", "/usr/local/bin/codeindex")).toBe("/usr/local/bin/codeindex grep foo --ignore-dir .codeindex");
  });
});

describe("rewriteCommand — refusals (a bad rewrite is worse than none)", () => {
  it("refuses anything that is not a known search binary", () => {
    expect(rewriteCommand("git diff")).toBeUndefined();
    expect(rewriteCommand("cat file.ts")).toBeUndefined();
    expect(rewriteCommand("go test ./...")).toBeUndefined();
  });

  it("refuses a non-recursive grep (already cheap, different semantics)", () => {
    expect(rewriteCommand("grep foo file.ts")).toBeUndefined();
  });

  it.each([
    ["a pipeline", "grep -r foo . | head"],
    ["a redirect", "grep -r foo . > out.txt"],
    ["chaining", "grep -r foo . && echo done"],
    ["a sequence", "grep -r foo .; echo done"],
    ["command substitution", "grep -r $(cat pat) ."],
    ["a backtick", "grep -r `cat pat` ."],
    ["a variable", "grep -r $PATTERN ."],
    ["a variable in double quotes", `grep -r "$PATTERN" .`],
    ["a brace group", "grep -r foo {a,b}"],
    ["an unquoted glob the shell would expand", "rg foo src/*.ts"],
    ["an unquoted glob value", "rg -g *.ts foo"],
    ["a tilde", "grep -r foo ~/src"],
  ])("refuses %s", (_label, cmd) => {
    expect(rewriteCommand(cmd)).toBeUndefined();
  });

  it("refuses flags it cannot faithfully express", () => {
    expect(rewriteCommand("grep -r -A3 foo .")).toBeUndefined(); // context lines
    expect(rewriteCommand("grep -r -v foo .")).toBeUndefined(); // inverted match
    expect(rewriteCommand("grep -rc foo .")).toBeUndefined(); // count only
    expect(rewriteCommand("rg -r X ShouldBindJSON")).toBeUndefined(); // rg -r is --replace
    expect(rewriteCommand("rg -C2 foo")).toBeUndefined();
  });

  it("refuses a path outside the tree it would search", () => {
    expect(rewriteCommand("grep -r foo /etc")).toBeUndefined();
    expect(rewriteCommand("grep -r foo ../other")).toBeUndefined();
    expect(rewriteCommand("grep -r foo 'src/*.ts'")).toBeUndefined();
  });

  it("refuses rule orders where the later rule wins in grep/rg but exclusion wins here", () => {
    expect(rewriteCommand("rg -g '!*.d.ts' -g '*.ts' x")).toBeUndefined();
    expect(rewriteCommand("grep -r --exclude=*_test.go --include=*.go x .")).toBeUndefined();
    expect(rewriteCommand("grep -r --include=*.go --exclude=*_test.go x .")).toBeDefined();
  });

  it("refuses pattern syntax it cannot restate exactly", () => {
    expect(rewriteCommand("rg '(?i)foo'")).toBeUndefined(); // inline flags
    expect(rewriteCommand("rg '\\Afoo'")).toBeUndefined();
    expect(rewriteCommand("grep -r '[\\d]' .")).toBeDefined(); // POSIX: \\ and d, stated as such
    expect(rewriteCommand("grep -r '\\d' .")).toBeUndefined(); // version-dependent in GNU grep
    expect(rewriteCommand("rg '[a-z&&[^b]]'")).toBeUndefined();
  });

  it("refuses an env-prefixed or path-qualified invocation", () => {
    expect(rewriteCommand("LC_ALL=C grep -r foo .")).toBeUndefined();
    expect(rewriteCommand("/usr/bin/grep -r foo .")).toBeUndefined();
  });

  it("refuses more than one search path", () => {
    expect(rewriteCommand("grep -r foo src tests")).toBeUndefined();
  });

  it("refuses a missing or empty pattern", () => {
    expect(rewriteCommand("grep -r")).toBeUndefined();
    expect(rewriteCommand("")).toBeUndefined();
    expect(rewriteCommand("   ")).toBeUndefined();
  });
});

// The only real proof: run the original tool and the rewrite on one fixture
// and compare what they found. Paths under .git/ are dropped from grep's side
// (GNU grep -r searches VCS internals; the engine never does, on purpose).
describe.skipIf(!haveTools)("rewrite equivalence against the real tools", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-rewrite-eq-"));
  const put = (rel: string, body: string): void => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put("gin.go", 'func Default() {}\nfunc New() {}\nsay "hi"\nx+y\nxxy\na+b\naab\na.b\naxb\ncall a.b(1)\n');
  put("binding/binding.go", "func Default(method string) {}\nfunc TestNot() {}\n");
  put("binding/binding_test.go", "func TestBind(t *T) {}\n");
  put("binding/doc.md", "Default docs\n");
  put("README.md", "Default readme\nfoo bar\n");
  put("sub/app.py", "def main():\n    alpha = beta\n    Foo = foo\n");
  put("sub/types.pyi", "def main() -> None: ...\n");
  put("src/x.ts", "const id = 1; // id\nlet idx = 2;\nfunc run(x)\n");
  put("vendor/lib/v.go", "func TestVendor() {}\nTARGET\n");
  put("build/b.sh", "TARGET\n");
  put("flags.txt", "use --out file\nuse -x here\nmy-x\n");
  put("words.txt", "Ax1 bx2\nfoo\nbar\nfoobar\nabbc\n");
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });

  // stdin from /dev/null: given a piped stdin and no path, rg searches stdin.
  const sh = (line: string): string =>
    execFileSync("sh", ["-c", line], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // The original, with output-only flags the rewriter drops anyway, so every
  // tool prints path:line:text.
  function original(cmd: string, files: boolean): string[] {
    const [bin, ...rest] = cmd.split(" ");
    const extra = files ? "" : bin === "rg" ? " -n -H --no-heading" : bin === "git" ? "" : " -H -n";
    let out: string;
    try {
      out = sh(`${bin}${extra} ${rest.join(" ")}`);
    } catch (e) {
      out = (e as { stdout: string }).stdout; // exit 1: no match
    }
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => l.replace(/^\.\//, ""))
      .filter((l) => !l.startsWith(".git/"))
      .map((l) => (files ? l : l.split(":").slice(0, 2).join(":")))
      .sort();
  }
  function rewritten(cmd: string, files: boolean): string[] {
    const line = rewriteCommand(cmd, `'${process.execPath}' '${CLI}'`);
    expect(line, cmd).toBeDefined();
    const hits = JSON.parse(sh(line!)) as { file: string; line: number }[];
    return hits.map((h) => (files ? h.file : `${h.file}:${h.line}`)).sort();
  }

  it.each([
    `grep -rn --include=*.go "func Default" .`,
    `rg -g '!*_test.go' 'func Test'`,
    `grep -rn --include=*.md Default binding`,
    `grep -rn 'func Default' ./binding`,
    `grep -rn 'func Default' gin.go`,
    `grep -rn 'x+y' .`,
    `grep -r 'a\\+b' .`,
    `grep -r "say \\"hi\\"" .`,
    `grep -r a\\.b .`,
    `grep -r '[[:alpha:]]x[[:digit:]]' .`,
    `grep -r -e --out .`,
    `rg "foo|bar"`,
    `rg -tpy "def main"`,
    `rg -w id`,
    `rg -F 'a.b('`,
    `grep -rnw foo .`,
    `grep -rniE "foo|bar" .`,
    `git grep -n foo`,
    `git grep -n foo -- '*.py'`,
    `rg 'func \\w+\\(' --type go`,
    `rg -S Foo`,
    `rg -S foo`,
    `egrep -r 'ab{2,3}c' .`,
    `grep -r '^foo\\|bar$' .`,
    `grep -rw -- -x .`,
    `rg -e alpha -e beta`,
    `git grep -n -e alpha -e beta -- sub`,
    `rg TARGET`,
    `grep -r --exclude-dir=vendor TARGET .`,
  ])("%s", (cmd) => {
    const before = readdirSync(root).sort();
    const want = original(cmd, false);
    expect(want.length).toBeGreaterThan(0); // the fixture exercises every case
    expect(rewritten(cmd, false)).toEqual(want);
    expect(readdirSync(root).sort()).toEqual(before); // nothing written (the --out case)
  });

  it.each([`rg -l foo`, `grep -rl foo .`, `git grep -l foo`])("%s", (cmd) => {
    const want = original(cmd, true);
    expect(want.length).toBeGreaterThan(1);
    expect(rewritten(cmd, true)).toEqual(want);
  });
});

describe("rewrite CLI contract", () => {
  // The host reads stdout only when the exit code says to. Exit 1 must stay
  // silent so a caller that ignores the code cannot run an empty command.
  function run(args: string[]): { status: number; stdout: string } {
    try {
      const stdout = execFileSync(process.execPath, [CLI, "rewrite", ...args], { encoding: "utf8" });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { status: err.status, stdout: err.stdout };
    }
  }

  it("prints the replacement and exits 0 when it has an opinion", () => {
    const { status, stdout } = run(["grep -r foo ."]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("codeindex grep foo --ignore-dir .codeindex");
  });

  it("exits 1 with empty stdout when it does not", () => {
    const { status, stdout } = run(["git diff"]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
  });
});

describe("hoistLeadingFlags", () => {
  it("moves leading global flags after the subcommand", () => {
    expect(hoistLeadingFlags(["--repo", "/x", "scan"])).toEqual(["scan", "--repo", "/x"]);
  });

  it.each([
    ["--base", "HEAD", "changed"],
    ["--depth", "2", "impact"],
    ["--kind", "import", "context"],
    ["--rank", "lexical", "search"],
    ["--direction", "both", "callgraph"],
  ])("keeps %s with its value when placed before the command", (flag, value, command) => {
    expect(hoistLeadingFlags([flag, value, command, "target"])).toEqual([command, flag, value, "target"]);
  });

  it("handles the iterion inject_flag shape", () => {
    // `codeindex grep foo` + inject_flag "--max-hits 40" spliced after argv[0].
    expect(hoistLeadingFlags(["--max-hits", "40", "grep", "foo", "--scope", "src"])).toEqual([
      "grep",
      "--max-hits",
      "40",
      "foo",
      "--scope",
      "src",
    ]);
  });

  it("does not mistake a flag value for the command", () => {
    // `/x` is --repo's value, `scan` is the command — never the other way round.
    expect(hoistLeadingFlags(["--repo", "/x", "scan"])[0]).toBe("scan");
  });

  it("keeps boolean flags adjacent without eating the command", () => {
    expect(hoistLeadingFlags(["--semantic", "search", "q"])).toEqual(["search", "--semantic", "q"]);
  });

  it("leaves argv untouched when there is nothing to hoist", () => {
    for (const argv of [["scan", "--repo", "/x"], ["--help"], ["--version"], ["mcp", "--repo", "/x"], []]) {
      expect(hoistLeadingFlags(argv)).toEqual(argv);
    }
  });
});

describe("flag ordering is symmetric (CLI e2e)", () => {
  const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));
  it("`--repo X scan` equals `scan --repo X`", () => {
    const before = execFileSync(process.execPath, [CLI, "--repo", REPO, "scan"], { encoding: "utf8" });
    const after = execFileSync(process.execPath, [CLI, "scan", "--repo", REPO], { encoding: "utf8" });
    expect(before).toBe(after);
  });

  it("runs the exact command iterion's ultra mode produces", () => {
    const out = execFileSync(process.execPath, [CLI, "--max-hits", "40", "grep", "func", "--repo", REPO], {
      encoding: "utf8",
    });
    expect(Array.isArray(JSON.parse(out))).toBe(true);
  });
});
