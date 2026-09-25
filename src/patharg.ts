// A file argument as the user wrote it — `./src/a.ts`, an absolute path, a
// Windows `src\a.ts` — spelled the way the index keys files: repo-relative,
// forward slashes. The literal comes first (a module slug, or a rel that
// really contains a backslash); a differing normalized spelling second.
// `complexity ./src/a.ts` used to answer [] and `impact ./src/a.ts` "no such
// file" for a file the relative spelling found.
//
// Shared by the CLI and the MCP server, so a path an agent copies out of a
// shell answer reads the same in a tool call.
import { isAbsolute, relative } from "node:path";

export function fileArgReadings(repo: string, arg: string): string[] {
  let rel = (isAbsolute(arg) ? relative(repo, arg) : arg).replace(/\\/g, "/");
  while (rel.startsWith("./")) rel = rel.slice(2);
  return rel !== arg && rel !== "" && rel !== ".." && !rel.startsWith("../") ? [arg, rel] : [arg];
}

/** The first reading of `arg` that `known` holds, or undefined. */
export function resolveFileArg(repo: string, arg: string, known: (rel: string) => boolean): string | undefined {
  return fileArgReadings(repo, arg).find(known);
}
