import { useCallback, useEffect, useState } from "react";

// View-only "hide from this tab's header" list. The x on a server chip in the
// OAuth / XAA debugger headers doesn't delete the server (its config, tokens,
// and Convex row are untouched) — it just remembers, per browser, that the user
// dismissed it from that one header. Header shows = capability filter MINUS this
// hidden set. Keyed by surface so hiding a server in OAuth doesn't hide it in XAA.
const STORAGE_KEY = "mcpjam-header-hidden-servers/v1";

export type HeaderSurface = "oauth" | "xaa";

type HiddenMap = Partial<Record<HeaderSurface, string[]>>;

function readAll(): HiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as HiddenMap) : {};
  } catch {
    // Ignore parse/storage failures and treat nothing as hidden.
    return {};
  }
}

function writeAll(map: HiddenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage failures; the in-memory value still applies this session.
  }
}

function readSet(surface: HeaderSurface | null): Set<string> {
  if (!surface) return new Set();
  return new Set(readAll()[surface] ?? []);
}

/**
 * `surface === null` (any non-debugger tab) returns an always-empty set and
 * no-op mutators, so the selector can call this unconditionally and only the
 * OAuth/XAA headers actually hide anything.
 */
export function useHiddenHeaderServers(surface: HeaderSurface | null) {
  const [hidden, setHidden] = useState<Set<string>>(() => readSet(surface));

  // Re-read when the surface changes (e.g. switching between the OAuth and XAA
  // debugger tabs, which share this one hook instance).
  useEffect(() => {
    setHidden(readSet(surface));
  }, [surface]);

  // Stay in sync when another tab/window edits the same list.
  useEffect(() => {
    if (!surface) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setHidden(readSet(surface));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [surface]);

  const hide = useCallback(
    (serverName: string) => {
      if (!surface) return;
      const all = readAll();
      const next = new Set(all[surface] ?? []);
      next.add(serverName);
      all[surface] = Array.from(next);
      writeAll(all);
      setHidden(next);
    },
    [surface],
  );

  const unhide = useCallback(
    (serverName: string) => {
      if (!surface) return;
      const all = readAll();
      const next = new Set(all[surface] ?? []);
      next.delete(serverName);
      all[surface] = Array.from(next);
      writeAll(all);
      setHidden(next);
    },
    [surface],
  );

  return { hidden, hide, unhide };
}
