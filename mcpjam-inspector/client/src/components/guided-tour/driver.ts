import type { GhostCursorHandle } from "./ghost-cursor";
import { findAnchor, rectCenter, rectWithin } from "./geometry";

/** Thrown out of a script when the tour closes mid-transition. */
export class TourCancelled extends Error {
  constructor() {
    super("Tour transition cancelled");
    this.name = "TourCancelled";
  }
}

export type TourRun = { cancelled: boolean };

export type TourDriver = {
  /** Glide to the named anchor's center (or a point inside it). */
  moveTo: (anchor: string) => Promise<void>;
  click: () => Promise<void>;
  /** Type `text` one character at a time through `onText`. */
  type: (text: string, onText: (value: string) => void) => Promise<void>;
  pause: (ms: number) => Promise<void>;
  /** Wait for React to paint a screen change before measuring it. */
  settle: () => Promise<void>;
};

const MOVE_MS = 900;
const TYPE_MS = 55;

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * The verbs a transition script uses. Each one checks the run first, so a
 * skip or unmount stops the script at the next step. With reduced motion the
 * cursor never shows and every timing is zero.
 */
export function createTourDriver({
  root,
  cursor,
  run,
  reducedMotion,
}: {
  root: HTMLElement;
  cursor: GhostCursorHandle;
  run: TourRun;
  reducedMotion: boolean;
}): TourDriver {
  const guard = () => {
    if (run.cancelled) throw new TourCancelled();
  };
  const pause = async (ms: number) => {
    guard();
    if (!reducedMotion && ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    guard();
  };

  return {
    pause,
    async settle() {
      guard();
      await frame();
      await frame();
      guard();
    },
    async moveTo(anchor) {
      guard();
      if (reducedMotion) return;
      const el = findAnchor(root, anchor);
      if (!el) return;
      // The previous stop may have scrolled the target out of its pane.
      el.scrollIntoView?.({ block: "nearest" });
      await frame();
      await cursor.moveTo(rectCenter(rectWithin(root, el)), MOVE_MS);
      guard();
    },
    async click() {
      guard();
      if (reducedMotion) return;
      await cursor.click();
      guard();
    },
    async type(text, onText) {
      guard();
      if (reducedMotion) {
        onText(text);
        return;
      }
      for (let i = 1; i <= text.length; i += 1) {
        onText(text.slice(0, i));
        await pause(TYPE_MS);
      }
    },
  };
}
