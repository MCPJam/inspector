import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hosted: false,
  authenticated: false,
  refused: false,
  refreshStatus: "idle" as "idle" | "failed" | "retrying",
  reportCaught: vi.fn(),
}));

vi.mock("../config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isLoading: false,
    isAuthenticated: state.authenticated,
  }),
}));
vi.mock("../error-reporting", () => ({ reportCaught: state.reportCaught }));
vi.mock("../guest-session", () => ({
  getGuestSessionRefusal: () => (state.refused ? { until: Infinity } : null),
}));
vi.mock("@/stores/session-refresh-store", () => ({
  useSessionRefreshStore: {
    getState: () => ({ status: state.refreshStatus }),
  },
}));

import {
  AppLoadStalledError,
  resetAppLoadStallForTests,
  useAppLoadStallReport,
} from "../app-load-stall";
import { APP_LOAD_STALL_MS } from "@/shared/app-load-stall";

describe("useAppLoadStallReport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The page "started" just now, so the whole budget is still ahead.
    vi.spyOn(performance, "now").mockReturnValue(0);
    resetAppLoadStallForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.assign(state, {
      hosted: false,
      authenticated: false,
      refused: false,
      refreshStatus: "idle",
    });
    state.reportCaught.mockReset();
  });

  it("reports once, naming the stuck step, when the app never becomes usable", () => {
    state.refreshStatus = "failed";
    const { rerender } = renderHook(
      ({ ready }) => useAppLoadStallReport(ready, true),
      { initialProps: { ready: false } },
    );

    vi.advanceTimersByTime(APP_LOAD_STALL_MS - 1);
    expect(state.reportCaught).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(state.reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = state.reportCaught.mock.calls[0]!;
    expect(error).toBeInstanceOf(AppLoadStalledError);
    expect(options).toEqual({
      source: "app_load_stall",
      level: "error",
      extra: { code: "app_load/guest_session_failed" },
    });

    rerender({ ready: false });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).toHaveBeenCalledTimes(1);
  });

  it("tells an actor that never resolved from a user record still being set up", () => {
    state.authenticated = true;
    renderHook(() => useAppLoadStallReport(false, false));
    vi.advanceTimersByTime(APP_LOAD_STALL_MS);
    expect(state.reportCaught.mock.calls[0]![1].extra).toEqual({
      code: "app_load/actor_pending",
    });

    resetAppLoadStallForTests();
    state.reportCaught.mockReset();
    renderHook(() => useAppLoadStallReport(false, true));
    vi.advanceTimersByTime(APP_LOAD_STALL_MS);
    expect(state.reportCaught.mock.calls[0]![1].extra).toEqual({
      code: "app_load/user_setup_pending",
    });
  });

  it("counts from page start, not from when the hook mounted", () => {
    vi.spyOn(performance, "now").mockReturnValue(APP_LOAD_STALL_MS - 100);
    renderHook(() => useAppLoadStallReport(false, true));
    vi.advanceTimersByTime(100);
    expect(state.reportCaught).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the app becomes usable in time", () => {
    const { rerender } = renderHook(
      ({ ready }) => useAppLoadStallReport(ready, true),
      { initialProps: { ready: false } },
    );
    vi.advanceTimersByTime(APP_LOAD_STALL_MS / 2);
    rerender({ ready: true });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).not.toHaveBeenCalled();
  });

  it("does not treat a later sign-out as a failed load", () => {
    const { rerender } = renderHook(
      ({ ready }) => useAppLoadStallReport(ready, true),
      { initialProps: { ready: true } },
    );
    rerender({ ready: false });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).not.toHaveBeenCalled();
  });

  it("does nothing on the hosted app", () => {
    state.hosted = true;
    renderHook(() => useAppLoadStallReport(false, true));
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).not.toHaveBeenCalled();
  });
});
