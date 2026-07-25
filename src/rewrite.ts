// Command rewriting: map an expensive full-tree text search onto the engine's
// indexed equivalent, so an agent shell that runs `grep -r foo .` gets bounded,
// structured, gitignore-correct hits instead of an unbounded wall of text.
//
// The contract is a HOST contract, not a shell one: the caller hands us a full
// command line and takes our stdout as the command to run instead (iterion's
// `rewriters` plugin kind, rtk's generalization). That makes a wrong rewrite
// far worse than no rewrite — it silently changes what the agent asked for.
// So this module is deliberately, aggressively conservative:
//
//   * anything the parser cannot prove it understands → NO rewrite
//   * any shell metacharacter at all → NO rewrite (we refuse to reason about
//     pipelines, redirection, substitution or chaining)
//   * any flag not on the explicit allowlist → NO rewrite
//
// A refusal is cheap (the original command runs untouched); a bad rewrite is
// not. Every branch here defaults to refusing.

// Shell constructs we will not reason about. Their presence anywhere in the
// line — quoted or not — refuses the rewrite. Over-refusing is the point: a
// pattern containing a literal `|` is rare, mis-rewriting a pipeline is fatal.
const SHELL_METACHARS = /[|&;<>`\n\r$(){}]/;

// `grep` output is line-oriented text; `codeindex grep` returns JSON hits. That
// is the intended trade (bounded + structured), but it means we only rewrite
// invocations whose INTENT is "search the tree", never "search this one file"
// (cheap already) and never anything whose flags shape the output format.
const GREP_BINARIES = new Set(["grep", "egrep", "rg", "ripgrep"]);

interface Parsed {
  pattern?: string;
  path?: string;
  ignoreCase: boolean;
  includes: string[];
  recursive: boolean;
}

// Split on whitespace honouring single/double quotes. Returns undefined on an
// unterminated quote — an unparseable line is a refusal, not a guess.
export function tokenize(line: string): string[] | undefined {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
  }
  if (quote) return undefined; // unterminated quote
  if (started || cur) out.push(cur);
  return out;
}

// Wrap a token so the shell reproduces it verbatim. Single-quoting is total
// (no escapes are interpreted inside), so the only case needing care is a
// literal single quote, spliced via the standard '\'' idiom.
export function shellQuote(s: string): string {
  if (s !== "" && !/[^A-Za-z0-9_\-./=@:]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// Parse a grep/rg invocation into the fields we can faithfully re-express.
// Returns undefined the moment anything is unrecognized.
function parseSearch(bin: string, args: string[]): Parsed | undefined {
  const p: Parsed = { ignoreCase: false, includes: [], recursive: bin !== "grep" && bin !== "egrep" };
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--") {
      // Everything after `--` is positional by definition.
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    if (a === "-i" || a === "--ignore-case") {
      p.ignoreCase = true;
    } else if (a === "-r" || a === "-R" || a === "--recursive") {
      p.recursive = true;
    } else if (a === "-n" || a === "--line-number" || a === "-H" || a === "--with-filename" || a === "--no-heading") {
      // Pure output-shaping flags whose effect codeindex already provides
      // unconditionally (every hit carries file + line). Safe to drop.
    } else if (a === "-e" || a === "--regexp") {
      const v = args[++i];
      if (v === undefined || p.pattern !== undefined) return undefined;
      p.pattern = v;
    } else if (a.startsWith("--include=")) {
      p.includes.push(a.slice("--include=".length));
    } else if (a === "--include" || a === "-g" || a === "--glob") {
      const v = args[++i];
      if (v === undefined) return undefined;
      p.includes.push(v);
    } else if (a.length > 2 && /^-[a-zA-Z]+$/.test(a)) {
      // A bundled short-flag cluster (-rn, -ri, -rni…). Expand and re-check;
      // any member outside the allowlist refuses the whole line.
      const expanded = a.slice(1).split("").map((c) => `-${c}`);
      args.splice(i, 1, ...expanded);
      i--;
    } else {
      return undefined; // unknown flag → refuse
    }
  }

  // With an -e pattern already bound, every positional is a path; otherwise the
  // first positional is the pattern. Either way at most ONE path may remain —
  // multi-path search has no single-scope equivalent, so it refuses.
  if (p.pattern === undefined) {
    const first = positionals.shift();
    if (first === undefined || first === "") return undefined;
    p.pattern = first;
  }
  if (positionals.length > 1) return undefined;
  p.path = positionals[0];
  return p;
}

// Rewrite `cmd` to its codeindex equivalent, or return undefined to leave it
// alone. `bin` is the codeindex executable name to emit (the host may have it
// on PATH under a mount point of its choosing).
export function rewriteCommand(cmd: string, bin = "codeindex"): string | undefined {
  const line = cmd.trim();
  if (!line || SHELL_METACHARS.test(line)) return undefined;

  const tokens = tokenize(line);
  if (!tokens || tokens.length < 2) return undefined;

  // Refuse env-prefixed or path-qualified invocations (`FOO=1 grep …`,
  // `/usr/bin/grep …`): resolving those faithfully is not worth the risk.
  const [head, ...args] = tokens;
  if (head === undefined || !GREP_BINARIES.has(head)) return undefined;

  const p = parseSearch(head, args);
  if (!p || p.pattern === undefined) return undefined;
  const pattern = p.pattern;
  // A non-recursive `grep pattern file.ts` is already cheap and its semantics
  // (one file, text output) are not what the indexed search provides.
  if (!p.recursive) return undefined;

  // A path that is not the tree root means "search this subtree"; express it as
  // a scope rather than silently widening to the whole repo.
  const path = p.path;
  const out = [bin, "grep", shellQuote(pattern)];
  if (path && path !== "." && path !== "./") {
    out.push("--scope", shellQuote(path.replace(/\/+$/, "")));
  }
  if (p.ignoreCase) out.push("--ignore-case");
  for (const g of p.includes) out.push("--include", shellQuote(g));
  return out.join(" ");
}
