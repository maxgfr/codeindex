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
  },
});
