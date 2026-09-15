import { useCallback, useEffect, useRef, useState } from "react";

function readStoredString(key: string, defaultValue: string): string {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null || raw.trim() === "") return defaultValue;
    return raw;
  } catch {
    // Private mode or quota — fall back to default.
  }
  return defaultValue;
}

/** String preference mirrored to localStorage. */
export function usePersistedString(
  key: string,
  defaultValue: string,
): [string, (next: string | ((prev: string) => string)) => void] {
  const [value, setValue] = useState(() =>
    readStoredString(key, defaultValue),
  );

  // The updater stays pure — persisting inside it would let a StrictMode
  // replay or an interrupted concurrent render write a preference the UI
  // never committed. Mirror the COMMITTED value instead.
  const setPersisted = useCallback(
    (next: string | ((prev: string) => string)) => {
      setValue((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  // Mirror only what actually CHANGED after a commit.
  //
  // Tracking the key alone is not enough: the app mounts under `<StrictMode>`,
  // which runs this effect, tears it down, and runs it again on the same
  // mount. The second run already sees the key as hydrated, so a key-only
  // guard falls through and writes the value that was just read out of
  // storage. Remembering the committed `(key, value)` pair makes that replay a
  // no-op, because neither half moved.
  const lastCommitted = useRef<{ key: string; value: string } | null>(null);
  useEffect(() => {
    const last = lastCommitted.current;
    // First commit under this key — `value` came out of storage under it, so
    // there is nothing new to write back.
    if (last === null || last.key !== key) {
      lastCommitted.current = { key, value };
      return;
    }
    // Unchanged: a StrictMode replay, or a re-render that did not touch us.
    if (last.value === value) return;
    lastCommitted.current = { key, value };
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Private mode or quota — in-memory state still wins.
    }
  }, [key, value]);

  return [value, setPersisted];
}
