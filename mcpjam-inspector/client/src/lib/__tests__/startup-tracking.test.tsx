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
    renderHook(() => useStartupTracking(waiting));
    // PostHogProvider initializes in its own effect, after this child's.
    expect(sent("app_startup_started")).toHaveLength(0);
    act(() => vi.runAllTimers());
    expect(sent("app_startup_started")).toHaveLength(1);
  });

  it("counts a launch once, even when StrictMode mounts it twice", () => {
    renderHook(() => useStartupTracking(waiting), { wrapper: strict });
    act(() => vi.runAllTimers());
    expect(sent("app_startup_started")).toEqual([
      ["app_startup_started", { location: "app" }],
    ]);
  });

  it("reports a block from a failure once, with its stage", () => {
    const { rerender } = renderHook(
      (status: StartupStatus) => useStartupTracking(status),
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
      useStartupTracking({
        ...waiting,
        escalated: true,
        stage: "app_load/user_setup_pending",
      }),
    );
    expect(sent("app_startup_blocked")[0]![1]).toMatchObject({
      trigger: "deadline",
      stage: "app_load/user_setup_pending",
    });
  });

  it("sends no block for a launch that never escalates", () => {
    renderHook(() => useStartupTracking(waiting));
    expect(sent("app_startup_blocked")).toHaveLength(0);
  });
});
