import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "../Icon";
import "./ui.css";

/**
 * Native <dialog> wrapper: gives a real modal with focus containment and Escape-to-close.
 * Initial focus goes to the element marked `data-autofocus` (React's autoFocus runs before
 * showModal(), which would otherwise move focus to the first focusable element).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(); // backdrop click
      }}
    >
      {open && (
        <div className="dialog-inner">
          <header className="dialog-header">
            <div>
              <h2 id={titleId} className="dialog-title">
                {title}
              </h2>
              {description && <p className="dialog-desc">{description}</p>}
            </div>
            <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
              <Icon name="x" />
            </button>
          </header>
          {children && <div className="dialog-body">{children}</div>}
          {footer && <footer className="dialog-footer">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
}

const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    setOptions(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!options}
        onClose={() => settle(false)}
        title={options?.title ?? ""}
        description={options?.message}
        className="dialog-sm"
        footer={
          <>
            {/* Destructive confirms start on Cancel so a stray Enter can't delete anything. */}
            <button type="button" className="btn btn-ghost" data-autofocus={options?.danger ? "" : undefined} onClick={() => settle(false)}>
              Cancel
            </button>
            <button type="button" data-autofocus={options?.danger ? undefined : ""} className={`btn ${options?.danger ? "btn-danger" : "btn-primary"}`} onClick={() => settle(true)}>
              {options?.confirmLabel}
            </button>
          </>
        }
      />
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside ConfirmProvider");
  return ctx;
}
