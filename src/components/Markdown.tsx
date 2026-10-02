import { Fragment, isValidElement, memo, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { splitBlocks } from "../lib/markdownBlocks";
import { containsMath, normalizeMath } from "../lib/mathText";
import { useHighlighter, useMathPlugins, type MathPlugins } from "../lib/renderers";
import { copyText } from "../lib/util";
import { ErrorBoundary } from "./ErrorBoundary";
import { Icon } from "./Icon";
import "./Markdown.css";

// Safety: react-markdown does not render raw HTML from model output (no rehype-raw), links are
// filtered by its default URL transform (no javascript:), KaTeX runs with trust:false, and code
// highlighting produces element trees rather than HTML strings. There is no innerHTML path.

const MAX_HIGHLIGHT_CHARS = 60_000;

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const canHighlight = !!lang && code.length <= MAX_HIGHLIGHT_CHARS;
  const highlight = useHighlighter(canHighlight);
  // While streaming, highlighting may lag a frame behind instead of blocking input.
  const deferred = useDeferredValue(code);
  const highlighted = useMemo(() => {
    const tree = canHighlight && highlight ? highlight(deferred, lang) : null;
    return tree ? toJsxRuntime(tree, { Fragment, jsx, jsxs }) : null;
  }, [canHighlight, highlight, deferred, lang]);

  return (
    <div className={`code-block${wrap ? " is-wrapped" : ""}`}>
      <div className="code-head">
        <span className="code-lang">{lang || "text"}</span>
        <div className="code-actions">
          <button type="button" className="code-btn" aria-pressed={wrap} aria-label="Wrap long lines" onClick={() => setWrap((w) => !w)}>
            <Icon name="wrap" size={14} />
            <span className="code-btn-label">Wrap</span>
          </button>
          <button
            type="button"
            className="code-btn"
            aria-label={copied ? "Copied" : "Copy code"}
            onClick={async () => {
              if (await copyText(code)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }
            }}
          >
            <Icon name={copied ? "check" : "copy"} size={14} />
            <span className="code-btn-label">{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>
      <pre tabIndex={0} aria-label={`${lang || "Plain text"} code`}>
        <code className={highlighted ? `hljs language-${lang}` : undefined}>{highlighted ?? code}</code>
      </pre>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

const components: Components = {
  pre({ children }) {
    const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
    const lang = /language-([\w+#.-]+)/.exec(code?.props.className ?? "")?.[1] ?? "";
    return <CodeBlock lang={lang} code={textOf(code?.props.children ?? children).replace(/\n$/, "")} />;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="md-table" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
};

const BASE_REMARK: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

/** One top-level block. Memoized: while streaming, only the last block's text changes. */
const MarkdownBlock = memo(function MarkdownBlock({ text, math }: { text: string; math: MathPlugins | null }) {
  return (
    <ReactMarkdown remarkPlugins={math ? [...BASE_REMARK, ...math.remark] : BASE_REMARK} rehypePlugins={math?.rehype} components={components}>
      {text}
    </ReactMarkdown>
  );
});

function RawFallback({ text }: { text: string }) {
  return (
    <div className="md-fallback">
      <p className="md-fallback-note">
        <Icon name="alert" size={14} /> This response couldn't be formatted, so it's shown as plain text.
      </p>
      <pre>{text}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const normalized = useMemo(() => normalizeMath(text, streaming), [text, streaming]);
  const needsMath = useMemo(() => containsMath(normalized), [normalized]);
  const math = useMathPlugins(needsMath);
  const blocks = useMemo(() => splitBlocks(normalized), [normalized]);

  return (
    <div className={`md${streaming ? " is-streaming" : ""}`}>
      <ErrorBoundary resetKey={text} fallback={() => <RawFallback text={text} />}>
        {blocks.map((block, i) => (
          <MarkdownBlock key={i} text={block} math={needsMath ? math : null} />
        ))}
      </ErrorBoundary>
    </div>
  );
});
