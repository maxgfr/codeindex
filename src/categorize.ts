// Nine-way file categorization (ported from reconstruct): a coarser, purpose-
// oriented view than classify()'s FileKind — "what role does this file play in
// the project" rather than "how should the indexer parse it". Pure path/ext
// logic; consumers call it themselves (it is not stamped on FileRecord).
import { basename } from "node:path";

export type FileCategory =
  | "code"
  | "test"
  | "config"
  | "schema"
  | "i18n"
  | "doc"
  | "style"
  | "asset"
  | "data"
  | "other";

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".php", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".cs", ".swift", ".scala", ".clj", ".ex", ".exs", ".dart", ".lua", ".sh", ".bash", ".zig", ".elm",
]);
const STYLE_EXTS = new Set([".css", ".scss", ".sass", ".less", ".styl", ".pcss"]);
const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);
const DATA_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".csv", ".xml", ".env"]);
const ASSET_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tiff", ".svg", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".avi", ".webm",
]);

const I18N_DIRS = ["locales", "locale", "i18n", "lang", "langs", "translations", "messages"];
const I18N_EXTS = new Set([".json", ".yaml", ".yml", ".po", ".properties"]);
const TEST_DIRS = ["__tests__", "test", "tests", "spec", "e2e", "__mocks__"];
const SCHEMA_DIRS = ["migrations", "entities", "models"];

const CONFIG_BASES = new Set([
  "package.json", "tsconfig.json", "dockerfile", "makefile", "pyproject.toml", "cargo.toml",
  "go.mod", "requirements.txt", "gemfile", "composer.json", "pubspec.yaml",
]);

export function categorize(rel: string, ext: string): FileCategory {
  const lower = rel.toLowerCase();
  const base = basename(lower);
  const segments = lower.split("/");
  const inDir = (names: readonly string[]): boolean => names.some((n) => segments.includes(n));

  if (inDir(I18N_DIRS) && I18N_EXTS.has(ext)) return "i18n";
  if (
    ext === ".prisma" || ext === ".sql" || ext === ".graphql" || ext === ".gql" ||
    base.startsWith("schema.") || base === "models.py" || inDir(SCHEMA_DIRS)
  ) {
    return "schema";
  }
  if (lower.includes(".test.") || lower.includes(".spec.") || inDir(TEST_DIRS)) return "test";
  if (
    CONFIG_BASES.has(base) ||
    base.endsWith(".config.js") || base.endsWith(".config.ts") || base.endsWith(".config.mjs") ||
    base.startsWith(".eslintrc") || base.startsWith(".prettierrc") || base.startsWith(".env") ||
    base.startsWith("docker-compose")
  ) {
    return "config";
  }
  if (DOC_EXTS.has(ext)) return "doc";
  if (STYLE_EXTS.has(ext)) return "style";
  if (CODE_EXTS.has(ext)) return "code";
  if (ASSET_EXTS.has(ext)) return "asset";
  if (DATA_EXTS.has(ext)) return "data";
  return "other";
}
