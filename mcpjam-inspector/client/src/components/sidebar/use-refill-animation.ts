import { useEffect, useState } from "react";

function readLastSeen(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
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

/**
 * True for the first frames after a meter opens with more left than the user
 * last saw, so the bar can start empty and fill in from the left.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useRefillAnimation(
  storageKey: string | null,
  remaining: number | null,
): boolean {
  const [filling, setFilling] = useState(() => {
    if (!storageKey || remaining === null || prefersReducedMotion()) {
      return false;
    }
    const lastSeen = readLastSeen(storageKey);
    return lastSeen !== null && remaining > lastSeen;
  });

  useEffect(() => {
    if (storageKey && remaining !== null) writeLastSeen(storageKey, remaining);
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
