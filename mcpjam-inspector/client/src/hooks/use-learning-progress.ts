import { useState, useCallback, useEffect, useMemo } from "react";

const STORAGE_KEY = "mcp-inspector-learning-progress";

function loadCompleted(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveCompleted(ids: Set<string>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

export function useLearningProgress() {
  const [completedModules, setCompletedModules] =
    useState<Set<string>>(loadCompleted);

  // Sync across tabs
  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setCompletedModules(loadCompleted());
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const isCompleted = useCallback(
    (id: string) => completedModules.has(id),
    [completedModules],
  );

  const markComplete = useCallback((id: string) => {
    setCompletedModules((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      saveCompleted(next);
      return next;
    });
  }, []);

  const toggleComplete = useCallback((id: string) => {
    setCompletedModules((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      saveCompleted(next);
      return next;
    });
  }, []);

  const completionCount = useMemo(
    () => completedModules.size,
    [completedModules],
  );

  return {
    completedModules,
    isCompleted,
    markComplete,
    toggleComplete,
    completionCount,
  };
}
