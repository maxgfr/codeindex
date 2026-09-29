// `codeindex mcp --repo <dir> --watch`: the filesystem watcher of a pinned
// repository, and what a tool call may skip because of it.
//
// Without a watcher, every scan-needing call walks the whole tree to prove the
// session's scan still matches the disk (1.6 s of a 2 s warm call on the
// 66k-file TypeScript repo). The old watcher was only an invalidation hint, so
// it saved none of that, and it cost a lot: fs.watch(root, {recursive}) on
// Linux is emulated by Node with one inotify watch per DIRECTORY AND FILE of
// the whole tree, node_modules included — 67k watches for TypeScript, enough
// to exhaust a user's inotify budget and break their IDE's and bundler's
// watchers.
//
// On Linux the watch set is now the walk's own directories — never an ignored
// tree, never a file — each watched non-recursively, and the watcher becomes a
// freshness ORACLE:
//
// - All of a process's fs.watch handles share ONE inotify instance (libuv
//   keeps one per loop) and the kernel queues its events in order. A request
//   creates a barrier file in a private temp dir, also watched, and waits for
//   that file's event: every change made before the barrier has then been
//   delivered to its callback.
// - Each delivered event bumps `events`. A walk taken after a barrier that saw
//   N events stays the truth for as long as the next barrier still sees N: no
//   watched directory changed in between.
// - A walk only proves anything if every directory it listed was watched
//   BEFORE it was listed. The walk's `filter` hook sees a directory before it is
//   pushed, and the walk reads it only when it is popped, so new directories
//   are watched in the same walk that finds them.
// - A lost event can only make the oracle more cautious. inotify drops events
//   only when its queue overflows, and it overflows only after delivering a
//   full queue of events — which already moved `events`. A barrier that never
//   arrives (overflow ate it) times out into a plain walk.
//
// Everything that cannot keep that contract falls back to the plain per-call
// walk, which is always correct: the barrier timing out, a watch failing
// (ENOSPC once the inotify budget is gone), more directories than we are
// willing to take from that budget, or a platform other than Linux, where the
// native recursive watcher (FSEvents, ReadDirectoryChangesW) is cheap but
// gives no ordering promise we could test; there it stays an invalidation hint.
import { existsSync, mkdtempSync, rmSync, statSync, watch as watchFs, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IGNORE_DIRS, walk, type WalkResult } from "../walk.js";
import { sessionInvalidate } from "./session.js";

export interface RepoWatch {
  // The repository's walk: the last one (`reused`) when the watcher proves
  // nothing changed since it was taken, a fresh one otherwise.
  walk(): Promise<{ walked: WalkResult; reused: boolean }>;
  close(): void;
}

// Directories we are willing to watch. Each costs one inotify watch from the
// user's budget (max_user_watches, 8192 on older kernels and shared by every
// watcher they run); the 66k-file TypeScript repo needs 700.
export const MAX_WATCHED_DIRS = 8192;

// How long a request waits for its own barrier event before walking anyway.
// Delivery takes well under a millisecond on an idle loop.
const BARRIER_TIMEOUT_MS = 2000;

// `maxDirs` lowers MAX_WATCHED_DIRS, for tests.
export function watchRepo(repo: string, warn: (message: string) => void, maxDirs = MAX_WATCHED_DIRS): RepoWatch {
  if (process.platform === "linux") return new DirWatch(repo, warn, maxDirs);
  return hintWatch(repo, warn);
}

// Native recursive watching, as an invalidation hint only: the per-call walk
// still proves freshness.
function hintWatch(repo: string, warn: (message: string) => void): RepoWatch {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watchFs(repo, { recursive: true }, (_event, filename) => {
      const rel = filename?.toString().replaceAll("\\", "/") ?? "";
      const ignored = rel.split("/").some((segment) => IGNORE_DIRS.has(segment) || segment.startsWith(".codeindex-edit-"));
      if (!ignored) sessionInvalidate(repo, rel || undefined);
    });
    watcher.on("error", (error) => {
      warn(`MCP watcher disabled (${error.message}); using freshness scans`);
      watcher?.close();
      watcher = undefined;
      sessionInvalidate(repo);
    });
  } catch (error) {
    warn(`MCP watcher unavailable (${error instanceof Error ? error.message : String(error)}); using freshness scans`);
  }
  return {
    walk: async () => ({ walked: walk(repo, {}), reused: false }),
    close: () => watcher?.close(),
  };
}

class DirWatch implements RepoWatch {
  // Repo-relative directory ("" is the root) → its watcher.
  private readonly dirs = new Map<string, FSWatcher>();
  private events = 0;
  // The last walk and the event count it is valid for.
  private proof?: { events: number; walked: WalkResult };
  private barrier?: { dir: string; watcher: FSWatcher; seq: number; waiting?: { name: string; done: () => void } } | null;
  private disabled = false;

  constructor(
    private readonly repo: string,
    private readonly warn: (message: string) => void,
    private readonly maxDirs: number,
  ) {}

