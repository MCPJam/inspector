import { useCallback, useSyncExternalStore } from "react";

/** Per user/project checklist state the backend doesn't have, in localStorage. */
export interface ChecklistProgress {
  chat?: boolean;
  agent?: boolean;
  skippedAll?: boolean;
  skippedAgent?: boolean;
  /** Set once the checklist hands Home back, so it doesn't show again. */
  finished?: boolean;
  /** Steps already sent as `completed`, so each is counted once. */
  reported?: string[];
  /** The done count Home last showed, so the bar grows from it on return. */
  shown?: number;
}

const PREFIX = "mcpjam.home-checklist.v1";
const CHANGE_EVENT = "mcpjam:home-checklist-progress";

export function checklistProgressKey(
  userId: string,
  projectId: string,
): string {
  return `${PREFIX}:${userId}:${projectId}`;
}

function read(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): ChecklistProgress {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as ChecklistProgress)
      : {};
  } catch {
    return {};
  }
}

export function updateChecklistProgress(
  key: string,
  patch: ChecklistProgress,
): void {
  const next = { ...parse(read(key)), ...patch };
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage blocked: the step stays unchecked after a reload.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useChecklistProgress(key: string | null): {
  progress: ChecklistProgress;
  update: (patch: ChecklistProgress) => void;
} {
  const raw = useSyncExternalStore(subscribe, () => read(key));
  const update = useCallback(
    (patch: ChecklistProgress) => {
      if (key) updateChecklistProgress(key, patch);
    },
    [key],
  );
  return { progress: parse(raw), update };
}
