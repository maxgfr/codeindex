// Oracles for the real-world command campaign (tests/e2e-commands.test.ts):
// independent tools — git, ripgrep, a hand-rolled protobuf reader — that say
// what a codeindex answer must contain on a real checkout. Each oracle returns
// the DIFFERENCES it found rather than asserting, so the suite can report every
// anomaly of a repo in one pass and classify it (bug, oracle false positive,
// documented limit) instead of stopping at the first.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../scripts/cli.mjs", import.meta.url));

// ---- running the CLI ---------------------------------------------------------

export interface CliRun {
  args: string[];
  code: number | null;
  stdout: Buffer;
  stderr: string;
  ms: number;
}

export function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CliRun {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    maxBuffer: 1 << 30,
    timeout: opts.timeoutMs ?? 600_000,
  });
  return { args, code: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: String(r.stderr ?? ""), ms: performance.now() - t0 };
}

// A V8 stack frame line: "    at fn (file:1:2)" or "    at file:1:2".
const STACK_FRAME = /^\s+at (?:.+ \()?(?:file:|node:|\/|[A-Za-z]:\\).*:\d+:\d+\)?$/m;
export function hasStackTrace(stderr: string): boolean {
  return STACK_FRAME.test(stderr);
}

export function parseJson(buf: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(buf.toString("utf8")) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- git ----------------------------------------------------------------------

function git(repo: string, args: string[], input?: string): string {
  const r = spawnSync("git", ["-C", repo, ...args], {
    input,
    maxBuffer: 1 << 30,
    env: { ...process.env, LC_ALL: "C", LANGUAGE: "" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr)}`);
  return String(r.stdout);
}

const nulList = (out: string): string[] => out.split("\0").filter(Boolean);

// What git would hand a build: tracked + untracked-not-ignored files, minus the
// tracked files a .gitignore matches (git keeps tracking them, but an
// ignore-honouring walk — codeindex's and ripgrep's — rightly leaves them out).
export function gitVisibleFiles(repo: string): Set<string> {
  const all = new Set(nulList(git(repo, ["ls-files", "-z", "-co", "--exclude-standard"])));
  for (const p of nulList(git(repo, ["ls-files", "-z", "-ci", "--exclude-standard"]))) all.delete(p);
  // A submodule is one gitlink entry (mode 160000) and, uninitialised, an
  // empty directory: there is no file to index.
  for (const line of git(repo, ["ls-files", "-z", "-s"]).split("\0")) {
    if (line.startsWith("160000 ")) all.delete(line.slice(line.indexOf("\t") + 1));
  }
  return all;
}

// The subset of `paths` git considers ignored.
export function gitIgnored(repo: string, paths: readonly string[]): Set<string> {
  if (!paths.length) return new Set();
  const r = spawnSync("git", ["-C", repo, "check-ignore", "-z", "--stdin", "--no-index"], {
    input: paths.join("\0") + "\0",
    maxBuffer: 1 << 30,
  });
  // Exit 1 = none ignored; anything else non-zero is a real failure.
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${String(r.stderr)}`);
  return new Set(nulList(String(r.stdout)));
}

export function gitDiffNames(repo: string, base: string): Set<string> {
  return new Set(nulList(git(repo, ["diff", "-z", "--name-only", "-M", base, "--"])));
}

// Commits per path over the same window codeindex reads: HEAD minus the
// shallow boundary, no rename pairing, merges contributing nothing. Parsed from
// --numstat, a different output format than the engine's --name-only reader.
export function gitChurnOracle(repo: string): Map<string, number> {
  const shallowFile = join(repo, ".git", "shallow");
  const boundary = existsSync(shallowFile) ? readFileSync(shallowFile, "utf8").split("\n").filter(Boolean) : [];
  const out = git(repo, ["log", "--no-renames", "--numstat", "-z", "--format=%x01%H", "--stdin"], ["HEAD", ...boundary.map((s) => `^${s}`)].join("\n") + "\n");
  const churn = new Map<string, number>();
  for (const commit of out.split("\x01").slice(1)) {
    const seen = new Set<string>();
    // -z numstat: "<add>\t<del>\t<path>\0" per file after the header line.
    const body = commit.slice(commit.indexOf("\n") + 1);
    for (const rec of body.split("\0")) {
      const m = /^(?:\n)?(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
      if (!m) continue;
      const path = m[3]!;
      if (seen.has(path)) continue;
      seen.add(path);
      churn.set(path, (churn.get(path) ?? 0) + 1);
    }
  }
  return churn;
}

// ---- ripgrep ------------------------------------------------------------------

export function haveRg(): boolean {
  return spawnSync("rg", ["--version"]).status === 0;
}

// Every (file, line) where `literal` occurs, over every non-binary file
// (hidden and ignored included — the caller restricts to the indexed set).
export function rgLiteralHits(repo: string, literal: string): Set<string> {
  const r = spawnSync("rg", ["-F", "-n", "--no-heading", "--with-filename", "--null", "-uu", "--", literal, "."], {
    cwd: repo,
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`rg failed: ${String(r.stderr)}`);
  const hits = new Set<string>();
  for (const line of String(r.stdout).split("\n")) {
    if (!line) continue;
    const nul = line.indexOf("\0");
    const file = line.slice(0, nul).replace(/^\.\//, "");
    const lineNo = /^(\d+):/.exec(line.slice(nul + 1))?.[1];
    if (lineNo) hits.add(`${file}:${lineNo}`);
  }
  return hits;
}

// Files where `word` occurs as a whole word.
export function rgFilesWithWord(repo: string, word: string): Set<string> {
  const r = spawnSync("rg", ["-F", "-w", "-l", "--null", "-uu", "--", word, "."], { cwd: repo, maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`rg failed: ${String(r.stderr)}`);
  return new Set(nulList(String(r.stdout)).map((f) => f.replace(/^\.\//, "")));
}

// ---- SCIP ---------------------------------------------------------------------

// Just enough protobuf to prove the index decodes end to end: every field of
// the top-level Index message is walked (a truncated or misframed buffer
// throws), and Metadata.project_root (Index.1 → Metadata.3) is returned.
export function decodeScip(bytes: Uint8Array): { projectRoot: string | undefined; documents: number } {
  const varint = (pos: number): [number, number] => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= bytes.length) throw new Error("truncated varint");
      const b = bytes[pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return [result, pos];
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    }
  };
  const fields = (start: number, end: number): { field: number; start: number; end: number }[] => {
    const out: { field: number; start: number; end: number }[] = [];
    let pos = start;
    while (pos < end) {
      const [key, p1] = varint(pos);
      const field = Math.floor(key / 8);
      const wire = key & 7;
      if (wire === 0) pos = varint(p1)[1];
      else if (wire === 2) {
        const [len, p2] = varint(p1);
        if (p2 + len > end) throw new Error(`field ${field} overruns its message`);
        out.push({ field, start: p2, end: p2 + len });
        pos = p2 + len;
      } else if (wire === 1) pos = p1 + 8;
      else if (wire === 5) pos = p1 + 4;
      else throw new Error(`unsupported wire type ${wire}`);
      if (pos > end) throw new Error("message overrun");
    }
    return out;
  };
  let projectRoot: string | undefined;
  let documents = 0;
  for (const f of fields(0, bytes.length)) {
    if (f.field === 1) {
      for (const m of fields(f.start, f.end)) {
        if (m.field === 3) projectRoot = Buffer.from(bytes.subarray(m.start, m.end)).toString("utf8");
      }
    } else if (f.field === 2) {
      documents++;
      fields(f.start, f.end); // decodes
    }
  }
  return { projectRoot, documents };
}

// ---- Mermaid ------------------------------------------------------------------

// Lines a Mermaid renderer would mis-read: raw angle brackets outside an arrow
// (HTML in a label), or a label quote left open by a newline in a path.
export function mermaidProblems(text: string): string[] {
  const problems: string[] = [];
  for (const line of text.split("\n")) {
    const noArrows = line.replace(/<-->|-->|==>|-\.->|---|<--|--/g, "");
    if (/[<>]/.test(noArrows)) problems.push(`raw angle bracket: ${line}`);
    const quotes = (line.match(/"/g) ?? []).length;
    if (quotes % 2) problems.push(`unbalanced quote: ${line}`);
  }
  return problems;
}

// ---- MCP ----------------------------------------------------------------------

export interface McpCall {
  ok: boolean;
  isError: boolean;
  text: string;
  wireBytes: number; // the JSON-RPC response line as sent
  ms: number;
  error?: string;
}

// A minimal newline-delimited JSON-RPC client that also records how many
// bytes each response took on the wire (the response cap's real measure).
export function startMcp(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, [CLI, "mcp", ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-65536)));
  const pending = new Map<number, (line: string) => void>();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, terminal: false });
  rl.on("line", (line) => {
    let msg: { id?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const settle = pending.get(msg.id);
      pending.delete(msg.id);
      settle?.(line);
    }
  });
  const request = (method: string, params: unknown, timeoutMs = 600_000): Promise<string> =>
    new Promise((settle, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, (line) => {
        clearTimeout(timer);
        settle(line);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    stderr: () => stderr,
    async init(): Promise<void> {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async listTools(): Promise<string[]> {
      const line = await request("tools/list", {});
      return (JSON.parse(line).result.tools as { name: string }[]).map((t) => t.name);
    },
    async call(name: string, args: Record<string, unknown>): Promise<McpCall> {
      const t0 = performance.now();
      const line = await request("tools/call", { name, arguments: args });
      const ms = performance.now() - t0;
      const msg = JSON.parse(line) as { result?: { isError?: boolean; content?: { text?: string }[] }; error?: { message: string } };
      if (msg.error) return { ok: false, isError: true, text: "", wireBytes: Buffer.byteLength(line), ms, error: msg.error.message };
      return {
        ok: true,
        isError: msg.result?.isError === true,
        text: msg.result?.content?.map((c) => c.text ?? "").join("") ?? "",
        wireBytes: Buffer.byteLength(line),
        ms,
      };
    },
    close(): Promise<void> {
      return new Promise((settle) => {
        if (child.exitCode !== null) return settle();
        child.once("exit", () => settle());
        child.stdin.end();
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      });
    },
  };
}

// ---- small helpers ------------------------------------------------------------

// Every `file` value under keys that list sites, anywhere in a JSON answer.
export function filesUnder(value: unknown, keys: ReadonlySet<string>, inKey = false, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) filesUnder(v, keys, inKey, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (inKey && k === "file" && typeof v === "string") out.add(v);
      filesUnder(v, keys, inKey || keys.has(k), out);
    }
  }
  return out;
}

export function setDiff<T>(a: Iterable<T>, b: ReadonlySet<T>): T[] {
  const out: T[] = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  return out;
}
