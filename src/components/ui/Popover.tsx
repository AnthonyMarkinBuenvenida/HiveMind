import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../Icon";
import "./ui.css";

/** Floating panel anchored to an element. Fixed-positioned in a portal so scroll containers never clip it. */
export function Popover({
  open,
  onClose,
  anchorRef,
  align = "start",
  children,
  className = "",
  width,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  align?: "start" | "end";
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const margin = 8;
    const w = panel.offsetWidth;
    const h = panel.scrollHeight;
    const below = window.innerHeight - anchor.bottom - margin;
    const above = anchor.top - margin;
    const openUp = below < Math.min(h, 280) && above > below;
    let left = align === "end" ? anchor.right - w : anchor.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    const maxHeight = Math.max(160, (openUp ? above : below) - 6);
    const top = openUp ? Math.max(margin, anchor.top - 6 - Math.min(h, maxHeight)) : anchor.bottom + 6;
    setPos({ top, left, maxHeight });
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, onClose, anchorRef, place]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={`popover ${className}`}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxHeight, width, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Arrow/Home/End navigation across [role^=menuitem] children. */
export function menuKeyDown(e: KeyboardEvent<HTMLElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'));
  const idx = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  if (e.key === "ArrowDown") next = (idx + 1) % items.length;
  else if (e.key === "ArrowUp") next = (idx - 1 + items.length) % items.length;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next >= 0) {
    e.preventDefault();
    items[next]?.focus();
  }
}

export function focusFirstItem(container: HTMLElement | null, selector = '[role^="menuitem"][aria-checked="true"], [role^="menuitem"]') {
  requestAnimationFrame(() => container?.querySelector<HTMLElement>(selector)?.focus());
}

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
}

/** Icon-button-triggered action menu (rename, delete, export…). */
export function ActionMenu({ label, items, align = "end", triggerClassName = "icon-btn icon-btn-sm" }: { label: string; items: MenuItem[]; align?: "start" | "end"; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open) focusFirstItem(listRef.current);
  }, [open]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Icon name="more" size={16} />
      </button>
      <Popover open={open} onClose={close} anchorRef={anchorRef} align={align} width={184}>
        <div ref={listRef} role="menu" aria-label={label} className="menu" onKeyDown={menuKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`menu-item${item.danger ? " is-danger" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                item.onSelect();
              }}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
