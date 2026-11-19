import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** The anchor side a coachmark sits on. */
export type CoachmarkPlacement = "bottom" | "right" | "top";

export type TourRect = { x: number; y: number; width: number; height: number };
export type TourPoint = { x: number; y: number };
export type TourSize = { width: number; height: number };

/** Frames to keep looking for an anchor that has not rendered yet. */
const ANCHOR_SEARCH_FRAMES = 90;

export function findAnchor(
  scope: ParentNode,
  name: string,
): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-tour-anchor="${name}"]`);
}

/** `el`'s box in `root`'s coordinate space. */
export function rectWithin(root: HTMLElement, el: HTMLElement): TourRect {
  const base = root.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return {
    x: box.left - base.left,
    y: box.top - base.top,
    width: box.width,
    height: box.height,
  };
}

export function rectCenter(rect: TourRect): TourPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * Measures named anchors inside `scope` relative to `root`, and keeps them
 * current through resizes and scrolling. An anchor that has not rendered yet
 * is retried for a short while; after that `settled` turns true so a caller
 * can give up on one that never appears.
 */
export function useAnchorRects(
  rootRef: RefObject<HTMLElement | null>,
  names: readonly string[],
  scope: "root" | "parent" = "root",
): { rects: (TourRect | null)[]; bounds: TourSize; settled: boolean } {
  const key = names.join("|");
  const [state, setState] = useState<{
    rects: (TourRect | null)[];
    bounds: TourSize;
    settled: boolean;
  }>({ rects: [], bounds: { width: 0, height: 0 }, settled: false });

  // Anchors that resize on their own (a form whose rows load late) must
  // re-measure too, not only the pane.
  const watchRef = useRef<ResizeObserver | null>(null);
  const watchedRef = useRef(new Set<HTMLElement>());

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return false;
    const searchIn = scope === "parent" ? (root.parentElement ?? root) : root;
    const rects = key
      ? key.split("|").map((name) => {
          const el = findAnchor(searchIn, name);
          if (el && !watchedRef.current.has(el)) {
            watchedRef.current.add(el);
            watchRef.current?.observe(el);
          }
          return el ? rectWithin(root, el) : null;
        })
      : [];
    setState((prev) => ({
      rects,
      bounds: { width: root.clientWidth, height: root.clientHeight },
      settled: prev.settled,
    }));
    return rects.every(Boolean);
  }, [rootRef, key, scope]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let tries = 0;
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => measure());
    watchRef.current = resize;
    watchedRef.current = new Set();
    setState((prev) => ({ ...prev, settled: false }));
    const search = () => {
      if (measure() || tries >= ANCHOR_SEARCH_FRAMES) {
        setState((prev) => ({ ...prev, settled: true }));
        return;
      }
      tries += 1;
      frame = requestAnimationFrame(search);
    };
    search();
    const observed = scope === "parent" ? (root.parentElement ?? root) : root;
    resize?.observe(observed);
    window.addEventListener("resize", measure);
    observed.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      watchRef.current = null;
      window.removeEventListener("resize", measure);
      observed.removeEventListener("scroll", measure, true);
    };
  }, [rootRef, measure, scope]);

  return state;
}

export type PopoverPlacement = {
  left: number;
  top: number;
  placement: CoachmarkPlacement;
  /** Arrow position along the card edge that faces the anchor, in px. */
  arrow: number;
};

const GAP = 14;
const EDGE = 12;

function fits(
  placement: CoachmarkPlacement,
  anchor: TourRect,
  card: TourSize,
  bounds: TourSize,
): boolean {
  if (placement === "bottom") {
    return anchor.y + anchor.height + GAP + card.height <= bounds.height - EDGE;
  }
  if (placement === "top") return anchor.y - GAP - card.height >= EDGE;
  return anchor.x + anchor.width + GAP + card.width <= bounds.width - EDGE;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Puts a card next to `anchor`: the preferred side when it fits, else the
 * first side that does, else overlapping the anchor's lower edge (a tall
 * anchor in a short pane). A card that prefers the top stays there and
 * overlaps the anchor's upper edge instead, keeping what's below it in view.
 * The card is clamped inside `bounds`.
 */
export function placePopover(
  anchor: TourRect,
  card: TourSize,
  bounds: TourSize,
  preferred: CoachmarkPlacement,
): PopoverPlacement {
  const order: CoachmarkPlacement[] =
    preferred === "top" ? ["top"] : [preferred, "bottom", "right", "top"];
  const placement =
    order.find((side) => fits(side, anchor, card, bounds)) ??
    (preferred === "top" ? "top" : "bottom");
  const center = rectCenter(anchor);

  if (placement === "right") {
    // Point at the anchor's upper part: a tall card or form reads from the top.
    const targetY = anchor.y + Math.min(anchor.height / 2, 60);
    const top = clamp(targetY - 32, EDGE, bounds.height - card.height - EDGE);
    return {
      placement,
      left: anchor.x + anchor.width + GAP,
      top,
      arrow: clamp(targetY - top, 16, card.height - 16),
    };
  }

  const left = clamp(
    center.x - card.width / 2,
    EDGE,
    bounds.width - card.width - EDGE,
  );
  const below = anchor.y + anchor.height + GAP;
  const top =
    placement === "top"
      ? Math.max(EDGE, anchor.y - GAP - card.height)
      : clamp(below, EDGE, bounds.height - card.height - EDGE);
  return {
    placement,
    left,
    top,
    arrow: clamp(center.x - left, 16, card.width - 16),
  };
}
