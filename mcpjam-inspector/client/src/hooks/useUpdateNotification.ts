import { useEffect, useState, useCallback } from "react";
import type { UpdateStatus } from "@/types/electron";

export function useUpdateNotification() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });

  useEffect(() => {
    if (!window.isElectron || !window.electronAPI?.update) {
      return;
    }
    const api = window.electronAPI.update;

    let cancelled = false;
    api.getUpdateStatus().then((initial) => {
      if (!cancelled) setStatus(initial);
    });

    api.onUpdateStatus((next) => setStatus(next));

    return () => {
      cancelled = true;
      window.electronAPI?.update?.removeUpdateStatusListener();
    };
  }, []);

  const restartAndInstall = useCallback(() => {
    window.electronAPI?.update?.restartAndInstall();
  }, []);

  const simulateUpdate = useCallback(() => {
    window.electronAPI?.update?.simulateUpdate?.();
  }, []);

  return {
    status,
    restartAndInstall,
    simulateUpdate,
  };
}
