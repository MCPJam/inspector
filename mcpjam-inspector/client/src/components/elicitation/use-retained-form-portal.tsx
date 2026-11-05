import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@mcpjam/design-system/dialog";

/** Move one portal container without remounting its in-flight form subtree. */
export function useRetainedFormPortal(
  slot: HTMLElement | null,
  visible = true,
) {
  const [target] = useState(() => document.createElement("div"));
  const [hasSlot, setHasSlot] = useState(!!slot);
  const [fallbackSlot, setFallbackSlot] = useState<HTMLDivElement | null>(null);
  const destination = visible ? (slot ?? fallbackSlot) : null;
  const focus = useRef<{
    element: HTMLElement;
    selection?: {
      start: number;
      end: number;
      direction: "forward" | "backward" | "none";
    };
  }>(undefined);
  useLayoutEffect(() => {
    if (slot) setHasSlot(true);
  }, [slot]);
  useLayoutEffect(() => {
    destination?.appendChild(target);
    const previous = focus.current;
    if (destination && previous && target.contains(previous.element)) {
      previous.element.focus({ preventScroll: true });
      if (
        previous.selection &&
        (previous.element instanceof HTMLInputElement ||
          previous.element instanceof HTMLTextAreaElement)
      ) {
        const { start, end, direction } = previous.selection;
        previous.element.setSelectionRange(start, end, direction);
      }
    }
    return () => {
      const element = document.activeElement;
      if (element instanceof HTMLElement && target.contains(element)) {
        const textInput =
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement;
        focus.current = {
          element,
          ...(textInput &&
          element.selectionStart !== null &&
          element.selectionEnd !== null
            ? {
                selection: {
                  start: element.selectionStart,
                  end: element.selectionEnd,
                  direction: element.selectionDirection ?? "none",
                },
              }
            : {}),
        };
      }
      target.remove();
    };
  }, [destination, target]);
  const fallback =
    hasSlot && !slot && visible ? (
      <Dialog open>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>App requests information</DialogTitle>
            <DialogDescription>
              Answer or cancel the form to continue.
            </DialogDescription>
          </DialogHeader>
          <div ref={setFallbackSlot} />
        </DialogContent>
      </Dialog>
    ) : null;
  return {
    target,
    ready: !!slot || hasSlot,
    render: (children: ReactNode) => (
      <>
        {fallback}
        {createPortal(children, target)}
      </>
    ),
  };
}
