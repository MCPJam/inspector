import { useCallback, useEffect, useRef, useState } from "react";

function readStoredBoolean(key: string, defaultValue: boolean): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Private mode or quota — fall back to default.
  }
  return defaultValue;
}

/** Boolean preference mirrored to localStorage. */
export function usePersistedBoolean(
  key: string,
  defaultValue = true,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() =>
    readStoredBoolean(key, defaultValue),
  );

  // The updater stays pure — persisting inside it would let a StrictMode
  // replay or an interrupted concurrent render write a preference the UI
  // never committed. Mirror the COMMITTED value instead.
  const setPersisted = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => (typeof next === "function" ? next(prev) : next));
    },
    [],
  );

  // Skip the write for the value we just read back out of storage.
  const hydratedKey = useRef<string | null>(null);
  useEffect(() => {
    if (hydratedKey.current !== key) {
      hydratedKey.current = key;
      return;
    }
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // Private mode or quota — in-memory state still wins.
    }
  }, [key, value]);

  return [value, setPersisted];
}
