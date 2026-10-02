// Lazy loaders for the heavy rendering features, so the main bundle stays small:
// syntax highlighting loads with the first code block, KaTeX with the first formula.
import { useEffect, useState } from "react";
import type { PluggableList } from "unified";

type Highlight = typeof import("./highlighter").highlight;

let highlightFn: Highlight | null = null;
let highlightLoad: Promise<Highlight> | null = null;

function loadHighlighter(): Promise<Highlight> {
  highlightLoad ??= import("./highlighter").then((m) => (highlightFn = m.highlight));
  return highlightLoad;
}

export interface MathPlugins {
  remark: PluggableList;
  rehype: PluggableList;
}

let mathPlugins: MathPlugins | null = null;
let mathLoad: Promise<MathPlugins> | null = null;

function loadMath(): Promise<MathPlugins> {
  mathLoad ??= Promise.all([import("remark-math"), import("rehype-katex"), import("katex/dist/katex.min.css")]).then(([remarkMath, rehypeKatex]) => {
    mathPlugins = {
      // Single-$ math is pre-converted with Pandoc rules in mathText.ts, so a lone $ is text.
      remark: [[remarkMath.default, { singleDollarTextMath: false }]],
      rehype: [
        [
          rehypeKatex.default,
          // trust:false blocks \href, \url, \includegraphics and \html* commands; maxExpand bounds macro blow-ups.
          { throwOnError: false, strict: "ignore", trust: false, maxExpand: 500, maxSize: 20, errorColor: "var(--danger)" },
        ],
      ],
    };
    return mathPlugins;
  });
  return mathLoad;
}

/**
 * Warm both chunks when a response starts: NIM takes >= 1s to send the first token, so math and
 * code render formatted from the first frame instead of flashing raw delimiters once per page load.
 */
export function preloadRenderers() {
  void loadMath().catch(() => {});
  void loadHighlighter().catch(() => {});
}

/** Returns the loader result once available; triggers loading when `needed` becomes true. */
function useLazy<T>(needed: boolean, get: () => T | null, load: () => Promise<T>): T | null {
  const [value, setValue] = useState<T | null>(get);
  useEffect(() => {
    if (!needed || value) return;
    let alive = true;
    load()
      .then((v) => alive && setValue(() => v))
      .catch((err) => console.error("Failed to load renderer:", err));
    return () => {
      alive = false;
    };
  }, [needed, value, load]);
  return value;
}

export const useHighlighter = (needed: boolean) => useLazy(needed, () => highlightFn, loadHighlighter);
export const useMathPlugins = (needed: boolean) => useLazy(needed, () => mathPlugins, loadMath);
