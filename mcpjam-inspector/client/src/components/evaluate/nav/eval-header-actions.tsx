import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A page's own buttons in Evaluate's breadcrumb bar. The bar is rendered by
 * `EvaluateTab`, far above the page, so the page portals its buttons into a
 * slot the bar holds instead of threading them up through props.
 */
let slotElement: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setSlotElement(element: HTMLElement | null) {
  if (slotElement === element) return;
  slotElement = element;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readSlot = () => slotElement;
const readNoSlot = () => null;

/** The right end of the breadcrumb bar. Render it inside a `relative` box. */
export function EvalHeaderActionsSlot() {
  return (
    <div
      ref={setSlotElement}
      data-testid="eval-header-actions"
      className="absolute inset-y-0 right-4 flex items-center gap-2 empty:hidden sm:right-6"
    />
  );
}

/** Shows its children in the breadcrumb bar while the bar is mounted. */
export function EvalHeaderActions({ children }: { children: ReactNode }) {
  const target = useSyncExternalStore(subscribe, readSlot, readNoSlot);
  return target ? createPortal(children, target) : null;
}
