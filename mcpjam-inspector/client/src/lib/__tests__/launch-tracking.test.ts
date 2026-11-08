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

function startLaunch(options?: { timeoutMs?: number }): () => void {
  const cancel = trackLaunchWhenPolicySettles(launch, options);
  pending.push(cancel);
  return cancel;
}

function grantContent(actor = "user_A"): void {
  setTelemetryContentPolicy(actor, "full");
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.track.mockClear();
  setTelemetryActor("user_A");
  setTelemetryCaptureContext({ projectIds: ["project_A"], organizationIds: [] });
});

afterEach(() => {
  pending.splice(0).forEach((cancel) => cancel());
  vi.useRealTimers();
  setTelemetryActor(null);
  setTelemetryCaptureContext({ projectIds: [], organizationIds: [] });
});

describe("trackLaunchWhenPolicySettles", () => {
  it("sends at once when content is already granted", () => {
    grantContent();
    startLaunch();
    expect(mocks.track).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("app_launched", launch);
  });

  it("waits for the grant, then sends once", () => {
    startLaunch();
    vi.advanceTimersByTime(2_000);
    expect(mocks.track).not.toHaveBeenCalled();
    grantContent();
    expect(mocks.track).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    setTelemetryContentPolicy("user_A", "strict");
    grantContent();
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
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("sends on pagehide so a short visit is counted, and only once", () => {
    startLaunch();
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.track).toHaveBeenCalledTimes(1);
    grantContent();
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
    window.dispatchEvent(new Event("pagehide"));
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });

  it("never sends once cancelled", () => {
    const cancel = startLaunch();
    cancel();
    grantContent();
    vi.advanceTimersByTime(LAUNCH_POLICY_TIMEOUT_MS);
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
});
