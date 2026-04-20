import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useUpdateNotification } from "../useUpdateNotification";
import {
  IDLE_UPDATE_STATE,
  type UpdateState,
} from "@/shared/update-state";

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

function createDeferredState(state: UpdateState) {
  let resolve!: (value: UpdateState) => void;

  const promise = new Promise<UpdateState>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve: () => resolve(state),
  };
}

function setupElectronMock(initialState: UpdateState | Promise<UpdateState>) {
  const stateChangeCallbacks = new Set<(state: UpdateState) => void>();

  const mockGetState = vi.fn().mockImplementation(() => initialState);
  const mockOnStateChanged = vi
    .fn()
    .mockImplementation((callback: (state: UpdateState) => void) => {
      stateChangeCallbacks.add(callback);

      return () => {
        stateChangeCallbacks.delete(callback);
      };
    });
  const mockRequestInstall = vi.fn();
  const mockSimulateUpdate = vi.fn();

  window.isElectron = true;
  window.electronAPI = {
    update: {
      getState: mockGetState,
      onStateChanged: mockOnStateChanged,
      requestInstall: mockRequestInstall,
      simulateUpdate: mockSimulateUpdate,
    },
  } as any;

  return {
    mockGetState,
    mockOnStateChanged,
    mockRequestInstall,
    mockSimulateUpdate,
    getSubscriberCount() {
      return stateChangeCallbacks.size;
    },
    emitState(state: UpdateState) {
      if (stateChangeCallbacks.size === 0) {
        throw new Error("state change callback not registered");
      }

      act(() => {
        for (const callback of stateChangeCallbacks) {
          callback(state);
        }
      });
    },
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
    it("returns the idle CTA state when not running in Electron", () => {
      const { result } = renderHook(() => useUpdateNotification());

      expect(result.current.updateState).toEqual(IDLE_UPDATE_STATE);
      expect(result.current.showUpdateButton).toBe(false);
      expect(result.current.updateButtonLabel).toBeNull();
    });
  });

  describe("Electron update state", () => {
    it("loads the initial snapshot and subscribes for updates", async () => {
      const initialState: UpdateState = {
        phase: "available",
        installRequested: false,
      };
      const { mockGetState, mockOnStateChanged } = setupElectronMock(
        Promise.resolve(initialState),
      );

      renderHook(() => useUpdateNotification());

      expect(mockOnStateChanged).toHaveBeenCalledWith(expect.any(Function));
      await waitFor(() => {
        expect(mockGetState).toHaveBeenCalledTimes(1);
      });
    });

    it("does not overwrite pushed state with a stale snapshot", async () => {
      const deferredState = createDeferredState({
        phase: "available",
        installRequested: false,
      });
      const { emitState } = setupElectronMock(deferredState.promise);

      const { result } = renderHook(() => useUpdateNotification());

      emitState({
        phase: "ready",
        installRequested: false,
        version: "3.0.0",
        releaseNotes: "Big release",
      });
      deferredState.resolve();

      await waitFor(() => {
        expect(result.current.updateState).toEqual({
          phase: "ready",
          installRequested: false,
          version: "3.0.0",
          releaseNotes: "Big release",
        });
      });
    });

    it("removes only its own listener on unmount", () => {
      const electronMock = setupElectronMock(
        Promise.resolve({ ...IDLE_UPDATE_STATE }),
      );

      const firstHook = renderHook(() => useUpdateNotification());
      const secondHook = renderHook(() => useUpdateNotification());

      expect(electronMock.getSubscriberCount()).toBe(2);

      firstHook.unmount();

      expect(electronMock.getSubscriberCount()).toBe(1);

      electronMock.emitState({
        phase: "available",
        installRequested: false,
      });

      expect(secondHook.result.current.updateState).toEqual({
        phase: "available",
        installRequested: false,
      });

      secondHook.unmount();

      expect(electronMock.getSubscriberCount()).toBe(0);
    });
  });

  describe("button state", () => {
    it("keeps a stable Update label across all visible phases and still shows error toasts", async () => {
      const { emitState } = setupElectronMock(
        Promise.resolve({ ...IDLE_UPDATE_STATE }),
      );
      const { result } = renderHook(() => useUpdateNotification());

      emitState({
        phase: "available",
        installRequested: false,
      });
      expect(result.current.showUpdateButton).toBe(true);
      expect(result.current.updateButtonLabel).toBe("Update");

      emitState({
        phase: "downloading",
        installRequested: true,
      });
      expect(result.current.updateButtonLabel).toBe("Update");

      emitState({
        phase: "ready",
        installRequested: false,
        version: "3.0.0",
      });
      expect(result.current.updateButtonLabel).toBe("Update");

      emitState({
        phase: "error",
        installRequested: false,
        errorMessage: "download failed",
      });
      expect(result.current.updateButtonLabel).toBe("Update");
      expect(mockToastError).toHaveBeenCalledTimes(1);
      expect(mockToastError).toHaveBeenCalledWith("download failed");

      emitState({
        phase: "error",
        installRequested: false,
        errorMessage: "download failed again",
      });
      expect(mockToastError).toHaveBeenCalledTimes(1);

      emitState({
        phase: "available",
        installRequested: false,
      });
      emitState({
        phase: "error",
        installRequested: false,
        errorMessage: "still failed",
      });
      expect(mockToastError).toHaveBeenCalledTimes(2);
      expect(mockToastError).toHaveBeenLastCalledWith("still failed");
    });
  });

  describe("actions", () => {
    it("requests install through the Electron API", async () => {
      const { mockRequestInstall } = setupElectronMock(
        Promise.resolve({
          phase: "available",
          installRequested: false,
        }),
      );
      const { result } = renderHook(() => useUpdateNotification());

      await waitFor(() => {
        expect(result.current.updateButtonLabel).toBe("Update");
      });

      act(() => {
        result.current.requestInstall();
      });

      expect(mockRequestInstall).toHaveBeenCalledTimes(1);
    });

    it("calls the dev-only simulate API when available", () => {
      const { mockSimulateUpdate } = setupElectronMock(
        Promise.resolve({ ...IDLE_UPDATE_STATE }),
      );
      const { result } = renderHook(() => useUpdateNotification());

      act(() => {
        result.current.simulateUpdate();
      });

      expect(mockSimulateUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
