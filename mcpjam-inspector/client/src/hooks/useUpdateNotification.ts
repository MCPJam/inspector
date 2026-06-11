import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import type { UpdateStatus } from "@/types/electron";

// Public releases page — repo is github.com/MCPJam/inspector (verified from
// mcpjam-inspector/package.json `repository.url`).
const RELEASES_URL = "https://github.com/MCPJam/inspector/releases";

export function useUpdateNotification() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });

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
      // Surface a fallback path — auto-update can stall silently on macOS
      // (Squirrel staging / signing issues), so always offer a manual
      // download as an escape hatch.
      toast.error("Update failed. Try again later.", {
        action: {
          label: "Download manually",
          onClick: () => {
            window.electronAPI?.app
              ?.openExternal(RELEASES_URL)
              ?.catch((error) => {
                console.warn("Failed to open releases page", error);
              });
          },
        },
      });
    });

    // Initial snapshot — apply only if a live event hasn't already overtaken it.
    // Avoids a startup race where an older idle snapshot overwrites a live
    // pending/downloaded event and hides the button until the next broadcast.
    api.getUpdateStatus()
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
