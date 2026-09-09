import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";

/**
 * A tiny click-to-toggle menu. Radix dropdowns need pointer/user events that
 * the inspector's existing fireEvent tests do not send; this keeps the same
 * visual pattern without that dependency.
 */
export function ActionMenu({
  triggerLabel,
  triggerTitle,
  trigger,
  align = "start",
  children,
}: {
  triggerLabel: string;
  triggerTitle?: string;
  trigger: ReactNode;
  align?: "start" | "end";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        title={triggerTitle ?? triggerLabel}
        aria-label={triggerLabel}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </Button>
      {open ? (
        <div
          role="menu"
          className={
            align === "end"
              ? "absolute right-0 z-20 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 shadow-md"
              : "absolute left-0 z-20 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 shadow-md"
          }
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function ActionMenuItem({
  children,
  onSelect,
}: {
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full cursor-pointer rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent"
      onClick={onSelect}
    >
      {children}
    </button>
  );
}
