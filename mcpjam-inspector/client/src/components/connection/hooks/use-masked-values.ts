import { useState } from "react";

/**
 * Per-row show/hide state for a list of secret-ish values (env vars, headers).
 *
 * Values render masked so an API key isn't sitting in cleartext for anyone
 * looking at the screen. This is shoulder-surfing cover, not access control:
 * by the time a row exists its value is already in the form, so toggling is
 * pure client state — the eye never costs a round-trip.
 *
 * Rows are masked unless a row's own eye says otherwise, including the rows a
 * stored-secret fetch brings back — opening a section is a request to see what
 * is configured, not to read the secrets.
 */
export function useMaskedValues() {
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});

  const isVisible = (index: number) => overrides[index] ?? false;

  const toggle = (index: number) => {
    setOverrides((prev) => ({
      ...prev,
      [index]: !(prev[index] ?? false),
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

  return { isVisible, toggle, markAdded, dropAt };
}
