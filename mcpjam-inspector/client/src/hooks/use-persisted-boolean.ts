import { useCallback, useState } from "react";

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

  const setPersisted = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          window.localStorage.setItem(key, String(resolved));
        } catch {
          // Ignore write failures.
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, setPersisted];
}
