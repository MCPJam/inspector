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

function shouldRefill(storageKey: string, remaining: number): boolean {
  const lastSeen = readLastSeen(storageKey);
  return !prefersReducedMotion() && lastSeen !== null && remaining > lastSeen;
}

export const REFILL_HOLD_MS = 250;

/**
 * True for the first moments after a meter opens with more left than the user
 * last saw, so the bar can start empty and fill in from the left.
 */
export function useRefillAnimation(
  storageKey: string | null,
  remaining: number | null,
): boolean {
  // Compare once per key, on the first loaded value, so a card opened while
  // its meter is still loading still gets the refill.
  const comparedKey = useRef<string | null>(null);
  // Decide on the first render: a bar that mounts full and is then emptied
  // visibly drains before it refills.
  const [filling, setFilling] = useState(() => {
    if (!storageKey || remaining === null) return false;
    comparedKey.current = storageKey;
    return shouldRefill(storageKey, remaining);
  });

  // Layout effect: the bar must be empty before the first paint, or it flashes full.
  useLayoutEffect(() => {
    if (!storageKey || remaining === null) return;
    if (comparedKey.current !== storageKey) {
      comparedKey.current = storageKey;
      if (shouldRefill(storageKey, remaining)) setFilling(true);
    }
    writeLastSeen(storageKey, remaining);
  }, [storageKey, remaining]);

  useEffect(() => {
    if (!filling) return;
    // Hold the empty bar until the card has faded in, or the fill plays unseen.
    const timer = setTimeout(() => setFilling(false), REFILL_HOLD_MS);
    return () => clearTimeout(timer);
  }, [filling]);

  return filling;
}
