import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rewriteCommand, shellQuote, tokenize } from "../src/rewrite.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

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
  it("maps a recursive grep onto the indexed search", () => {
    expect(rewriteCommand("grep -r foo .")).toBe("codeindex grep foo");
  });

  it("treats a subdirectory argument as a scope, not a widened search", () => {
    expect(rewriteCommand("grep -r foo src")).toBe("codeindex grep foo --scope src");
    expect(rewriteCommand("grep -r foo src/")).toBe("codeindex grep foo --scope src");
  });

  it("expands bundled short flags", () => {
    expect(rewriteCommand("grep -rn foo .")).toBe("codeindex grep foo");
    expect(rewriteCommand("grep -rni foo .")).toBe("codeindex grep foo --ignore-case");
  });

  it("carries --ignore-case across", () => {
    expect(rewriteCommand("grep -r --ignore-case foo .")).toBe("codeindex grep foo --ignore-case");
  });

  it("treats rg as recursive by default", () => {
    expect(rewriteCommand("rg foo")).toBe("codeindex grep foo");
    expect(rewriteCommand("rg foo src")).toBe("codeindex grep foo --scope src");
  });

  it("carries include globs across in both spellings", () => {
    expect(rewriteCommand("grep -r --include=*.ts foo .")).toBe("codeindex grep foo --include '*.ts'");
    expect(rewriteCommand("rg -g *.ts foo")).toBe("codeindex grep foo --include '*.ts'");
  });

  it("honours -e for the pattern", () => {
    expect(rewriteCommand("grep -r -e foo .")).toBe("codeindex grep foo");
  });

  it("re-quotes a pattern containing spaces", () => {
    expect(rewriteCommand(`grep -r "two words" .`)).toBe("codeindex grep 'two words'");
  });

  it("drops purely presentational flags codeindex already satisfies", () => {
    expect(rewriteCommand("grep -r -n -H foo .")).toBe("codeindex grep foo");
  });

  it("respects a caller-supplied binary name", () => {
    expect(rewriteCommand("grep -r foo .", "/usr/local/bin/codeindex")).toBe("/usr/local/bin/codeindex grep foo");
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
    ["a brace group", "grep -r foo {a,b}"],
  ])("refuses %s", (_label, cmd) => {
    expect(rewriteCommand(cmd)).toBeUndefined();
  });

  it("refuses flags it cannot faithfully express", () => {
    expect(rewriteCommand("grep -r -A3 foo .")).toBeUndefined(); // context lines
    expect(rewriteCommand("grep -r -l foo .")).toBeUndefined(); // files-with-matches
    expect(rewriteCommand("grep -r -v foo .")).toBeUndefined(); // inverted match
    expect(rewriteCommand("grep -rc foo .")).toBeUndefined(); // count only
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
    expect(stdout.trim()).toBe("codeindex grep foo");
  });

  it("exits 1 with empty stdout when it does not", () => {
    const { status, stdout } = run(["git diff"]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
  });
});
