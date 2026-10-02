import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlocks } from "./markdownBlocks.ts";

test("paragraphs and headings split at blank lines", () => {
  assert.deepEqual(splitBlocks("# Title\n\nPara one.\n\nPara two."), ["# Title\n", "Para one.\n", "Para two."]);
});

test("fenced code with blank lines stays one block", () => {
  const md = "Intro\n\n```py\na = 1\n\n\nb = 2\n```\n\nAfter";
  assert.deepEqual(splitBlocks(md), ["Intro\n", "```py\na = 1\n\n\nb = 2\n```\n", "After"]);
});

test("unclosed fence (streaming) keeps the rest together", () => {
  assert.deepEqual(splitBlocks("Intro\n\n```js\nx\n\ny"), ["Intro\n", "```js\nx\n\ny"]);
});

test("math block with blank lines stays one block", () => {
  const md = "$$\na\n\nb\n$$\n\nText";
  assert.deepEqual(splitBlocks(md), ["$$\na\n\nb\n$$\n", "Text"]);
});

test("loose list items stay in one list", () => {
  const md = "1. one\n\n2. two\n\n3. three\n\nAfter";
  assert.deepEqual(splitBlocks(md), ["1. one\n\n2. two\n\n3. three\n", "After"]);
});

test("indented continuation stays with its list item", () => {
  const md = "- item\n\n  continued paragraph\n\n- next\n\nDone";
  assert.deepEqual(splitBlocks(md), ["- item\n\n  continued paragraph\n\n- next\n", "Done"]);
});

test("reference definitions disable splitting", () => {
  const md = "See [docs][1].\n\nMore.\n\n[1]: https://example.com";
  assert.deepEqual(splitBlocks(md), [md]);
});

test("joining the blocks reproduces the source text", () => {
  const md = "# H\n\nA\n\n- x\n- y\n\n```\nc\n\nd\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nEnd\n";
  assert.equal(splitBlocks(md).join("\n"), md);
});
