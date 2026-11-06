/**
 * Jumping to a row: from the execution preview beside the editor, or on
 * arrival from a test run's preview (`?step=`). Opens the row, scrolls it to
 * the centre, flashes it, and on arrival moves keyboard focus to it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { scrollToCaseStep } from "./case-steps-editor";

const JUMP_SCROLL_MS = 60;
const JUMP_HOLD_MS = 1400;
const ARRIVE_SCROLL_MS = 150;
const ARRIVE_HOLD_MS = 1800;
/** Below this width the docked preview covers the editor, so a jump closes it. */
const NARROW_PX = 1024;

const opensRow = (key: string) =>
  key.startsWith("action:") || key.startsWith("check:");

/** The row's own toggle, else its section heading. */
function focusTarget(key: string): HTMLElement | null {
  const toggle = document.querySelector<HTMLElement>(
    `[data-case-step-toggle="${CSS.escape(key)}"]`,
  );
  if (toggle) return toggle;
  return (
    document
      .querySelector(`[data-case-step-anchor="${CSS.escape(key)}"]`)
      ?.querySelector<HTMLElement>("h2") ?? null
  );
}

export function useCaseStepJump({
  onOpenKeyChange,
  onClosePreview,
}: {
  onOpenKeyChange: (key: string | null) => void;
  onClosePreview: () => void;
}) {
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [arriving, setArriving] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );
  const later = (ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  };

  const flash = (key: string, hold: number, isArrival: boolean) => {
    setArriving(isArrival);
    setFlashKey(key);
    later(hold, () => {
      setFlashKey((current) => (current === key ? null : current));
      if (isArrival) setArriving(false);
    });
  };

  /** A click in the editor's own preview. */
  const jumpTo = useCallback(
    (key: string) => {
      if (opensRow(key)) onOpenKeyChange(key);
      if (window.innerWidth < NARROW_PX) onClosePreview();
      flash(key, JUMP_HOLD_MS, false);
      later(JUMP_SCROLL_MS, () => scrollToCaseStep(key));
    },
    [onOpenKeyChange, onClosePreview],
  );

  /** Arrival from a test run at `?step=key`. */
  const arriveAt = useCallback(
    (key: string) => {
      if (opensRow(key)) onOpenKeyChange(key);
      flash(key, ARRIVE_HOLD_MS, true);
      later(ARRIVE_SCROLL_MS, () => {
        scrollToCaseStep(key);
        focusTarget(key)?.focus({ preventScroll: true });
      });
    },
    [onOpenKeyChange],
  );

  return { flashKey, arriving, jumpTo, arriveAt };
}
