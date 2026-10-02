import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { uid } from "../lib/util";
import "../components/Toast.css";

type Tone = "neutral" | "success" | "error";
interface Toast {
  id: string;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const regionRef = useRef<HTMLDivElement>(null);

  const dismiss = useCallback((id: string) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (message: string, tone: Tone = "neutral") => {
      const id = uid();
      setToasts((t) => [...t.slice(-2), { id, message, tone }]);
      setAnnouncement(message);
      setTimeout(() => dismiss(id), tone === "error" ? 6000 : 2800);
    },
    [dismiss],
  );

  // The region is a manual popover so it renders in the top layer. Re-showing it on every
  // change moves it above any modal <dialog> that opened since (top layer is ordered by insertion).
  useLayoutEffect(() => {
    const el = regionRef.current;
    if (!el || typeof el.showPopover !== "function") return;
    const open = el.matches(":popover-open");
    if (open) el.hidePopover();
    if (toasts.length) el.showPopover();
  }, [toasts]);

  const value = useMemo(() => toast, [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div ref={regionRef} popover="manual" className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === "error" ? "alert" : t.tone === "success" ? "check" : "info"} size={16} />
            <span>{t.message}</span>
            <button className="icon-btn icon-btn-sm" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
      {/* Always-mounted live region: content inserted into a just-shown element is often not announced. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
