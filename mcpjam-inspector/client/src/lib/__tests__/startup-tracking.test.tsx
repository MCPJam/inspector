import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../analytics", () => ({ track: state.track }));

import {
  resetStartupTrackingForTests,
  useStartupTracking,
} from "../startup-tracking";
import type { StartupStatus } from "../startup-status";
import { STRICT_COUNT_MAX } from "@/shared/strict-posthog";

const waiting: StartupStatus = {
  escalated: false,
  stage: "app_load/auth_pending",
  failureKind: null,
  refusalReason: null,
  retrying: false,
};

const strict = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

const sent = (event: string) =>
  state.track.mock.calls.filter(([name]) => name === event);

describe("useStartupTracking", () => {
  beforeEach(() => {
    resetStartupTrackingForTests();
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(21_400);
  });
  afterEach(() => {
    state.track.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits a task before counting the launch, so PostHog has initialized", () => {
    renderHook(() => useStartupTracking(waiting, false));
    // PostHogProvider initializes in its own effect, after this child's.
    expect(sent("app_startup_started")).toHaveLength(0);
    act(() => vi.runAllTimers());
    expect(sent("app_startup_started")).toHaveLength(1);
  });

  it("counts a launch once, even when StrictMode mounts it twice", () => {
    renderHook(() => useStartupTracking(waiting, false), { wrapper: strict });
    act(() => vi.runAllTimers());
    expect(sent("app_startup_started")).toEqual([
      ["app_startup_started", { location: "app" }],
    ]);
  });

  it("reports a block from a failure once, with its stage", () => {
    const { rerender } = renderHook(
      (status: StartupStatus) => useStartupTracking(status, false),
      { initialProps: waiting },
    );
    const failed: StartupStatus = {
      ...waiting,
      escalated: true,
      stage: "app_load/session_refresh_failed",
      failureKind: "transient",
    };
    rerender(failed);
    rerender({ ...failed, retrying: true });
    expect(sent("app_startup_blocked")).toEqual([
      [
        "app_startup_blocked",
        {
          location: "app",
          stage: "app_load/session_refresh_failed",
          trigger: "failure",
          elapsed_ms: 21_400,
        },
      ],
    ]);
  });

  it("names the deadline when nothing failed", () => {
    renderHook(() =>
      useStartupTracking(
        {
          ...waiting,
          escalated: true,
          stage: "app_load/user_setup_pending",
        },
        false,
      ),
    );
    expect(sent("app_startup_blocked")[0]![1]).toMatchObject({
      trigger: "deadline",
      stage: "app_load/user_setup_pending",
    });
  });

  it("sends no block for a launch that never escalates", () => {
    renderHook(() => useStartupTracking(waiting, false));
    expect(sent("app_startup_blocked")).toHaveLength(0);
  });

  it("does not count a failure after the app was usable as a blocked launch", () => {
    const { rerender } = renderHook(
      ({ status, ready }: { status: StartupStatus; ready: boolean }) =>
        useStartupTracking(status, ready),
      { initialProps: { status: waiting, ready: true } },
    );
    rerender({
      status: {
        ...waiting,
        escalated: true,
        stage: "app_load/session_refresh_failed",
        failureKind: "transient",
      },
      ready: false,
    });
    expect(sent("app_startup_blocked")).toHaveLength(0);
  });

  it("keeps elapsed_ms within what the strict relay accepts", () => {
    vi.spyOn(performance, "now").mockReturnValue(STRICT_COUNT_MAX * 2);
    renderHook(() =>
      useStartupTracking({ ...waiting, escalated: true }, false),
    );
    expect(sent("app_startup_blocked")[0]![1]).toMatchObject({
      elapsed_ms: STRICT_COUNT_MAX,
    });
  });
});
