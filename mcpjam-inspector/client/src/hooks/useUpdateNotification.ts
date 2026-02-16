import { useEffect, useState, useCallback } from "react";

interface UpdateInfo {
  version: string;
  releaseNotes?: string;
}

const STORAGE_KEY = "mcpjam-pending-update";

export function useUpdateNotification() {
  const [updateReady, setUpdateReady] = useState<UpdateInfo | null>(() => {
    // Check localStorage on initial load
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          return null;
        }
      }
    }
    return null;
  });

  useEffect(() => {
    // Only set up if running in Electron
    if (!window.isElectron || !window.electronAPI?.update) {
      return;
    }

    const handleUpdateReady = (info: UpdateInfo) => {
      console.log("Update ready:", info);
      setUpdateReady(info);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(info));
    };

    window.electronAPI.update.onUpdateReady(handleUpdateReady);

    return () => {
      window.electronAPI?.update?.removeUpdateReadyListener();
    };
  }, []);

  const restartAndInstall = useCallback(() => {
    if (window.electronAPI?.update) {
      localStorage.removeItem(STORAGE_KEY);
      window.electronAPI.update.restartAndInstall();
    }
  }, []);

  const simulateUpdate = useCallback(() => {
    if (window.electronAPI?.update) {
      window.electronAPI.update.simulateUpdate?.();
    }
  }, []);

  return {
    updateReady,
    restartAndInstall,
    simulateUpdate,
  };
}
