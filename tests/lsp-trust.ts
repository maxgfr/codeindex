import { afterAll, beforeAll } from "vitest";

// The LSP suites exercise a REPOSITORY-configured tier: each writes the repo's
// own .codeindex/lsp.json. That file names commands to spawn, so it is read
// only when trusted (src/lsp/config.ts). Call at the top of a suite to grant
// trust the documented way — the environment, which the CLI and MCP children
// these suites spawn inherit too.
export function trustRepoLspConfig(): void {
  const before = process.env.CODEINDEX_TRUST_LSP_CONFIG;
  beforeAll(() => {
    process.env.CODEINDEX_TRUST_LSP_CONFIG = "1";
  });
  afterAll(() => {
    if (before === undefined) delete process.env.CODEINDEX_TRUST_LSP_CONFIG;
    else process.env.CODEINDEX_TRUST_LSP_CONFIG = before;
  });
}
