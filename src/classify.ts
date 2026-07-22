import type { FileKind } from "./types.js";
import { languageOf } from "./lang/registry.js";

// Documentation: conventional top-level docs, anything under a docs tree, and
// prose extensions. (Same heuristics ultradoc uses to feed its `docs` source.)
const DOC_BASENAME =
  /^(readme|changelog|contributing|history|news|authors|notice|security|code_of_conduct|faq|getting[-_]?started|usage|guide|tutorial)\b/i;
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);
const DOC_DIR = /^(docs?|documentation|wiki|guides?|website|site|book)\//i;

// Manifests / config that reveal the stack, deps, scripts and entry points.
const CONFIG_BASENAME = new Set([
  "package.json", "pnpm-workspace.yaml", "tsconfig.json", "jsconfig.json", "pyproject.toml",
  "setup.py", "setup.cfg", "requirements.txt", "pipfile", "go.mod", "cargo.toml", "gemfile",
  "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "mix.exs", "pubspec.yaml",
  "build.sbt", "dockerfile", "docker-compose.yml", "docker-compose.yaml", "makefile",
  ".env.example", "manifest.json",
]);
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg"]);

// Markdown extraction only makes sense for actual markdown.
export const MARKDOWN_EXT = new Set([".md", ".mdx"]);

export function isDoc(rel: string, ext: string): boolean {
  const base = rel.split("/").pop()!.toLowerCase();
  return DOC_EXT.has(ext) || DOC_BASENAME.test(base) || DOC_DIR.test(rel);
}

function isConfig(rel: string, ext: string): boolean {
  const base = rel.split("/").pop()!.toLowerCase();
  return CONFIG_BASENAME.has(base) || CONFIG_EXT.has(ext);
}

// A code file is one an extractor (or the language table) recognizes as a
// programming language — not prose, not data/config.
const NON_CODE_LANGS = new Set([
  "markdown", "restructuredtext", "text", "json", "yaml", "toml", "ini", "other",
  "html", "css", "scss",
]);

export function isCode(ext: string): boolean {
  return !NON_CODE_LANGS.has(languageOf(ext));
}

// Classify a walked file. A real code extension ALWAYS wins — a `.ts`/`.tsx`
// file named News.tsx or under docs/ is code, not documentation (otherwise its
// imports are never extracted). After that: docs, then config, then other.
export function classify(rel: string, ext: string): FileKind {
  if (isCode(ext)) return "code";
  if (isDoc(rel, ext)) return "doc";
  if (isConfig(rel, ext)) return "config";
  return "other";
}
