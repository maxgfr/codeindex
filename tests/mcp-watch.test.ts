// `codeindex mcp --repo <dir> --watch`, driven end to end: a real server
// process, real filesystem changes between calls, and the answers compared
// with what the tree on disk says.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

interface Reply {
  id?: number;
  result?: { content?: { text: string }[]; isError?: boolean };
  error?: { message: string };
}

// One server process answering one call at a time, so a test can change the
// tree between two calls exactly as an agent editing files would.
interface Session {
  child: ChildProcessWithoutNullStreams;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  stderr(): string;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fixtureCopy(): string {
  const parent = mkdtempSync(join(tmpdir(), "ci-mcp-watch-"));
  cleanups.push(() => rmSync(parent, { recursive: true, force: true }));
  const repo = join(parent, "repo");
  cpSync(REPO, repo, { recursive: true });
  return repo;
}

function watchSession(repo: string, extra: string[] = []): Session {
  const child = spawn(process.execPath, [CLI, "mcp", "--repo", repo, "--watch", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(() => child.kill());
  let buf = "";
  let err = "";
  let nextId = 1;
  const waiting = new Map<number, (reply: Reply) => void>();
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let newline;
    while ((newline = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, newline);
      buf = buf.slice(newline + 1);
      if (!line.trim()) continue;
      const reply = JSON.parse(line) as Reply;
      if (typeof reply.id === "number") waiting.get(reply.id)?.(reply);
    }
  });
  return {
    child,
    stderr: () => err,
    call(name, args = {}) {
      const id = nextId++;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`watched MCP call ${name} timed out`)), 15_000);
        waiting.set(id, (reply) => {
          clearTimeout(timer);
          waiting.delete(id);
          if (reply.error) reject(new Error(reply.error.message));
          else resolvePromise({ text: reply.result!.content![0]!.text, isError: reply.result!.isError === true });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
      });
    },
  };
}

const graphFiles = async (session: Session): Promise<string[]> =>
  (JSON.parse((await session.call("graph")).text) as { files: { rel: string }[] }).files.map((f) => f.rel);
const found = async (session: Session, namePath: string): Promise<string[]> =>
  (JSON.parse((await session.call("find_symbol", { namePath })).text) as { file: string }[]).map((m) => m.file);

describe("mcp --watch", () => {
  it("forgets a deleted file and a deleted directory", async () => {
    const repo = fixtureCopy();
    mkdirSync(join(repo, "newpkg", "sub"), { recursive: true });
    writeFileSync(join(repo, "newpkg", "sub", "late.ts"), "export function brandNew(): number { return 1; }\n");
    const session = watchSession(repo);
    expect(await graphFiles(session)).toEqual(expect.arrayContaining(["src/util.ts", "newpkg/sub/late.ts"]));
    expect(await found(session, "backoff")).toEqual(["src/util.ts"]);

    rmSync(join(repo, "src", "util.ts"));
    rmSync(join(repo, "newpkg"), { recursive: true });
    // No sleep: the answer must already reflect the tree, whether or not the
    // events have been delivered yet.
    expect(await found(session, "backoff")).toEqual([]);
    expect(await found(session, "brandNew")).toEqual([]);
    const files = await graphFiles(session);
    expect(files).not.toContain("src/util.ts");
    expect(files.some((rel) => rel.startsWith("newpkg/"))).toBe(false);
    const overview = await session.call("symbols_overview", { file: "src/util.ts" });
    expect(overview.isError).toBe(true);
  }, 30_000);
});
