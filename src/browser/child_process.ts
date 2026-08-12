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

/** The shape `spawn` consumers actually touch — deliberately not Node's full one. */
export interface ChildProcessLike {
  pid: number | undefined;
  stdin: { write(chunk: string): boolean; end(): void } | null;
  stdout: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  stderr: { on(event: string, listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...a: unknown[]) => void): ChildProcessLike;
  kill(signal?: string): boolean;
}

/**
 * Asynchronous spawn, absent the same way `spawnSync` is absent.
 *
 * `spawnSync` can report ENOENT in its return value; `spawn` cannot, because
 * the real one reports it by emitting `error` on a process object it has
 * already returned. So this returns a process that emits ENOENT on the next
 * microtask and then closes — which is exactly the sequence a caller has to
 * handle anyway for a language server that is not installed, and therefore the
 * path that is already tested rather than a browser-specific fork.
 */
export function spawn(command: string, _args?: readonly string[], _options?: unknown): ChildProcessLike {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const child: ChildProcessLike = {
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    on(event, listener) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return child;
    },
    kill: () => false,
  };
  const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.syscall = `spawn ${command}`;
  error.path = command;
  // Next microtask, so a caller that attaches listeners synchronously after the
  // call — which is the only correct way to use spawn — still receives both.
  void Promise.resolve().then(() => {
    for (const listener of listeners.get("error") ?? []) listener(error);
    for (const listener of listeners.get("close") ?? []) listener(null);
  });
  return child;
}

export default { spawnSync, execSync, spawn };
