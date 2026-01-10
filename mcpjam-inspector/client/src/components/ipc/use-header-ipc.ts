import { useCallback, useEffect, useState } from "react";
import { HeaderIpc, headerIpcs } from "./ipc-registry";

const STORAGE_KEY = "inspector.header-ipc.dismissed";

type DismissedValue = string[];

type HeaderIpcState = {
  activeIpc: HeaderIpc | null;
  dismissActiveIpc: () => void;
};

const safeParseDismissed = (raw: string | null): DismissedValue => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DismissedValue) : [];
  } catch (error) {
    console.warn("Failed to parse stored IPC state", error);
    return [];
  }
};

const getDismissedIds = (): Set<string> => {
  if (typeof window === "undefined") {
    return new Set();
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  return new Set(safeParseDismissed(stored));
};

const writeDismissedIds = (ids: Set<string>) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
};

export const useHeaderIpc = (): HeaderIpcState => {
  const [activeIpc, setActiveIpc] = useState<HeaderIpc | null>(null);

  useEffect(() => {
    const dismissedIds = getDismissedIds();
    const next = headerIpcs.find((ipc) => !dismissedIds.has(ipc.id)) ?? null;
    setActiveIpc(next);
  }, []);

  const dismissActiveIpc = useCallback(() => {
    if (!activeIpc) return;

    const dismissedIds = getDismissedIds();
    dismissedIds.add(activeIpc.id);
    writeDismissedIds(dismissedIds);
    setActiveIpc(null);
  }, [activeIpc]);

  return { activeIpc, dismissActiveIpc };
};
