import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests build indexes into temp dirs, fixtures carry committed outputs, and
    // the e2e cache holds whole cloned repos (with their own test suites) —
    // never collect tests from those trees.
    exclude: [...configDefaults.exclude, "tests/fixtures/**", "tests/.e2e-cache/**"],
    // Load the tree-sitter grammars before every suite so unit tests extract via
    // the AST path, matching the shipped bundle.
    setupFiles: ["tests/setup.ts"],
    // Many suites spawn the CLI or an MCP server, several times per test. The
    // 5 s default is a few cold node starts on a loaded machine: tests timed
    // out at random there and passed alone. A test that needs longer still
    // says so itself.
    testTimeout: 30_000,
  },
});
