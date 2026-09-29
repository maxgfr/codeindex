// `codeindex mcp --repo <dir> --watch`, driven end to end: a real server
// process, real filesystem changes between calls, and the answers compared
// with what the tree on disk says.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { watchRepo, type RepoWatch } from "../src/mcp/watch.js";
import { walk, type WalkResult } from "../src/walk.js";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("./fixtures/mini-repo", import.meta.url));

interface Reply {
  id?: number;
  method?: string;
  params?: { progressToken?: number; message?: string };
  result?: { content?: { text: string }[]; isError?: boolean };
  error?: { message: string };
}

// One server process answering one call at a time, so a test can change the
// tree between two calls exactly as an agent editing files would.
interface Session {
  child: ChildProcessWithoutNullStreams;
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  stderr(): string;
  // Progress messages the server sent for the call with this id.
  progress(id: number): string[];
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
  const progress = new Map<number, string[]>();
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
      else if (reply.method === "notifications/progress" && typeof reply.params?.progressToken === "number") {
        const token = reply.params.progressToken;
        progress.set(token, [...(progress.get(token) ?? []), reply.params.message ?? ""]);
      }
    }
  });
  // A protocol revision whose progress notifications carry a message.
  const initialize = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "watch-test", version: "0" } };
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: initialize }) + "\n");
  return {
    child,
    stderr: () => err,
    progress: (id) => progress.get(id) ?? [],
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
        // Each call's progress token is its id.
        const params = { name, arguments: args, _meta: { progressToken: id } };
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }) + "\n");
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

  it("answers an unchanged repository without walking it, and a changed one after walking", async () => {
    const repo = fixtureCopy();
    const session = watchSession(repo);
    expect(await found(session, "backoff")).toEqual(["src/util.ts"]); // id 1
    expect(await found(session, "backoff")).toEqual(["src/util.ts"]); // id 2
    // Linux proves the tree unchanged; elsewhere the watcher is only a hint.
    const unchanged = process.platform === "linux" ? /^unchanged since the last call/ : /^walked /;
    expect(session.progress(1)[0]).toMatch(/^walked /);
    expect(session.progress(2)[0]).toMatch(unchanged);

    writeFileSync(join(repo, "src", "util.ts"), "export function backoffRenamed(): number { return 1; }\n");
    expect(await found(session, "backoff")).toEqual([]); // id 3
    expect(session.progress(3)[0]).toMatch(/^walked /);
    expect(await found(session, "backoffRenamed")).toEqual(["src/util.ts"]); // id 4
    expect(session.progress(4)[0]).toMatch(unchanged);
  }, 30_000);
});

