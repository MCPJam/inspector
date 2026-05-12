import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUpdateNotification } from "../useUpdateNotification";
import type { UpdateStatus } from "@/types/electron";

function setupElectronMock(initial: UpdateStatus = { kind: "idle" }) {
  const mockOnUpdateStatus = vi.fn();
  const mockRemoveUpdateStatusListener = vi.fn();
  const mockGetUpdateStatus = vi.fn().mockResolvedValue(initial);
  const mockRestartAndInstall = vi.fn();
  const mockSimulateUpdate = vi.fn();

  window.isElectron = true;
  window.electronAPI = {
    update: {
      onUpdateStatus: mockOnUpdateStatus,
      removeUpdateStatusListener: mockRemoveUpdateStatusListener,
      getUpdateStatus: mockGetUpdateStatus,
      restartAndInstall: mockRestartAndInstall,
      simulateUpdate: mockSimulateUpdate,
    },
  } as any;

  return {
    mockOnUpdateStatus,
    mockRemoveUpdateStatusListener,
    mockGetUpdateStatus,
    mockRestartAndInstall,
    mockSimulateUpdate,
  };
}

function clearElectronMock() {
  delete window.isElectron;
  delete window.electronAPI;
}

describe("useUpdateNotification", () => {
  beforeEach(() => {
    clearElectronMock();
  });

  describe("initial state", () => {
    it("returns idle when not running in Electron", () => {
      const { result } = renderHook(() => useUpdateNotification());
      expect(result.current.status).toEqual({ kind: "idle" });
    });

    it("hydrates initial status from main via getUpdateStatus", async () => {
      const initial: UpdateStatus = {
        kind: "downloaded",
        version: "3.0.0",
        releaseNotes: "Big release",
      };
      setupElectronMock(initial);

      const { result } = renderHook(() => useUpdateNotification());

      await waitFor(() => {
        expect(result.current.status).toEqual(initial);
      });
    });
  });

  describe("Electron status listener", () => {
    it("registers onUpdateStatus listener in Electron", () => {
      const { mockOnUpdateStatus } = setupElectronMock();

      renderHook(() => useUpdateNotification());
      expect(mockOnUpdateStatus).toHaveBeenCalledWith(expect.any(Function));
    });

    it("does not register listener when not in Electron", () => {
      const { result } = renderHook(() => useUpdateNotification());
      expect(result.current.status).toEqual({ kind: "idle" });
    });

    it("transitions through pending → downloaded as main broadcasts", () => {
      const { mockOnUpdateStatus } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());
      const callback = mockOnUpdateStatus.mock.calls[0][0];

      act(() => {
        callback({ kind: "pending", installRequested: false });
      });
      expect(result.current.status).toEqual({
        kind: "pending",
        installRequested: false,
      });

      act(() => {
        callback({
          kind: "downloaded",
          version: "3.0.0",
          releaseNotes: "Big release",
        });
      });
      expect(result.current.status).toEqual({
        kind: "downloaded",
        version: "3.0.0",
        releaseNotes: "Big release",
      });
    });

    it("reflects installRequested flag from pending status", () => {
      const { mockOnUpdateStatus } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());
      const callback = mockOnUpdateStatus.mock.calls[0][0];

      act(() => {
        callback({ kind: "pending", installRequested: true });
      });

      expect(result.current.status).toEqual({
        kind: "pending",
        installRequested: true,
      });
    });

    it("removes listener on unmount", () => {
      const { mockRemoveUpdateStatusListener } = setupElectronMock();

      const { unmount } = renderHook(() => useUpdateNotification());
      unmount();

      expect(mockRemoveUpdateStatusListener).toHaveBeenCalled();
    });
  });

  describe("restartAndInstall", () => {
    it("forwards to the Electron API", () => {
      const { mockRestartAndInstall } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.restartAndInstall();
      });

      expect(mockRestartAndInstall).toHaveBeenCalled();
    });

    it("does nothing when not in Electron", () => {
      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.restartAndInstall();
      });
    });
  });

  describe("simulateUpdate", () => {
    it("calls the Electron simulate API", () => {
      const { mockSimulateUpdate } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.simulateUpdate();
      });

      expect(mockSimulateUpdate).toHaveBeenCalled();
    });
  });
});
