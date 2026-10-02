// Splits markdown into independent top-level blocks so a streaming message only re-parses
// its last (growing) block; earlier blocks are memoized by their text.
//
// A split happens only at a blank line where the result renders identically:
//  - never inside a fenced code block or a $$ math block
//  - never before an indented line (it continues the previous block, e.g. a list item)
//  - never between two items of the same list
// Documents with reference-style link or footnote definitions are not split, because those
// resolve across the whole document.

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const DEFINITION = /^ {0,3}\[\^?[^\]]+\]:/m;

export function splitBlocks(md: string): string[] {
  if (DEFINITION.test(md)) return [md];

  const lines = md.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let inMath = false;

  const flush = () => {
    if (current.some((l) => l.trim())) blocks.push(current.join("\n"));
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      current.push(line);
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      current.push(line);
      continue;
    }
    if (line.trim() === "$$") {
      inMath = !inMath;
      current.push(line);
      continue;
    }
    if (inMath || line.trim()) {
      current.push(line);
      continue;
    }

    // Blank line outside code/math: decide whether the next content starts a new block.
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = lines[j];
    const firstOfBlock = current.find((l) => l.trim());
    const continues =
      next === undefined ||
      /^[ \t]/.test(next) ||
      (firstOfBlock !== undefined && LIST_ITEM.test(firstOfBlock) && LIST_ITEM.test(next));
    current.push(line);
    if (!continues) flush();
  }
  flush();
  return blocks.length ? blocks : [md];
}
