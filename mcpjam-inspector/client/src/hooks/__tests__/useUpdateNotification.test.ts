import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUpdateNotification } from "../useUpdateNotification";
import type { UpdateStatus } from "@/types/electron";

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

function setupElectronMock(initial: UpdateStatus = { kind: "idle" }) {
  const mockOnUpdateStatus = vi.fn();
  const mockRemoveUpdateStatusListener = vi.fn();
  const mockOnUpdateError = vi.fn();
  const mockRemoveUpdateErrorListener = vi.fn();
  const mockGetUpdateStatus = vi.fn().mockResolvedValue(initial);
  const mockRestartAndInstall = vi.fn();
  const mockSimulateUpdate = vi.fn();
  const mockSimulateUpdateDownloaded = vi.fn();
  const mockSimulateUpdateError = vi.fn();

  window.isElectron = true;
  window.electronAPI = {
    update: {
      onUpdateStatus: mockOnUpdateStatus,
      removeUpdateStatusListener: mockRemoveUpdateStatusListener,
      onUpdateError: mockOnUpdateError,
      removeUpdateErrorListener: mockRemoveUpdateErrorListener,
      getUpdateStatus: mockGetUpdateStatus,
      restartAndInstall: mockRestartAndInstall,
      simulateUpdate: mockSimulateUpdate,
      simulateUpdateDownloaded: mockSimulateUpdateDownloaded,
      simulateUpdateError: mockSimulateUpdateError,
    },
  } as any;

  return {
    mockOnUpdateStatus,
    mockRemoveUpdateStatusListener,
    mockOnUpdateError,
    mockRemoveUpdateErrorListener,
    mockGetUpdateStatus,
    mockRestartAndInstall,
    mockSimulateUpdate,
    mockSimulateUpdateDownloaded,
    mockSimulateUpdateError,
  };
}

function clearElectronMock() {
  delete window.isElectron;
  delete window.electronAPI;
}

describe("useUpdateNotification", () => {
  beforeEach(() => {
    clearElectronMock();
    mockToastError.mockClear();
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
      const { mockOnUpdateStatus, mockOnUpdateError } = setupElectronMock();

      renderHook(() => useUpdateNotification());
      expect(mockOnUpdateStatus).toHaveBeenCalledWith(expect.any(Function));
      expect(mockOnUpdateError).toHaveBeenCalledWith(expect.any(Function));
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

    it("does not let a slower initial snapshot overwrite a live status event", async () => {
      const { mockGetUpdateStatus, mockOnUpdateStatus } = setupElectronMock();
      let resolveInitialStatus!: (status: UpdateStatus) => void;
      mockGetUpdateStatus.mockReturnValueOnce(
        new Promise<UpdateStatus>((resolve) => {
          resolveInitialStatus = resolve;
        }),
      );

      const { result } = renderHook(() => useUpdateNotification());
      const callback = mockOnUpdateStatus.mock.calls[0][0];

      act(() => {
        callback({ kind: "pending", installRequested: false });
      });
      expect(result.current.status).toEqual({
        kind: "pending",
        installRequested: false,
      });

      await act(async () => {
        resolveInitialStatus({ kind: "idle" });
      });

      expect(result.current.status).toEqual({
        kind: "pending",
        installRequested: false,
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

    it("shows a generic toast when main reports an update error", () => {
      const { mockOnUpdateError } = setupElectronMock();

      renderHook(() => useUpdateNotification());
      const callback = mockOnUpdateError.mock.calls[0][0];

      act(() => {
        callback();
      });

      expect(mockToastError).toHaveBeenCalledWith(
        "Update failed. Try again later.",
      );
    });

    it("removes listener on unmount", () => {
      const {
        mockRemoveUpdateStatusListener,
        mockRemoveUpdateErrorListener,
      } = setupElectronMock();

      const { unmount } = renderHook(() => useUpdateNotification());
      unmount();

      expect(mockRemoveUpdateStatusListener).toHaveBeenCalled();
      expect(mockRemoveUpdateErrorListener).toHaveBeenCalled();
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
      const {
        mockSimulateUpdate,
        mockSimulateUpdateDownloaded,
        mockSimulateUpdateError,
      } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.simulateUpdate();
        result.current.simulateUpdateDownloaded();
        result.current.simulateUpdateError();
      });

      expect(mockSimulateUpdate).toHaveBeenCalled();
      expect(mockSimulateUpdateDownloaded).toHaveBeenCalled();
      expect(mockSimulateUpdateError).toHaveBeenCalled();
    });
  });
});
