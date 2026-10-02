// Theme guardrails: every theme defines every color token, and text stays readable (WCAG AA).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { THEME_COLOR, THEMES } from "../lib/settingsModel.ts";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(selectorStart: string): Record<string, string> {
  const at = css.indexOf(selectorStart);
  assert.ok(at >= 0, `missing ${selectorStart}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const dark = block(':root,\n[data-theme="dark"]');
const themes: Record<string, Record<string, string>> = {
  dark,
  black: { ...dark, ...block('[data-theme="black"]') }, // black overrides dark selectively
  light: block('[data-theme="light"]'),
};

function luminance(hex: string) {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

test("White + Gold defines every color token the dark theme defines", () => {
  const missing = Object.keys(dark).filter((k) => !(k in themes.light));
  assert.deepEqual(missing, []);
});

test("every theme in settings has a CSS theme and a browser color", () => {
  for (const t of THEMES) {
    assert.ok(themes[t], `no CSS for ${t}`);
    assert.equal(THEME_COLOR[t].toLowerCase(), themes[t]["--bg-app"].toLowerCase(), `${t} THEME_COLOR must match --bg-app`);
  }
});

const SURFACES = ["--bg-app", "--bg-sidebar", "--bg-surface", "--bg-elevated", "--bg-input", "--bg-user-msg"];
const TEXT = ["--text-primary", "--text-secondary", "--text-tertiary", "--accent-text", "--danger"];
const SYNTAX = ["--hl-comment", "--hl-keyword", "--hl-string", "--hl-number", "--hl-title", "--hl-type", "--hl-attr", "--hl-tag", "--hl-meta"];

for (const [name, t] of Object.entries(themes)) {
  test(`${name}: text tokens are >= 4.5:1 on every surface`, () => {
    for (const fg of TEXT)
      for (const bg of SURFACES) {
        if (!isHex(t[fg]) || !isHex(t[bg])) continue;
        const r = contrast(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${name} ${fg} on ${bg} = ${r.toFixed(2)}`);
      }
  });
  test(`${name}: syntax colors are >= 4.5:1 on the code background`, () => {
    for (const fg of SYNTAX) assert.ok(contrast(t[fg], t["--bg-code"]) >= 4.5, `${name} ${fg} = ${contrast(t[fg], t["--bg-code"]).toFixed(2)}`);
  });
  test(`${name}: buttons and tooltips are readable`, () => {
    assert.ok(contrast(t["--btn-primary-fg"], t["--btn-primary-bg"]) >= 4.5, "primary button");
    assert.ok(contrast(t["--danger-contrast"], t["--danger"]) >= 4.5, "danger button");
    assert.ok(contrast(t["--fg-tooltip"], t["--bg-tooltip"]) >= 4.5, "tooltip");
  });
}

test("light theme keeps gold as an accent, not a surface", () => {
  for (const bg of SURFACES) assert.ok(luminance(themes.light[bg]) > 0.85, `${bg} should be white/warm-gray`);
});
