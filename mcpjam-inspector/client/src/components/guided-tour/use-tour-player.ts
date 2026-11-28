import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "framer-motion";
import {
  TourCancelled,
  createTourDriver,
  type TourDriver,
  type TourRun,
} from "./driver";
import type { GhostCursorHandle } from "./ghost-cursor";
import { rectCenter, rectWithin } from "./geometry";

export type TourScript = (driver: TourDriver) => Promise<void>;

/**
 * Plays transition scripts with the ghost cursor inside `rootRef`. Starting
 * a script cancels the one in flight; `cancel` (skip, unmount) stops it at
 * its next step. Each run gets its own token, so cancelling one never
 * poisons the next (StrictMode's dev remount included).
 */
export function useTourPlayer(
  rootRef: RefObject<HTMLElement | null>,
  cursorRef: RefObject<GhostCursorHandle | null>,
) {
  const runRef = useRef<TourRun | null>(null);
  const reducedMotion = useReducedMotion() ?? false;

  const cancel = useCallback(() => {
    if (runRef.current) runRef.current.cancelled = true;
    runRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const play = useCallback(
    async (origin: HTMLElement, script: TourScript) => {
      const root = rootRef.current;
      const cursor = cursorRef.current;
      if (!root || !cursor) return;
      cancel();
      const run: TourRun = { cancelled: false };
      runRef.current = run;
      const driver = createTourDriver({ root, cursor, run, reducedMotion });
      if (!reducedMotion) cursor.show(rectCenter(rectWithin(root, origin)));
      try {
        await script(driver);
      } catch (error) {
        if (!(error instanceof TourCancelled)) throw error;
        // The tour closed mid-transition; the overlay is already gone.
      } finally {
        cursor.hide();
      }
    },
    [rootRef, cursorRef, reducedMotion, cancel],
  );

  return { play, cancel, reducedMotion };
}
