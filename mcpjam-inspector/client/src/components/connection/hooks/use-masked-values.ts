import { useState } from "react";

/**
 * Per-row show/hide state for a list of secret-ish values (env vars, headers).
 *
 * Values render masked so an API key isn't sitting in cleartext for anyone
 * looking at the screen. This is shoulder-surfing cover, not access control:
 * the value is already in the form, so toggling is pure client state — no
 * fetch, no round-trip, no query per open.
 *
 * `defaultVisible` is the baseline for rows we haven't heard about yet;
 * `overrides` holds the per-row eye state on top of it.
 */
export function useMaskedValues() {
  const [defaultVisible, setDefaultVisible] = useState(false);
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});

  const isVisible = (index: number) => overrides[index] ?? defaultVisible;

  const toggle = (index: number) => {
    setOverrides((prev) => ({
      ...prev,
      [index]: !(prev[index] ?? defaultVisible),
    }));
  };

  /** Call when a row is appended: the row you're about to type into starts
   * unmasked, because masking your own keystrokes as you paste a key helps
   * nobody. `index` is the position the new row lands at. */
  const markAdded = (index: number) => {
    setOverrides((prev) => ({ ...prev, [index]: true }));
  };

  /** Call when a row is removed. Rows are keyed by position, so dropping one
   * has to slide every override above it down a slot — otherwise the eye state
   * lands on the wrong row and exposes a value the user had hidden. */
  const dropAt = (index: number) => {
    setOverrides((prev) => {
      const next: Record<number, boolean> = {};
      for (const [key, visible] of Object.entries(prev)) {
        const at = Number(key);
        if (at === index) continue;
        next[at > index ? at - 1 : at] = visible;
      }
      return next;
    });
  };

  /** Call when the user explicitly asks to see stored values (the "Reveal"
   * fetch): the rows that arrive are unmasked, since that click is the ask.
   * Every eye can still put one back. */
  const revealAll = () => {
    setDefaultVisible(true);
    setOverrides({});
  };

  return { isVisible, toggle, markAdded, dropAt, revealAll };
}
