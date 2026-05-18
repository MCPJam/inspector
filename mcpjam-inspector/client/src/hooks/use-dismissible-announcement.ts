import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "mcpjam:announcement-dismissed:";

function readDismissed(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}

export function useDismissibleAnnouncement(id: string) {
  const key = `${STORAGE_PREFIX}${id}`;
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed(key));

  // If the id changes, re-read the new key's state.
  useEffect(() => {
    setDismissed(readDismissed(key));
  }, [key]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // localStorage may be unavailable (private mode, quota). Still update UI state.
    }
    setDismissed(true);
  }, [key]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue === "1") setDismissed(true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key]);

  return { dismissed, dismiss };
}
