// Project memories (Serena-parity): named markdown notes an agent persists
// across sessions — project map, build commands, conventions. Stored under
// <repo>/.codeindex/memories/<name>.md; names may contain `/` for topic
// subdirectories. Plain files, no daemon; the value is the discipline (small
// named notes read on relevance) rather than any machinery.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function memoryPath(repo: string, name: string): string {
  return join(repo, ...MEMORY_DIR, `${sanitize(name)}.md`);
}

export function writeMemory(repo: string, name: string, content: string): string {
  const path = memoryPath(repo, name);
  mkdirSync(dirname(path), { recursive: true });
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
  const root = join(repo, ...MEMORY_DIR);
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      else if (e.name.endsWith(".md")) out.push(prefix ? `${prefix}/${e.name.slice(0, -3)}` : e.name.slice(0, -3));
    }
  };
  walk(root, "");
  return out.sort();
}
