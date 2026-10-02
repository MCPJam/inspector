import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useUpdateNotification } from "../useUpdateNotification";
import type { UpdateStatus, FailedUpdateStatus } from "@/types/electron";

const { errorToast, dismissToast } = vi.hoisted(() => ({
  errorToast: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
  toast: { error: errorToast, dismiss: dismissToast },
}));
const failure: FailedUpdateStatus = {
  kind: "failed",
  attemptId: "attempt-1",
  reason: "updater_error",
  action: "instructions",
};
function setup(initial: UpdateStatus = { kind: "idle" }) {
  const update = {
    onUpdateStatus: vi.fn(),
    removeUpdateStatusListener: vi.fn(),
    onUpdateError: vi.fn(),
    removeUpdateErrorListener: vi.fn(),
    getUpdateStatus: vi.fn().mockResolvedValue(initial),
    restartAndInstall: vi.fn(),
    retryDownload: vi.fn(),
    relaunchToRetry: vi.fn(),
    simulateUpdate: vi.fn(),
    simulateUpdateDownloaded: vi.fn(),
    simulateUpdateError: vi.fn(),
  };
  const openExternal = vi.fn();
  window.isElectron = true;
  window.electronAPI = { update, app: { openExternal } } as any;
  return {
    update,
    openExternal,
    status: (value: UpdateStatus) =>
      act(() => update.onUpdateStatus.mock.calls[0][0](value)),
    error: (value: FailedUpdateStatus) =>
      act(() => update.onUpdateError.mock.calls[0][0](value)),
  };
}
beforeEach(() => {
  delete window.isElectron;
  delete window.electronAPI;
  vi.clearAllMocks();
});

describe("desktop update notification", () => {
  it("is idle outside Electron", () => {
    const { result } = renderHook(() => useUpdateNotification());
    expect(result.current.status).toEqual({ kind: "idle" });
  });
  it("hydrates a downloaded update", async () => {
    setup({ kind: "downloaded", version: "3.11.0" });
    const { result } = renderHook(() => useUpdateNotification());
    await waitFor(() => expect(result.current.status.kind).toBe("downloaded"));
  });
  it("shows startup failures as persistent dismissible toasts", async () => {
    setup(failure);
    renderHook(() => useUpdateNotification());
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "Update failed. Quit MCPJam completely, then open it again.",
        {
          id: "desktop-update-attempt-1",
          duration: Infinity,
          closeButton: true,
        },
      ),
    );
  });
  it("only recommends force quit when shutdown is stuck", () => {
    const api = setup();
    renderHook(() => useUpdateNotification());
    api.status({ ...failure, reason: "shutdown_stuck" });
    expect(errorToast).toHaveBeenCalledWith(
      "Update failed. Force quit MCPJam and reopen it.",
      expect.any(Object),
    );
  });
  it("deduplicates status, error and snapshot delivery for the same failure", async () => {
    const api = setup(failure);
    renderHook(() => useUpdateNotification());
    api.status(failure);
    api.error(failure);
    await act(async () => {});
    expect(errorToast).toHaveBeenCalledTimes(1);
  });
  it("does not let a stale snapshot replace recovery", async () => {
    const api = setup();
    let resolve!: (value: UpdateStatus) => void;
    api.update.getUpdateStatus.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() => useUpdateNotification());
    api.status({ kind: "recovering", attemptId: "attempt-1" });
    await act(async () => resolve({ kind: "idle" }));
    expect(result.current.status.kind).toBe("recovering");
  });
  it("reopens the error without launching a browser or restarting", async () => {
    const api = setup(failure);
    const { result } = renderHook(() => useUpdateNotification());
    await waitFor(() => expect(result.current.status.kind).toBe("failed"));
    act(() => {
      result.current.showUpdateError();
      result.current.restartAndInstall();
    });
    expect(errorToast).toHaveBeenCalledTimes(2);
    expect(api.update.restartAndInstall).not.toHaveBeenCalled();
    expect(api.openExternal).not.toHaveBeenCalled();
  });
  it("requests an install and clears its spinner on failure", async () => {
    const api = setup({ kind: "downloaded", version: "3.11.0" });
    const { result } = renderHook(() => useUpdateNotification());
    await waitFor(() => expect(result.current.status.kind).toBe("downloaded"));
    act(() => result.current.restartAndInstall());
    expect(api.update.restartAndInstall).toHaveBeenCalledTimes(1);
    expect(result.current.restartRequested).toBe(true);
    api.status(failure);
    expect(result.current.restartRequested).toBe(false);
  });
  it("does not start another install while recovering", () => {
    const api = setup();
    const { result } = renderHook(() => useUpdateNotification());
    api.status({ kind: "recovering", attemptId: "attempt-1" });
    act(() => result.current.restartAndInstall());
    expect(api.update.restartAndInstall).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
  });
  it("shows a new failure once after a new attempt", () => {
    const api = setup();
    renderHook(() => useUpdateNotification());
    api.status(failure);
    api.status({ ...failure, attemptId: "attempt-2" });
    expect(errorToast).toHaveBeenCalledTimes(2);
  });
  it("unsubscribes on unmount", () => {
    const api = setup();
    const { unmount } = renderHook(() => useUpdateNotification());
    unmount();
    expect(api.update.removeUpdateStatusListener).toHaveBeenCalledTimes(1);
    expect(api.update.removeUpdateErrorListener).toHaveBeenCalledTimes(1);
  });
  it("ignores snapshot completion after unmount", async () => {
    setup(failure);
    const { unmount } = renderHook(() => useUpdateNotification());
    unmount();
    await act(async () => {});
    expect(errorToast).not.toHaveBeenCalled();
  });
  it("preserves dev simulation controls", () => {
    const api = setup();
    const { result } = renderHook(() => useUpdateNotification());
    act(() => {
      result.current.simulateUpdate();
      result.current.simulateUpdateDownloaded();
      result.current.simulateUpdateError();
    });
    expect(api.update.simulateUpdate).toHaveBeenCalledTimes(1);
    expect(api.update.simulateUpdateDownloaded).toHaveBeenCalledTimes(1);
    expect(api.update.simulateUpdateError).toHaveBeenCalledTimes(1);
  });
});

