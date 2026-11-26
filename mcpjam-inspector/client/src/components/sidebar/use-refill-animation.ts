import { useEffect, useLayoutEffect, useRef, useState } from "react";

function readLastSeen(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    // Storage is unavailable (private mode, blocked). Treat it as first use, so no animation.
    return null;
  }
}

function writeLastSeen(storageKey: string, value: number) {
  try {
    localStorage.setItem(storageKey, String(value));
  } catch {
    // Storage is unavailable (private mode, quota). The bar just skips the animation.
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * True for the first frames after a meter opens with more left than the user
 * last saw, so the bar can start empty and fill in from the left.
 */
export function useRefillAnimation(
  storageKey: string | null,
  remaining: number | null,
): boolean {
  const [filling, setFilling] = useState(false);
  // Compare once per key, on the first loaded value, so a card opened while
  // its meter is still loading still gets the refill.
  const comparedKey = useRef<string | null>(null);

  // Layout effect: the bar must be empty before the first paint, or it flashes full.
  useLayoutEffect(() => {
    if (!storageKey || remaining === null) return;
    if (comparedKey.current !== storageKey) {
      comparedKey.current = storageKey;
      const lastSeen = readLastSeen(storageKey);
      if (!prefersReducedMotion() && lastSeen !== null && remaining > lastSeen) {
        setFilling(true);
      }
    }
    writeLastSeen(storageKey, remaining);
  }, [storageKey, remaining]);

  useEffect(() => {
    if (!filling) return;
    // Two frames: the empty bar has to paint once for the fill to transition.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setFilling(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [filling]);

  return filling;
}
