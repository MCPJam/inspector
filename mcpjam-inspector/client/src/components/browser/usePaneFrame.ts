import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneFrame } from "@/lib/browser-pane/input";

/**
 * The hosted pane's picture, and the last one it received.
 *
 * The pane blanks the picture whenever its stream drops or reopens, so the
 * spinner says a new one is coming. A desktop that paused is different: the
 * drop that announced the pause is the last stream there will be until
 * somebody wakes it, and the last picture is what belongs under the paused
 * state. So the last frame, and its bitmap, outlive the stream that produced
 * it: a newer frame, another browser, or unmounting releases it.
 *
 * This hook owns every bitmap the pane shows. The surface borrows them and
 * never closes one.
 */
export function usePaneFrame(): {
  /** What the stream is showing now; null between streams. */
  frame: PaneFrame | null;
  /** The last frame received, kept across drops for a paused desktop. */
  last: PaneFrame | null;
  /** A new picture. Releases the one it replaces. */
  show: (next: PaneFrame) => void;
  /** The stream dropped or is reopening: keep the last picture, show none. */
  blank: () => void;
  /** Another browser: release the last picture too. */
  forget: () => void;
} {
  const [frame, setFrame] = useState<PaneFrame | null>(null);
  const [last, setLast] = useState<PaneFrame | null>(null);
  const lastRef = useRef<PaneFrame | null>(null);

  // Released at once, not after the commit: React can coalesce two pictures
  // into one render, and a bitmap superseded before it was painted has
  // nobody else to free it.
  const keep = useCallback((next: PaneFrame | null) => {
    const previous = lastRef.current;
    lastRef.current = next;
    if (previous?.bitmap && previous.bitmap !== next?.bitmap)
      previous.bitmap.close();
    setLast(next);
  }, []);

  const show = useCallback(
    (next: PaneFrame) => {
      keep(next);
      setFrame(next);
    },
    [keep],
  );
  const blank = useCallback(() => setFrame(null), []);
  const forget = useCallback(() => {
    keep(null);
    setFrame(null);
  }, [keep]);
  useEffect(
    () => () => {
      lastRef.current?.bitmap?.close();
      lastRef.current = null;
    },
    [],
  );
  return { frame, last, show, blank, forget };
}
