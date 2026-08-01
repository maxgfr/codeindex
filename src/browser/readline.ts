// `node:readline` for the browser build. Reachable only from mcp.ts, whose
// stdio transport has no browser equivalent and which is stubbed out anyway.
// Present so the import graph resolves.

export function createInterface(): never {
  throw new Error("readline is not available in the browser build (the MCP stdio transport is Node-only)");
}

export default { createInterface };