describe("download recovery actions", () => {
  it.each([
    ["retry-download", "Retry download", "retryDownload"],
    ["relaunch-retry", "Relaunch to retry", "relaunchToRetry"],
  ] as const)(
    "wires %s to the toast and prevents duplicate clicks",
    async (action, label, method) => {
      const api = setup({ ...failure, action });
      const { result } = renderHook(() => useUpdateNotification());
      await waitFor(() => expect(result.current.status.kind).toBe("failed"));
      const options = errorToast.mock.calls[0][1];
      expect(options.action.label).toBe(label);
      act(() => {
        options.action.onClick();
        result.current.retryUpdate();
      });
      expect(api.update[method]).toHaveBeenCalledTimes(1);
      expect(api.update.restartAndInstall).not.toHaveBeenCalled();
      api.status({ kind: "pending", installRequested: false });
      expect(dismissToast).toHaveBeenCalledWith("desktop-update-attempt-1");
      expect(result.current.restartRequested).toBe(false);
    },
  );
  it("dismisses failure when a late download completes", () => {
    const api = setup();
    renderHook(() => useUpdateNotification());
    api.status({ ...failure, action: "relaunch-retry" });
    api.status({ kind: "downloaded", version: "3.12.0" });
    expect(dismissToast).toHaveBeenCalledWith("desktop-update-attempt-1");
    expect(api.update.restartAndInstall).not.toHaveBeenCalled();
  });
  it("does not permit an early install request or show errors during automatic retries", () => {
    const api = setup();
    const { result } = renderHook(() => useUpdateNotification());
    api.status({ kind: "pending", installRequested: false });
    act(() => result.current.restartAndInstall());
    api.status({ kind: "retry-waiting", retry: 1 });
    act(() => result.current.restartAndInstall());
    expect(api.update.restartAndInstall).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
  });
  it("disables duplicate relaunch-to-update clicks", async () => {
    const api = setup({ kind: "downloaded", version: "3.12.0" });
    const { result } = renderHook(() => useUpdateNotification());
    await waitFor(() => expect(result.current.status.kind).toBe("downloaded"));
    act(() => {
      result.current.restartAndInstall();
      result.current.restartAndInstall();
    });
    expect(api.update.restartAndInstall).toHaveBeenCalledTimes(1);
  });
});
