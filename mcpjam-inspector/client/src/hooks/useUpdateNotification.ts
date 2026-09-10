import { useEffect, useState, useCallback } from "react";
import { toast } from "@/lib/toast";
import type { UpdateStatus } from "@/types/electron";

// Public releases page — repo is github.com/MCPJam/inspector (verified from
// mcpjam-inspector/package.json `repository.url`).
const RELEASES_URL = "https://github.com/MCPJam/inspector/releases";

export function useUpdateNotification() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  /**
   * The user asked to install, and we are waiting for the app to go away.
   *
   * Tracked here rather than read off `status` because the main process does
   * not change the status when it starts a `downloaded` install — it hands off
   * to Electron and the app tears down — so `downloaded` is both "ready to
   * install" and "installing", and only the click tells them apart. Without
   * this the button stays enabled through the whole teardown and a second
   * click fires `quitAndInstall` twice (INSPECTOR-ELECTRON-GT).
   */
  const [restartRequested, setRestartRequested] = useState(false);

  const downloadManually = useCallback(() => {
    window.electronAPI?.app?.openExternal(RELEASES_URL)?.catch((error) => {
      console.warn("Failed to open releases page", error);
    });
  }, []);

  useEffect(() => {
    if (!window.isElectron || !window.electronAPI?.update) {
      return;
    }
    const api = window.electronAPI.update;

    let cancelled = false;
    // Subscribe first so we don't miss broadcasts that arrive between the
    // getUpdateStatus() call and its resolution.
    let liveEventReceived = false;
    api.onUpdateStatus((next) => {
      liveEventReceived = true;
      setStatus(next);
    });
    api.onUpdateError(() => {
      // The install did not happen, so let the user ask again. Its own toast
      // offers the manual download; this re-arms the button behind it.
      setRestartRequested(false);
      // Surface a fallback path — auto-update can stall silently on macOS
      // (Squirrel staging / signing issues), so always offer a manual
      // download as an escape hatch.
      toast.error("Update failed. Try again later.", {
        action: {
          label: "Download manually",
          onClick: downloadManually,
        },
      });
    });

    // Initial snapshot — apply only if a live event hasn't already overtaken it.
    // Avoids a startup race where an older idle snapshot overwrites a live
    // pending/downloaded event and hides the button until the next broadcast.
    api
      .getUpdateStatus()
      .then((initial) => {
        if (!cancelled && !liveEventReceived) setStatus(initial);
      })
      .catch((error) => {
        console.warn("Failed to get update status", error);
      });

    return () => {
      cancelled = true;
      window.electronAPI?.update?.removeUpdateStatusListener();
      window.electronAPI?.update?.removeUpdateErrorListener();
    };
    // `downloadManually` is stable, so this stays a mount-once effect.
  }, [downloadManually]);

  const restartAndInstall = useCallback(() => {
    setRestartRequested(true);
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
    restartRequested,
    downloadManually,
    restartAndInstall,
    simulateUpdate,
    simulateUpdateDownloaded,
    simulateUpdateError,
  };
}
