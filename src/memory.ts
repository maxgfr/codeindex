// Project memories (Serena-parity): named markdown notes an agent persists
// across sessions — project map, build commands, conventions. Stored under
// <repo>/.codeindex/memories/<name>.md; names may contain `/` for topic
// subdirectories. Plain files, no daemon; the value is the discipline (small
// named notes read on relevance) rather than any machinery.
import { lstatSync, realpathSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MEMORY_DIR = [".codeindex", "memories"];

// Reject anything that could escape the memories directory: names become
// filesystem paths.
function sanitize(name: string): string {
  const clean = name.replace(/^mem:/, "").replace(/\.md$/, "");
  if (!clean) throw new Error("memory name is empty");
  const segments = clean.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.includes("\\")) {
      throw new Error(`invalid memory name: "${name}"`);
    }
    if (!/^[\w][\w.-]*$/.test(seg)) throw new Error(`invalid memory name segment: "${seg}"`);
  }
  return clean;
}

// Resolve the repository itself (a symlinked checkout is valid), then reject
// symlinks at every storage component. Lexical names alone cannot contain a
// repository-provided symlink to a foreign file or directory. Hard-linked notes
// share an inode with another path, so reading or truncating them is unsafe too.
function checkedPath(repo: string, segments: string[]): string {
  let path = realpathSync(repo);
  for (const segment of [...MEMORY_DIR, ...segments]) {
    path = join(path, segment);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new Error(`memory path contains a symbolic link: ${path}`);
      if (st.isFile() && st.nlink > 1) throw new Error(`memory path contains a hard link: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

function memoryPath(repo: string, name: string): string {
  return checkedPath(repo, `${sanitize(name)}.md`.split("/"));
}

export function writeMemory(repo: string, name: string, content: string): string {
  const path = memoryPath(repo, name);
  mkdirSync(dirname(path), { recursive: true });
  memoryPath(repo, name); // validate newly created parents before following them
  writeFileSync(path, content.endsWith("\n") ? content : content + "\n");
  return sanitize(name);
}

export function readMemory(repo: string, name: string): string | undefined {
  try {
    return readFileSync(memoryPath(repo, name), "utf8");
  } catch {
    return undefined;
  }
}

export function deleteMemory(repo: string, name: string): boolean {
  const path = memoryPath(repo, name);
  try {
    statSync(path);
  } catch {
    return false;
  }
  rmSync(path);
  return true;
}

// Sorted list of memory names (topic/name form) — agents load the LIST first
// and read individual memories on relevance.
export function listMemories(repo: string): string[] {
  let root: string;
  try { root = checkedPath(repo, []); } catch { return []; }
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const name = prefix ? `${prefix}/${e.name.slice(0, -3)}` : e.name.slice(0, -3);
        try {
          checkedPath(repo, `${name}.md`.split("/"));
          out.push(name);
        } catch {
          // Unreadable or linked files are not safe memories to advertise.
        }
      }
    }
  };
  walk(root, "");
  return out.sort();
}
