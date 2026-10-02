import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settingsModel.ts";

test("saved themes round-trip, including White + Gold", () => {
  for (const theme of ["dark", "black", "light"] as const) {
    const saved = JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, theme }));
    assert.equal(normalizeSettings(saved).theme, theme);
  }
});

test("unknown or corrupted values fall back to defaults field by field", () => {
  const s = normalizeSettings({ theme: "neon", fontSize: 3, temperature: "hot", maxTokens: -5, sendOnEnter: "yes" });
  assert.equal(s.theme, "dark");
  assert.equal(s.fontSize, "medium");
  assert.equal(s.temperature, DEFAULT_SETTINGS.temperature);
  assert.equal(s.maxTokens, 256);
  assert.equal(s.sendOnEnter, true);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("garbage"), DEFAULT_SETTINGS);
});

test("settings saved by older versions keep their values", () => {
  const s = normalizeSettings({ theme: "black", maxTokens: 4096, systemPrompt: "Be brief.", sidebarCollapsed: true });
  assert.equal(s.theme, "black");
  assert.equal(s.maxTokens, 4096);
  assert.equal(s.systemPrompt, "Be brief.");
  assert.equal(s.sidebarCollapsed, true);
});

test("a large max output (50K) is preserved for the UI to clamp per model", () => {
  assert.equal(normalizeSettings({ maxTokens: 50_000 }).maxTokens, 50_000);
});
