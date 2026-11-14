import { Activity, createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../analytics", () => ({ track: mocks.track }));

import {
  LAUNCH_POLICY_TIMEOUT_MS,
  trackLaunchWhenPolicySettles,
  useAppLaunchedEvent,
} from "../launch-tracking";
import {
  setTelemetryActor,
  setTelemetryCaptureContext,
  setTelemetryContentPolicy,
} from "../telemetry-context";

const launch = { location: "app", is_authenticated: true };
const pending: Array<() => void> = [];
const cleanups: Array<() => void> = [];

function startLaunch(options?: { timeoutMs?: number }): () => void {
  const cancel = trackLaunchWhenPolicySettles(launch, options);
  pending.push(cancel);
  return cancel;
}

function grantContent(actor = "user_A"): void {
  setTelemetryContentPolicy(actor, "full");
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function hidePage(): void {
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
}

function sentWith(trigger: string, waitMs: number) {
  return [
    "app_launched",
    { ...launch, launch_trigger: trigger, policy_wait_ms: waitMs },
  ];
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.track.mockClear();
  setVisibility("visible");
  setTelemetryActor("user_A");
  setTelemetryCaptureContext({
    projectIds: ["project_A"],
    organizationIds: [],
  });
});

afterEach(() => {
  pending.splice(0).forEach((cancel) => cancel());
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
  setVisibility("visible");
  setTelemetryActor(null);
  setTelemetryCaptureContext({ projectIds: [], organizationIds: [] });
});

describe("trackLaunchWhenPolicySettles", () => {
  it("sends at once when content is already granted", () => {
    grantContent();
    startLaunch();
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track.mock.calls[0]).toEqual(sentWith("immediate", 0));
  });

  it("waits for the grant, then sends once with the measured wait", () => {
    startLaunch();
    vi.advanceTimersByTime(2_000);
    expect(mocks.track).not.toHaveBeenCalled();
    grantContent();
    expect(mocks.track.mock.calls).toEqual([sentWith("grant", 2_000)]);
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    setTelemetryContentPolicy("user_A", "strict");
    grantContent();
    hidePage();
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("ignores policy notifications that are not a grant", () => {
    startLaunch();
    setTelemetryContentPolicy("user_A", "strict");
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("sends at the timeout when no grant arrives", () => {
    startLaunch({ timeoutMs: 5_000 });
    vi.advanceTimersByTime(4_999);
    expect(mocks.track).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mocks.track.mock.calls).toEqual([sentWith("timeout", 5_000)]);
  });

  it("sends when the page becomes hidden, and only once", () => {
    startLaunch();
    vi.advanceTimersByTime(800);
    hidePage();
    expect(mocks.track.mock.calls).toEqual([sentWith("hidden", 800)]);
    window.dispatchEvent(new Event("pagehide"));
    grantContent();
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("does not send when visibility changes to visible", () => {
    startLaunch();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("falls back to pagehide when the browser skips visibilitychange", () => {
    startLaunch();
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.track.mock.calls).toEqual([sentWith("hidden", 0)]);
  });

  // Models posthog-js, which registers its pagehide flush at init, before
  // the launch listener exists. This checks listener ordering with a
  // stand-in flush; it does not run the real posthog-js queue.
  it("enqueues the launch before an earlier-registered pagehide flush", () => {
    let callsAtFlush = -1;
    const flush = () => {
      callsAtFlush = mocks.track.mock.calls.length;
    };
    window.addEventListener("pagehide", flush);
    cleanups.push(() => window.removeEventListener("pagehide", flush));
    startLaunch();
    // Browser order on close: visibilitychange (hidden), then pagehide.
    hidePage();
    window.dispatchEvent(new Event("pagehide"));
    expect(callsAtFlush).toBe(1);
  });

  it("never sends once cancelled", () => {
    const cancel = startLaunch();
    cancel();
    grantContent();
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    hidePage();
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.track).not.toHaveBeenCalled();
  });
});

describe("useAppLaunchedEvent", () => {
  it("sends one launch per actor across re-renders", () => {
    grantContent();
    const { rerender } = renderHook(
      ({ actor, authed }) => useAppLaunchedEvent(actor, authed),
      { initialProps: { actor: "user_A", authed: false } },
    );
    rerender({ actor: "user_A", authed: true });
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track.mock.calls[0][1]).toMatchObject({
      location: "app",
      is_authenticated: false,
      launch_trigger: "immediate",
    });
  });

  it("keeps a pending launch when other props change", () => {
    const { rerender } = renderHook(
      ({ actor, authed }) => useAppLaunchedEvent(actor, authed),
      { initialProps: { actor: "user_A", authed: false } },
    );
    rerender({ actor: "user_A", authed: true });
    grantContent();
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending launch when the actor changes", () => {
    const { rerender } = renderHook(
      ({ actor }) => useAppLaunchedEvent(actor, false),
      { initialProps: { actor: "guest_A" as string | null } },
    );
    setTelemetryActor("user_B");
    rerender({ actor: "user_B" });
    grantContent("user_B");
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("sends nothing without an actor", () => {
    renderHook(() => useAppLaunchedEvent(null, false));
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("cancels a pending launch on unmount", () => {
    const { unmount } = renderHook(() => useAppLaunchedEvent("user_A", false));
    unmount();
    grantContent();
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    hidePage();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  // StrictMode's dev double mount tears effects down and re-runs them on the
  // same instance, keeping refs. React does not replay that in this test
  // environment, so <Activity> stands in: hiding runs the effect cleanups,
  // showing re-runs the effects, and refs survive both.
  it("resends after its effects are torn down and re-run on the same instance", () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(Activity, { mode: activityMode }, children);
    let activityMode: "visible" | "hidden" = "visible";
    const { rerender } = renderHook(
      () => useAppLaunchedEvent("user_A", false),
      {
        wrapper,
      },
    );
    activityMode = "hidden";
    rerender();
    activityMode = "visible";
    rerender();
    grantContent();
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });
});
