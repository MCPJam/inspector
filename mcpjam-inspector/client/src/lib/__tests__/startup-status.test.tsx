import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  isAuthenticated: false,
  publicPage: false,
  workOsUser: null as { id: string } | null,
  workOsLoading: false,
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isLoading: false,
    isAuthenticated: auth.isAuthenticated,
  }),
}));
vi.mock("../vanity-landing-hosts", () => ({
  shouldSkipGuestSession: () => auth.publicPage,
}));
vi.mock("@/hooks/use-inspector-auth", () => ({
  useInspectorAuth: () => ({
    user: auth.workOsUser,
    isLoading: auth.workOsLoading,
  }),
}));
const reportCaught = vi.hoisted(() => vi.fn());
vi.mock("../error-reporting", () => ({ reportCaught }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../analytics", () => ({ track: analytics.track }));
const desktop = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("../desktop-diagnostics", () => ({
  recordDesktopActivity: desktop.record,
}));
vi.mock("../guest-session", () => ({
  getGuestSessionRefusal: () => null,
  subscribeGuestSessionChanges: () => () => {},
}));

import {
  reportUserReadiness,
  resetStartupStatusForTests,
  retryStartup,
  StartupStatusTracker,
  useStartupStatus,
  useStartupStore,
} from "../startup-status";
import {
  APP_LOAD_STALL_MS,
  STARTUP_RECOVERY_DEADLINE_MS,
} from "@/shared/app-load-stall";
import { resetAppLoadStallForTests } from "../app-load-stall";
import { resetStartupTrackingForTests } from "../startup-tracking";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

const escalated = () => useStartupStore.getState().escalated;

describe("StartupStatusTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    resetStartupStatusForTests();
    resetAppLoadStallForTests();
    resetStartupTrackingForTests();
    analytics.track.mockReset();
    reportCaught.mockReset();
    auth.isAuthenticated = false;
    auth.publicPage = false;
    auth.workOsUser = null;
    auth.workOsLoading = false;
    useSessionRefreshStore.setState({ status: "idle", kind: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("escalates as soon as a session refresh fails, without waiting for the deadline", () => {
    render(<StartupStatusTracker />);
    expect(escalated()).toBe(false);
    act(() => useSessionRefreshStore.getState().notifyFailure("transient"));
    expect(escalated()).toBe(true);
  });

  it("escalates a silent stall once the deadline passes", () => {
    render(<StartupStatusTracker />);
    act(() => vi.advanceTimersByTime(STARTUP_RECOVERY_DEADLINE_MS - 1));
    expect(escalated()).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(escalated()).toBe(true);
  });

  it("stays escalated while a Retry is in flight and after it clears the failure", () => {
    render(<StartupStatusTracker />);
    act(() => useSessionRefreshStore.getState().notifyFailure("transient"));
    act(() => useSessionRefreshStore.getState().retry());
    expect(escalated()).toBe(true);
    act(() => useSessionRefreshStore.getState().clear());
    expect(escalated()).toBe(true);
  });

  it("drops the recovery state once the user record is ready", () => {
    render(<StartupStatusTracker />);
    act(() => useSessionRefreshStore.getState().notifyFailure("transient"));
    act(() => reportUserReadiness(true, true));
    expect(escalated()).toBe(false);
  });

  it("does not treat a later reconnect as a stalled startup once the app was usable", () => {
    render(<StartupStatusTracker />);
    act(() => reportUserReadiness(true, true));
    act(() => reportUserReadiness(false, false));
    act(() => vi.advanceTimersByTime(STARTUP_RECOVERY_DEADLINE_MS));
    expect(escalated()).toBe(false);
  });

  it("remembers what failed, and shows Retry as busy, while a retry clears the refresh store", () => {
    const { result } = renderHook(() => useStartupStatus());
    render(<StartupStatusTracker />);
    act(() => useSessionRefreshStore.getState().notifyFailure("manual"));
    act(() => retryStartup());
    // A guest retry clears the refresh store while it runs.
    act(() => useSessionRefreshStore.getState().clear());
    expect(result.current.failureKind).toBe("manual");
    expect(result.current.retrying).toBe(true);
    expect(result.current.stage).toBe("app_load/guest_session_failed");
    act(() => useSessionRefreshStore.getState().notifyFailure("manual"));
    expect(result.current.retrying).toBe(false);
  });

  it("frees Retry and names the user-record step once auth recovers but setup stalls", () => {
    const { result, rerender } = renderHook(() => useStartupStatus());
    const tracker = render(<StartupStatusTracker />);
    act(() => useSessionRefreshStore.getState().notifyFailure("transient"));
    act(() => retryStartup());
    act(() => useSessionRefreshStore.getState().clear());
    auth.isAuthenticated = true;
    tracker.rerender(<StartupStatusTracker />);
    act(() => reportUserReadiness(false, true));
    rerender();
    expect(result.current.escalated).toBe(true);
    expect(result.current.retrying).toBe(false);
    expect(result.current.failureKind).toBeNull();
    expect(result.current.stage).toBe("app_load/user_setup_pending");
  });

  it("neither escalates nor reports a stall on a page that works signed out, like /redeem", () => {
    auth.publicPage = true;
    render(<StartupStatusTracker />);
    act(() => vi.advanceTimersByTime(APP_LOAD_STALL_MS));
    expect(escalated()).toBe(false);
    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("still reports a stall when nothing is exempt", () => {
    render(<StartupStatusTracker />);
    act(() => vi.advanceTimersByTime(APP_LOAD_STALL_MS));
    expect(reportCaught).toHaveBeenCalledTimes(1);
  });

  it("does not report a blocked launch when a session breaks after the app was usable", () => {
    render(<StartupStatusTracker />);
    act(() => reportUserReadiness(true, true));
    // A mid-session refresh failure unmounts AuthBootstrap, which reports
    // the user as not ready on its way out.
    act(() => reportUserReadiness(false, false));
    act(() => useSessionRefreshStore.getState().notifyFailure("transient"));
    expect(escalated()).toBe(true);
    const blocked = analytics.track.mock.calls.filter(
      ([name]) => name === "app_startup_blocked",
    );
    expect(blocked).toHaveLength(0);
  });

  it("tells the desktop app its stage and sign-in state, and keeps reporting while stuck", () => {
    desktop.record.mockClear();
    Object.defineProperty(window, "electronAPI", {
      value: { diagnostics: { record: vi.fn() } },
      configurable: true,
    });
    try {
      render(<StartupStatusTracker />);
      expect(desktop.record).toHaveBeenLastCalledWith({
        kind: "startup",
        phase: "state",
        stage: "app_load/auth_pending",
        auth: "guest",
        version: __APP_VERSION__,
      });
      // No stage change for a while: the heartbeat still marks the window alive.
      const before = desktop.record.mock.calls.length;
      act(() => vi.advanceTimersByTime(15_000));
      expect(desktop.record.mock.calls.length).toBe(before + 1);
      act(() => reportUserReadiness(true, true));
      expect(desktop.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: "ready" }),
      );
    } finally {
      Reflect.deleteProperty(window, "electronAPI");
    }
  });

  it("reports WorkOS identity, not guest Convex authentication, and never the user ID", () => {
    desktop.record.mockClear();
    Object.defineProperty(window, "electronAPI", {
      value: { diagnostics: { record: vi.fn() } },
      configurable: true,
    });
    auth.isAuthenticated = true;
    auth.workOsLoading = true;
    try {
      const view = render(<StartupStatusTracker />);
      expect(desktop.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ auth: "loading" }),
      );
      auth.workOsLoading = false;
      view.rerender(<StartupStatusTracker />);
      expect(desktop.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ auth: "guest" }),
      );
      auth.workOsUser = { id: "private-user" };
      view.rerender(<StartupStatusTracker />);
      expect(desktop.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ auth: "signed_in" }),
      );
      expect(JSON.stringify(desktop.record.mock.calls)).not.toContain(
        "private-user",
      );
    } finally {
      Reflect.deleteProperty(window, "electronAPI");
    }
  });

  it("does not report anything outside the desktop app", () => {
    desktop.record.mockClear();
    render(<StartupStatusTracker />);
    expect(desktop.record).not.toHaveBeenCalled();
  });
});