  async walk(): Promise<{ walked: WalkResult; reused: boolean }> {
    if (this.disabled) return { walked: walk(this.repo, {}), reused: false };
    const seen = await this.sync();
    if (seen !== undefined && this.proof?.events === seen) return { walked: this.proof.walked, reused: true };
    this.proof = undefined;
    const walked = this.walkAndWatch();
    if (seen !== undefined && !this.disabled) this.proof = { events: seen, walked };
    return { walked, reused: false };
  }

  close(): void {
    for (const watcher of this.dirs.values()) watcher.close();
    this.dirs.clear();
    this.proof = undefined;
    if (this.barrier) {
      this.barrier.watcher.close();
      rmSync(this.barrier.dir, { recursive: true, force: true });
    }
    this.barrier = null;
  }

  // Wait until every event queued before now has been delivered, and return
  // how many had been; undefined when that cannot be established.
  private sync(): Promise<number | undefined> {
    if (this.barrier === undefined) this.barrier = this.openBarrier();
    const barrier = this.barrier;
    if (!barrier) return Promise.resolve(undefined);
    // A new name per request: a late second event of the previous barrier's
    // write must not release this one early.
    const name = `barrier-${++barrier.seq}`;
    const file = join(barrier.dir, name);
    return new Promise<number | undefined>((resolvePromise) => {
      const finish = (value: number | undefined): void => {
        clearTimeout(timer);
        barrier.waiting = undefined;
        rmSync(file, { force: true });
        resolvePromise(value);
      };
      const timer = setTimeout(() => finish(undefined), BARRIER_TIMEOUT_MS);
      // Read at delivery, in the barrier's own callback: that is the count
      // every earlier change is included in.
      barrier.waiting = { name, done: () => finish(this.events) };
      try {
        writeFileSync(file, "");
      } catch {
        finish(undefined);
      }
    });
  }

  private openBarrier(): DirWatch["barrier"] {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), "codeindex-watch-"));
      const barrier: NonNullable<DirWatch["barrier"]> = {
        dir,
        seq: 0,
        watcher: watchFs(dir, (_event, filename) => {
          if (barrier.waiting && filename?.toString() === barrier.waiting.name) barrier.waiting.done();
        }),
      };
      barrier.watcher.on("error", () => undefined);
      return barrier;
    } catch (error) {
      if (dir) rmSync(dir, { recursive: true, force: true });
      // Without a barrier nothing can be proven: the directory watches would
      // be pure cost.
      this.disable(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  // One walk that also watches every directory it lists, before listing it.
  private walkAndWatch(): WalkResult {
    const visited = new Set<string>([""]);
    this.add("");
    const walked = walk(this.repo, {
      filter: (entry) => {
        if (entry.directory) {
          visited.add(entry.rel);
          this.add(entry.rel);
        }
        return true;
      },
    });
    // `.git/info/exclude` holds ignore rules the walk applies.
    const info = ".git/info";
    if (existsSync(join(this.repo, info)) && statSync(join(this.repo, info)).isDirectory()) {
      visited.add(info);
      this.add(info);
    }
    // Directories the walk no longer enters (deleted, newly ignored) give
    // their watches back.
    for (const [rel, watcher] of this.dirs) {
      if (visited.has(rel)) continue;
      watcher.close();
      this.dirs.delete(rel);
    }
    return walked;
  }

  private add(rel: string): void {
    if (this.disabled || this.dirs.has(rel)) return;
    if (this.dirs.size >= this.maxDirs) {
      this.disable(`more than ${this.maxDirs} directories to watch`);
      return;
    }
    try {
      const watcher = watchFs(rel ? join(this.repo, rel) : this.repo, (event, filename) => this.onEvent(rel, event, filename));
      // A watched directory that goes away is re-watched (or dropped) by the
      // walk its parent's event triggers.
      watcher.on("error", () => {
        this.events++;
        this.forget(rel);
      });
      this.dirs.set(rel, watcher);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Gone or unreadable since its parent was listed: the parent's watch
      // saw that change, and the walk skips an unreadable directory anyway.
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return;
      this.disable(error instanceof Error ? error.message : String(error));
    }
  }

  private onEvent(rel: string, event: string, filename: string | Buffer | null): void {
    this.events++;
    const name = filename?.toString();
    if (!name) {
      sessionInvalidate(this.repo);
      return;
    }
    const child = rel ? `${rel}/${name}` : name;
    // A renamed, deleted or re-created child directory: its watchers follow
    // the old inode, not the path. Dropping them lets the next walk watch
    // whatever now carries the name.
    if (event === "rename") this.forget(child);
    sessionInvalidate(this.repo, child);
  }

  // Close `rel`'s watcher and every watcher below it. Only a watched
  // directory can have watched descendants (the walk watches a parent before
  // its children), so an ordinary file event costs one lookup.
  private forget(rel: string): void {
    const watcher = this.dirs.get(rel);
    if (!watcher) return;
    watcher.close();
    this.dirs.delete(rel);
    const prefix = rel ? rel + "/" : "";
    for (const [dir, below] of this.dirs) {
      if (prefix && !dir.startsWith(prefix)) continue;
      below.close();
      this.dirs.delete(dir);
    }
  }

  // Every event so far has been delivered and applied, so the session's
  // entries stay valid; only the watches are given back.
  private disable(reason: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.warn(`MCP watcher disabled (${reason}); using freshness scans`);
    this.close();
  }
}
