import type { CodeSymbol } from "../types.js";
import { scan, type Lexis, type Rule } from "./common.js";

// Elixir. Modules and def/defp/defmacro. `defp` is private (not exported).
const RULES: Rule[] = [
  { re: /^\s*defmodule\s+(?<name>[\w.]+)/, kind: "module", exported: true },
  { re: /^\s*defp\s+(?<name>[\w?!]+)/, kind: "function", exported: false },
  { re: /^\s*def\s+(?<name>[\w?!]+)/, kind: "function", exported: true },
  { re: /^\s*defmacrop?\s+(?<name>[\w?!]+)/, kind: "macro", exported: true },
];

export const elixir = {
  lang: "elixir",
  exts: [".ex", ".exs"],
  lexis: {
    comment: /^\s*#/,
    decoration: /^\s*@(?!(?:doc|moduledoc|typedoc)\b)\w+/,
    docAttr: true,
  } satisfies Lexis,
  extract(rel: string, content: string): CodeSymbol[] {
    return scan(rel, content, "elixir", RULES);
  },
};
