// Normalizes the math delimiters models emit into the `$$` syntax remark-math parses
// (configured with singleDollarTextMath: false, so a lone `$` is never math):
//
//   \( x \)            -> $$x$$                (inline)
//   \[ x \]            -> $$ block             (when alone on its line(s)), else inline $$x$$
//   $x$                -> $$x$$                (Pandoc rules, so "$5 and $10" stays text)
//
// Code (fenced blocks and inline spans) is never touched. Unclosed math is hidden while
// streaming (it will render once closed) and shown literally once the message is final.

interface Segment {
  code: boolean;
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Splits markdown into prose and code segments (fenced blocks and inline code spans). */
export function splitCode(md: string): Segment[] {
  const out: Segment[] = [];
  const push = (code: boolean, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.code === code) last.text += text;
    else out.push({ code, text });
  };

  const lines = md.split(/(?<=\n)/);
  let prose = "";
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) {
      prose += lines[i];
      continue;
    }
    splitInlineCode(prose, push);
    prose = "";
    const marker = open[1];
    let block = lines[i];
    let j = i + 1;
    for (; j < lines.length; j++) {
      block += lines[j];
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) break;
    }
    push(true, block); // an unclosed fence runs to the end, as in CommonMark
    i = j;
  }
  splitInlineCode(prose, push);
  return out;
}

function splitInlineCode(text: string, push: (code: boolean, text: string) => void) {
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    if (tick < 0) break;
    let run = tick;
    while (text[run] === "`") run++;
    const ticks = text.slice(tick, run);
    // Closing run of exactly the same length, not crossing a blank line.
    const re = new RegExp(`(?<!\`)${ticks}(?!\`)`, "g");
    re.lastIndex = run;
    const close = re.exec(text);
    if (!close || /\n\s*\n/.test(text.slice(run, close.index))) {
      push(false, text.slice(i, run));
      i = run;
      continue;
    }
    push(false, text.slice(i, tick));
    push(true, text.slice(tick, close.index + ticks.length));
    i = close.index + ticks.length;
  }
  push(false, text.slice(i));
}

/** \[ … \]: block math when it occupies whole lines, inline otherwise. */
function convertDisplay(text: string): string {
  return text.replace(/\\\[([\s\S]+?)\\\]/g, (match, body: string, offset: number) => {
    const inner = body.trim();
    if (!inner) return match;
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lead = text.slice(lineStart, offset);
    const end = offset + match.length;
    const lineEnd = text.indexOf("\n", end);
    const trail = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
    // Whole-line \[ … \] → block. The lead is already in the output before the match; content and
    // closing fence get the same indentation so the block stays inside a list item.
    if (!lead.trim() && !trail.trim()) return `$$\n${inner.replace(/^/gm, lead)}\n${lead}$$`;
    return `$$${inner.replace(/\s*\n\s*/g, " ")}$$`;
  });
}

function convertInlineParens(text: string): string {
  return text.replace(/\\\(([\s\S]+?)\\\)/g, (match, body: string) => (body.trim() ? `$$${body.trim()}$$` : match));
}

/**
 * Pandoc: opening $ followed by non-space; closing $ preceded by non-space and not followed by a
 * digit. The body never contains `$`, including its last character, or it could close on the
 * second `$` of an adjacent `$$…$$` (e.g. "$10. Inline $$x$$").
 */
function convertSingleDollar(text: string): string {
  return text.replace(/(?<![\\$])\$(?!\$)(?=\S)([^\n$]*?[^\s$])(?<!\\)\$(?![\d$])/g, (_m, body: string) => `$$${body}$$`);
}

/** Positions of unescaped `$$` tokens in prose. */
function dollarPairs(text: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "$" && text[i + 1] === "$" && text[i - 1] !== "\\") {
      at.push(i);
      i++;
    }
  }
  return at;
}

export function normalizeMath(md: string, streaming = false): string {
  if (!/[$\\]/.test(md)) return md; // fast path: no possible math
  const segments = splitCode(md).map((s) => (s.code ? s : { code: false, text: convertSingleDollar(convertInlineParens(convertDisplay(s.text))) }));

  // Handle an unbalanced trailing `$$` (or an unclosed `\[` while streaming) in the last prose segment.
  const lastProse = [...segments].reverse().find((s) => !s.code);
  if (lastProse) {
    const total = segments.filter((s) => !s.code).reduce((n, s) => n + dollarPairs(s.text).length, 0);
    if (total % 2 === 1) {
      const positions = dollarPairs(lastProse.text);
      const cut = positions[positions.length - 1];
      if (cut !== undefined) {
        lastProse.text = streaming ? lastProse.text.slice(0, cut) : `${lastProse.text.slice(0, cut)}\\$\\$${lastProse.text.slice(cut + 2)}`;
      }
    }
    if (streaming) {
      const openBracket = lastProse.text.lastIndexOf("\\[");
      if (openBracket >= 0 && lastProse.text.indexOf("\\]", openBracket) < 0) lastProse.text = lastProse.text.slice(0, openBracket);
    }
  }
  return segments.map((s) => s.text).join("");
}

/** True when the (normalized) text contains math that remark-math would parse. */
export function containsMath(normalized: string): boolean {
  return splitCode(normalized).some((s) => !s.code && dollarPairs(s.text).length >= 2);
}
