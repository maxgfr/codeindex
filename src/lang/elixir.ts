import type { CodeSymbol } from "../types.js";
import { scan, type Lexis, type Rule } from "./common.js";

// Elixir. Modules and def/defp/defmacro/defguard. The `p` forms are private
// (not exported). A guarded head (`def f(x) when …`) needs no rule of its own:
// the name comes before the guard.
const RULES: Rule[] = [
  { re: /^\s*defmodule\s+(?<name>[\w.]+)/, kind: "module", exported: true },
  { re: /^\s*defp\s+(?<name>[\w?!]+)/, kind: "function", exported: false },
  { re: /^\s*def\s+(?<name>[\w?!]+)/, kind: "function", exported: true },
  { re: /^\s*defmacrop\s+(?<name>[\w?!]+)/, kind: "macro", exported: false },
  { re: /^\s*defmacro\s+(?<name>[\w?!]+)/, kind: "macro", exported: true },
  { re: /^\s*defguardp\s+(?<name>[\w?!]+)/, kind: "guard", exported: false },
  { re: /^\s*defguard\s+(?<name>[\w?!]+)/, kind: "guard", exported: true },
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
