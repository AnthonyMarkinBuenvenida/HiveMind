import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { normalizeSettings, THEME_COLOR, type Settings } from "../lib/settingsModel";
import { load, save } from "../lib/storage";

export { GENERATION_DEFAULTS, type Settings } from "../lib/settingsModel";

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(() => normalizeSettings(load<unknown>("settings", {})));

  useEffect(() => {
    save("settings", settings);
  }, [settings]);

  // Display settings are applied as data attributes consumed by tokens.css.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.fontSize = settings.fontSize;
    root.dataset.chatWidth = settings.chatWidth;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[settings.theme]);
  }, [settings.theme, settings.fontSize, settings.chatWidth]);

  const update = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);
  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider");
  return ctx;
}
