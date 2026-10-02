import { useEffect, useState, useCallback, useRef } from "react";
import { toast } from "@/lib/toast";
import type { UpdateStatus, FailedUpdateStatus } from "@/types/electron";

function showFailure(status: FailedUpdateStatus, retry: () => void) {
  const label =
    status.action === "retry-download" ? "Retry download" : "Relaunch to retry";
  const actionable = status.action !== "instructions";
  toast.error(
    actionable
      ? status.action === "retry-download"
        ? "Update download failed. Try downloading again."
        : "Update download is stuck. Relaunch MCPJam to retry."
      : status.reason === "shutdown_stuck"
        ? "Update failed. Force quit MCPJam and reopen it."
        : "Update failed. Quit MCPJam completely, then open it again.",
    {
      id: `desktop-update-${status.attemptId}`,
      duration: Infinity,
      closeButton: true,
      ...(actionable ? { action: { label, onClick: retry } } : {}),
    },
  );
}

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
  /**
   * The latest status, readable from the IPC listeners below. They are
   * registered once, so reading `status` inside them would read the value
   * captured at mount.
   */
  const statusRef = useRef<UpdateStatus>({ kind: "idle" });

  const shownFailure = useRef<string | undefined>(undefined);
  const failureToast = useRef<string | undefined>(undefined);
  const actionPending = useRef(false);
  const retryUpdate = useCallback(() => {
    const current = statusRef.current;
    if (current.kind !== "failed" || actionPending.current) return;
    if (current.action === "instructions") return;
    actionPending.current = true;
    setRestartRequested(true);
    if (current.action === "retry-download")
      window.electronAPI?.update?.retryDownload();
    else window.electronAPI?.update?.relaunchToRetry();
  }, []);

  const applyStatus = useCallback(
    (next: UpdateStatus) => {
      statusRef.current = next;
      actionPending.current = false;
      setRestartRequested(false);
      if (next.kind === "failed") {
        const key = `${next.attemptId}:${next.reason}:${next.action}`;
        if (shownFailure.current !== key) {
          if (failureToast.current) toast.dismiss(failureToast.current);
          shownFailure.current = key;
          failureToast.current = `desktop-update-${next.attemptId}`;
          showFailure(next, retryUpdate);
        }
      } else if (failureToast.current) {
        toast.dismiss(failureToast.current);
        failureToast.current = undefined;
        shownFailure.current = undefined;
      }
      setStatus(next);
    },
    [retryUpdate],
  );

  const showUpdateError = useCallback(() => {
    if (statusRef.current.kind === "failed")
      showFailure(statusRef.current, retryUpdate);
  }, [retryUpdate]);

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
      applyStatus(next);
    });
    api.onUpdateError((failure) => {
      liveEventReceived = true;
      applyStatus(failure);
    });

    // Initial snapshot — apply only if a live event hasn't already overtaken it.
    // Avoids a startup race where an older idle snapshot overwrites a live
    // pending/downloaded event and hides the button until the next broadcast.
    api
      .getUpdateStatus()
      .then((initial) => {
        if (!cancelled && !liveEventReceived) applyStatus(initial);
      })
      .catch((error) => {
        console.warn("Failed to get update status", error);
      });

    return () => {
      cancelled = true;
      window.electronAPI?.update?.removeUpdateStatusListener();
      window.electronAPI?.update?.removeUpdateErrorListener();
    };
    // Both callbacks are stable, so this stays a mount-once effect.
  }, [applyStatus]);

  const restartAndInstall = useCallback(() => {
    if (statusRef.current.kind !== "downloaded" || actionPending.current)
      return;
    actionPending.current = true;
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
    showUpdateError,
    retryUpdate,
    restartAndInstall,
    simulateUpdate,
    simulateUpdateDownloaded,
    simulateUpdateError,
  };
}
