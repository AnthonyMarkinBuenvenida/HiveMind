import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

// The composer draft lives in its own contexts so typing re-renders only the composer:
// the value context changes per keystroke; the actions context is stable.

interface DraftActions {
  setDraft: (text: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  focusComposer: () => void;
}

const DraftValueContext = createContext<string | null>(null);
const DraftActionsContext = createContext<DraftActions | null>(null);

export function DraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);
  const actions = useMemo(() => ({ setDraft, composerRef, focusComposer }), [focusComposer]);
  return (
    <DraftActionsContext.Provider value={actions}>
      <DraftValueContext.Provider value={draft}>{children}</DraftValueContext.Provider>
    </DraftActionsContext.Provider>
  );
}

/** Stable: setDraft, composerRef, focusComposer. Safe to use anywhere. */
export function useDraftActions() {
  const ctx = useContext(DraftActionsContext);
  if (!ctx) throw new Error("useDraftActions must be used inside DraftProvider");
  return ctx;
}

/** The current draft text. Re-renders on every keystroke — composer only. */
export function useDraftValue() {
  const ctx = useContext(DraftValueContext);
  if (ctx === null) throw new Error("useDraftValue must be used inside DraftProvider");
  return ctx;
}
