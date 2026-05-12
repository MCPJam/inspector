import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
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
    api.onUpdateError(() => {
      toast.error("Update failed. Try again later.");
    });

    return () => {
      cancelled = true;
      window.electronAPI?.update?.removeUpdateStatusListener();
      window.electronAPI?.update?.removeUpdateErrorListener();
    };
  }, []);

  const restartAndInstall = useCallback(() => {
    window.electronAPI?.update?.restartAndInstall();
  }, []);

  const simulateUpdate = useCallback(() => {
    window.electronAPI?.update?.simulateUpdate?.();
  }, []);

  const simulateUpdateDownloaded = useCallback(() => {
    window.electronAPI?.update?.simulateUpdateDownloaded?.();
  }, []);

  const simulateUpdateError = useCallback(() => {
    window.electronAPI?.update?.simulateUpdateError?.();
  }, []);

  return {
    status,
    restartAndInstall,
    simulateUpdate,
    simulateUpdateDownloaded,
    simulateUpdateError,
  };
}
