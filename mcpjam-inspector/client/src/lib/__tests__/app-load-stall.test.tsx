import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reportCaught: vi.fn() }));

vi.mock("../error-reporting", () => ({ reportCaught: state.reportCaught }));

import {
  AppLoadStalledError,
  resetAppLoadStallForTests,
  useAppLoadStallReport,
} from "../app-load-stall";
import {
  APP_LOAD_STALL_MS,
  type AppLoadStallCode,
} from "@/shared/app-load-stall";

type Props = { ready: boolean; stage: AppLoadStallCode };

function renderReport(initialProps: Props) {
  return renderHook(
    ({ ready, stage }: Props) => useAppLoadStallReport(ready, stage),
    { initialProps },
  );
}

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
    state.reportCaught.mockReset();
  });

  it("reports once, naming the stuck step, when the app never becomes usable", () => {
    const { rerender } = renderReport({
      ready: false,
      stage: "app_load/session_refresh_failed",
    });

    vi.advanceTimersByTime(APP_LOAD_STALL_MS - 1);
    expect(state.reportCaught).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(state.reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = state.reportCaught.mock.calls[0]!;
    expect(error).toBeInstanceOf(AppLoadStalledError);
    expect(options).toEqual({
      source: "app_load_stall",
      level: "error",
      extra: { code: "app_load/session_refresh_failed" },
    });

    rerender({ ready: false, stage: "app_load/auth_pending" });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).toHaveBeenCalledTimes(1);
  });

  it("names the stage at the moment it fires, not when it started", () => {
    const { rerender } = renderReport({
      ready: false,
      stage: "app_load/auth_pending",
    });
    rerender({ ready: false, stage: "app_load/user_setup_pending" });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS);
    expect(state.reportCaught.mock.calls[0]![1].extra).toEqual({
      code: "app_load/user_setup_pending",
    });
  });

  it("counts from page start, not from when the hook mounted", () => {
    vi.spyOn(performance, "now").mockReturnValue(APP_LOAD_STALL_MS - 100);
    renderReport({ ready: false, stage: "app_load/auth_pending" });
    vi.advanceTimersByTime(100);
    expect(state.reportCaught).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the app becomes usable in time", () => {
    const { rerender } = renderReport({
      ready: false,
      stage: "app_load/auth_pending",
    });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS / 2);
    rerender({ ready: true, stage: "app_load/auth_pending" });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).not.toHaveBeenCalled();
  });

  it("does not treat a later sign-out as a failed load", () => {
    const { rerender } = renderReport({
      ready: true,
      stage: "app_load/auth_pending",
    });
    rerender({ ready: false, stage: "app_load/auth_pending" });
    vi.advanceTimersByTime(APP_LOAD_STALL_MS * 2);
    expect(state.reportCaught).not.toHaveBeenCalled();
  });
});
