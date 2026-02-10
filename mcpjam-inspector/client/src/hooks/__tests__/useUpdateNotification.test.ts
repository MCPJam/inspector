import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUpdateNotification } from "../useUpdateNotification";

const STORAGE_KEY = "mcpjam-pending-update";

// Helper to set up window.electronAPI mock
function setupElectronMock() {
  const mockOnUpdateReady = vi.fn();
  const mockRemoveUpdateReadyListener = vi.fn();
  const mockRestartAndInstall = vi.fn();
  const mockSimulateUpdate = vi.fn();

  window.isElectron = true;
  window.electronAPI = {
    update: {
      onUpdateReady: mockOnUpdateReady,
      removeUpdateReadyListener: mockRemoveUpdateReadyListener,
      restartAndInstall: mockRestartAndInstall,
      simulateUpdate: mockSimulateUpdate,
    },
  } as any;

  return {
    mockOnUpdateReady,
    mockRemoveUpdateReadyListener,
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
    localStorage.clear();
    clearElectronMock();
  });

  describe("initial state", () => {
    it("returns null when no update is stored", () => {
      const { result } = renderHook(() => useUpdateNotification());
      expect(result.current.updateReady).toBeNull();
    });

    it("restores update info from localStorage", () => {
      const stored = { version: "2.0.0", releaseNotes: "New stuff" };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));

      const { result } = renderHook(() => useUpdateNotification());
      expect(result.current.updateReady).toEqual(stored);
    });

    it("returns null when localStorage has invalid JSON", () => {
      localStorage.setItem(STORAGE_KEY, "not-json{{{");

      const { result } = renderHook(() => useUpdateNotification());
      expect(result.current.updateReady).toBeNull();
    });
  });

  describe("Electron update listener", () => {
    it("registers onUpdateReady listener in Electron", () => {
      const { mockOnUpdateReady } = setupElectronMock();

      renderHook(() => useUpdateNotification());
      expect(mockOnUpdateReady).toHaveBeenCalledWith(expect.any(Function));
    });

    it("does not register listener when not in Electron", () => {
      // window.isElectron is undefined
      const { result } = renderHook(() => useUpdateNotification());
      expect(result.current.updateReady).toBeNull();
    });

    it("sets updateReady and persists to localStorage when update arrives", () => {
      const { mockOnUpdateReady } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());

      // Grab the callback that was passed to onUpdateReady
      const callback = mockOnUpdateReady.mock.calls[0][0];
      const updateInfo = { version: "3.0.0", releaseNotes: "Big release" };

      act(() => {
        callback(updateInfo);
      });

      expect(result.current.updateReady).toEqual(updateInfo);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(
        JSON.stringify(updateInfo),
      );
    });

    it("removes listener on unmount", () => {
      const { mockRemoveUpdateReadyListener } = setupElectronMock();

      const { unmount } = renderHook(() => useUpdateNotification());
      unmount();

      expect(mockRemoveUpdateReadyListener).toHaveBeenCalled();
    });
  });

  describe("restartAndInstall", () => {
    it("clears localStorage and calls Electron API", () => {
      const { mockRestartAndInstall } = setupElectronMock();

      // Simulate a stored update
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: "2.0.0" }));

      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.restartAndInstall();
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(mockRestartAndInstall).toHaveBeenCalled();
    });

    it("does nothing when not in Electron", () => {
      const { result } = renderHook(() => useUpdateNotification());

      // Should not throw
      act(() => {
        result.current.restartAndInstall();
      });
    });
  });

  describe("simulateUpdate", () => {
    it("calls Electron simulate API", () => {
      const { mockSimulateUpdate } = setupElectronMock();

      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.simulateUpdate();
      });

      expect(mockSimulateUpdate).toHaveBeenCalled();
    });
  });
});
