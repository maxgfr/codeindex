// `node:child_process` for the browser build: every spawn reports the binary as
// absent.
//
// This is not a degradation hack — it is the engine's own documented contract.
// util.ts:sh converts an ENOENT spawn error into `{ ok: false, missing: true }`,
// and EVERY consumer of sh already branches on that: git.ts:headCommit returns
// undefined (the index still builds, just without a pinned commit), grep.ts
// falls through to its pure-JS backend, engine-cli.ts skips docker. So the
// whole git/ripgrep/docker surface degrades along paths that already exist and
// are already tested, rather than along a browser-specific fork.

export interface SpawnSyncReturns {
  pid: number;
  output: (string | null)[];
  stdout: string;
  stderr: string;
  status: number | null;
  signal: string | null;
  error?: NodeJS.ErrnoException;
}

export function spawnSync(command: string, _args?: readonly string[], _options?: unknown): SpawnSyncReturns {
  const error = new Error(`spawnSync ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.errno = -2;
  error.syscall = `spawnSync ${command}`;
  error.path = command;
  return { pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null, error };
}

export function execSync(command: string): never {
  const error = new Error(`execSync ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}

export default { spawnSync, execSync };
