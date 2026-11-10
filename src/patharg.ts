// A file argument as the user wrote it — `./src/a.ts`, an absolute path, a
// Windows `src\a.ts` — spelled the way the index keys files: repo-relative,
// forward slashes. The literal comes first (a module slug, or a rel that
// really contains a backslash); a differing normalized spelling second.
// `complexity ./src/a.ts` used to answer [] and `impact ./src/a.ts` "no such
// file" for a file the relative spelling found.
//
// Shared by the CLI and the MCP server, so a path an agent copies out of a
// shell answer reads the same in a tool call.
//
// Normalized like a path, too: `src/../src/a.ts` and `./src//a.ts` name the
// file `src/a.ts`, and the MCP tools that take a file already read them so.
import { isAbsolute, posix, relative } from "node:path";

export function fileArgReadings(repo: string, arg: string): string[] {
  const rel = posix.normalize((isAbsolute(arg) ? relative(repo, arg) : arg).replace(/\\/g, "/")).replace(/\/+$/, "");
  return rel !== arg && rel !== "" && rel !== "." && rel !== ".." && !rel.startsWith("../") ? [arg, rel] : [arg];
}

/** The first reading of `arg` that `known` holds, or undefined. */
export function resolveFileArg(repo: string, arg: string, known: (rel: string) => boolean): string | undefined {
  return fileArgReadings(repo, arg).find(known);
}
