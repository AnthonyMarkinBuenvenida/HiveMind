import { test } from "node:test";
import assert from "node:assert/strict";
import { containsMath, normalizeMath, splitCode } from "./mathText.ts";

test("inline \\( \\) becomes $$ $$", () => {
  assert.equal(normalizeMath("Energy \\(E = mc^2\\) here."), "Energy $$E = mc^2$$ here.");
});

test("\\[ \\] alone on lines becomes a display block", () => {
  assert.equal(normalizeMath("Sum:\n\\[\n\\sum_{k=1}^n k\n\\]\nDone."), "Sum:\n$$\n\\sum_{k=1}^n k\n$$\nDone.");
  assert.equal(normalizeMath("\\[ x^2 \\]"), "$$\nx^2\n$$");
});

test("\\[ \\] inside a sentence stays inline", () => {
  assert.equal(normalizeMath("so \\[a+b\\] holds"), "so $$a+b$$ holds");
});

test("display math keeps list indentation", () => {
  assert.equal(normalizeMath("- item\n  \\[ x \\]\n"), "- item\n  $$\n  x\n  $$\n");
});

test("single-dollar math follows Pandoc rules; currency stays text", () => {
  assert.equal(normalizeMath("Let $x^2$ and $\\alpha$."), "Let $$x^2$$ and $$\\alpha$$.");
  assert.equal(normalizeMath("It costs $5 and $10 today."), "It costs $5 and $10 today.");
  assert.equal(normalizeMath("Range $5-$10."), "Range $5-$10.");
  assert.equal(normalizeMath("Escaped \\$ sign and \\$x\\$"), "Escaped \\$ sign and \\$x\\$");
});

test("currency next to converted \\( \\) math stays text (regression: found on the live deployment)", () => {
  assert.equal(normalizeMath("Costs $5 and $10. Inline \\(\\alpha\\), display:"), "Costs $5 and $10. Inline $$\\alpha$$, display:");
  assert.equal(normalizeMath("Pay $3 then $$x$$ more"), "Pay $3 then $$x$$ more");
});

test("existing $$ math is untouched", () => {
  const md = "$$\n\\frac{a}{b}\n$$\nand inline $$x$$";
  assert.equal(normalizeMath(md), md);
});

test("code is never modified", () => {
  const md = "```bash\necho $HOME \\(x\\) $y$\n```\nand `$a$` but $b$";
  assert.equal(normalizeMath(md), "```bash\necho $HOME \\(x\\) $y$\n```\nand `$a$` but $$b$$");
});

test("unclosed fence runs to the end (streaming code block)", () => {
  const md = "text $a$\n```js\nconst s = `$x$`;";
  assert.equal(normalizeMath(md, true), "text $$a$$\n```js\nconst s = `$x$`;");
});

test("streaming: unclosed display math is hidden until closed", () => {
  assert.equal(normalizeMath("Result:\n$$\n\\frac{1}{", true), "Result:\n");
  assert.equal(normalizeMath("Result:\n\\[\n\\frac{1}{", true), "Result:\n");
});

test("final: unclosed $$ is shown literally, not parsed", () => {
  assert.equal(normalizeMath("Broken $$ x + 1", false), "Broken \\$\\$ x + 1");
});

test("matrices and environments survive", () => {
  const out = normalizeMath("\\[\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n\\]");
  assert.equal(out, "$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$");
});

test("containsMath ignores code", () => {
  assert.equal(containsMath("`$$x$$`"), false);
  assert.equal(containsMath("see $$x$$"), true);
  assert.equal(containsMath("plain text"), false);
});

test("splitCode handles inline code with multiple backticks", () => {
  const segs = splitCode("a ``code ` here`` b");
  assert.deepEqual(segs, [
    { code: false, text: "a " },
    { code: true, text: "``code ` here``" },
    { code: false, text: " b" },
  ]);
});