// The watcher's oracle on its own (src/mcp/watch.ts). Linux only: elsewhere
// the watcher is a hint and every call walks.
describe.runIf(process.platform === "linux")("watchRepo oracle", () => {
  const rels = (walked: WalkResult): string[] => walked.files.map((f) => f.rel);
  const open = (repo: string, maxDirs?: number): { watch: RepoWatch; warnings: string[] } => {
    const warnings: string[] = [];
    const watch = watchRepo(repo, (message) => warnings.push(message), maxDirs);
    cleanups.push(() => watch.close());
    return { watch, warnings };
  };

  it("reuses the walk only while nothing watched changed", async () => {
    const repo = fixtureCopy();
    const { watch } = open(repo);
    const first = await watch.walk();
    expect(first.reused).toBe(false);
    const second = await watch.walk();
    expect(second).toEqual({ walked: first.walked, reused: true });

    // An edit in a nested directory, with no delay before the next call.
    writeFileSync(join(repo, "src", "util.ts"), "export const edited = 1;\n");
    const third = await watch.walk();
    expect(third.reused).toBe(false);
    expect((await watch.walk()).walked).toBe(third.walked);
  });

  it("watches a directory created between two calls before listing it", async () => {
    const repo = fixtureCopy();
    const { watch } = open(repo);
    await watch.walk();
    mkdirSync(join(repo, "fresh", "deep"), { recursive: true });
    writeFileSync(join(repo, "fresh", "deep", "a.ts"), "export const a = 1;\n");
    expect(rels((await watch.walk()).walked)).toContain("fresh/deep/a.ts");
    // A file in the new directory, which only its own watch can report.
    writeFileSync(join(repo, "fresh", "deep", "b.ts"), "export const b = 1;\n");
    const after = await watch.walk();
    expect(after.reused).toBe(false);
    expect(rels(after.walked)).toContain("fresh/deep/b.ts");
  });

  it("re-watches a directory deleted and re-created under the same name", async () => {
    const repo = fixtureCopy();
    const { watch } = open(repo);
    await watch.walk();
    rmSync(join(repo, "gopkg"), { recursive: true });
    mkdirSync(join(repo, "gopkg", "sub"), { recursive: true });
    expect(rels((await watch.walk()).walked).some((rel) => rel.startsWith("gopkg/"))).toBe(false);
    // The old watch followed the deleted inode; only a new one sees this.
    writeFileSync(join(repo, "gopkg", "sub", "late.go"), "package sub\n");
    const after = await watch.walk();
    expect(after.reused).toBe(false);
    expect(rels(after.walked)).toContain("gopkg/sub/late.go");
    // And a renamed directory is followed under its new name.
    renameSync(join(repo, "gopkg"), join(repo, "moved"));
    expect(rels((await watch.walk()).walked)).toContain("moved/sub/late.go");
    writeFileSync(join(repo, "moved", "sub", "later.go"), "package sub\n");
    expect(rels((await watch.walk()).walked)).toContain("moved/sub/later.go");
  });

  it("never watches ignored trees, and gives back directories that become ignored", async () => {
    const repo = fixtureCopy();
    for (let i = 0; i < 50; i++) mkdirSync(join(repo, "node_modules", `p${i}`, "lib"), { recursive: true });
    const { watch } = open(repo);
    const before = inotifyWatches();
    await watch.walk();
    const dirs = walkedDirs(repo);
    // One watch per walked directory, plus the barrier's; node_modules' 101
    // directories take none.
    expect(inotifyWatches() - before).toBe(dirs + 1);

    // A change inside an ignored tree is invisible, and needs no walk.
    const quiet = await watch.walk();
    writeFileSync(join(repo, "node_modules", "p0", "lib", "x.js"), "x\n");
    expect((await watch.walk()).walked).toBe(quiet.walked);

    // A .gitignore edit is a change; the newly ignored directory's watch is
    // released and its files leave the walk.
    writeFileSync(join(repo, ".gitignore"), "gopkg/\n");
    const after = await watch.walk();
    expect(rels(after.walked).some((rel) => rel.startsWith("gopkg/"))).toBe(false);
    expect(inotifyWatches() - before).toBe(walkedDirs(repo) + 1);
  });

  it("falls back to plain walks, with a warning, past its directory budget", async () => {
    const repo = fixtureCopy();
    const { watch, warnings } = open(repo, 2);
    const before = inotifyWatches();
    const first = await watch.walk();
    expect(warnings).toEqual([expect.stringContaining("more than 2 directories")]);
    expect(inotifyWatches()).toBe(before);
    const second = await watch.walk();
    expect(second.reused).toBe(false);
    expect(rels(second.walked)).toEqual(rels(first.walked));
  });
});

// Directories the walk enters, the root included.
function walkedDirs(repo: string): number {
  let dirs = 1;
  walk(repo, { filter: (entry) => (entry.directory && dirs++, true) });
  return dirs;
}

// inotify watches held by this process.
function inotifyWatches(): number {
  let count = 0;
  for (const fd of readdirSync("/proc/self/fdinfo")) {
    try {
      count += (readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^inotify /gm) ?? []).length;
    } catch {
      // closed between the listing and the read
    }
  }
  return count;
}
