// Loaded on demand (see renderers.ts): lowlight + a curated set of highlight.js grammars.
// Output is a hast tree rendered as React elements — no HTML strings.
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { Root } from "hast";

const lowlight = createLowlight({ bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, markdown, php, python, ruby, rust, shell, sql, swift, typescript, xml, yaml });

lowlight.registerAlias({
  bash: ["sh", "zsh", "shellscript"],
  shell: ["console", "shellsession", "terminal"],
  cpp: ["c++", "cc", "hpp", "cxx"],
  csharp: ["cs", "c#", "dotnet"],
  javascript: ["js", "jsx", "mjs", "cjs", "node"],
  typescript: ["ts", "tsx", "mts", "cts"],
  xml: ["html", "htm", "svg", "xhtml", "vue"],
  python: ["py", "py3", "python3"],
  markdown: ["md", "mdx"],
  go: ["golang"],
  rust: ["rs"],
  yaml: ["yml"],
  json: ["jsonc", "json5"],
  kotlin: ["kt"],
  ruby: ["rb"],
  sql: ["postgres", "postgresql", "mysql", "sqlite", "plsql"],
});

/** Highlights code in a known language; returns null for unknown/unlabelled languages. */
export function highlight(code: string, lang: string): Root | null {
  const name = lang.toLowerCase();
  if (!name || !lowlight.registered(name)) return null;
  try {
    return lowlight.highlight(name, code);
  } catch {
    return null;
  }
}
