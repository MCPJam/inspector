import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  usePostHog,
  getAppRouter,
  syncSessionRecordingForPath,
  syncSentryReplayForPath,
} = vi.hoisted(() => ({
  usePostHog: vi.fn(),
  getAppRouter: vi.fn(),
  syncSessionRecordingForPath: vi.fn(),
  syncSentryReplayForPath: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({ usePostHog }));
vi.mock("@/router-ref", () => ({ getAppRouter }));
vi.mock("@/lib/PosthogUtils", () => ({ syncSessionRecordingForPath }));
vi.mock("@/lib/sentry", () => ({ syncSentryReplayForPath }));

import { useSessionRecordingPathGuard } from "../useSessionRecordingPathGuard";

const posthogClient = { startSessionRecording: vi.fn() };

describe("useSessionRecordingPathGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAppRouter.mockReturnValue(undefined);
    window.history.replaceState({}, "", "/results/secret-token");
  });

  it("applies both recorders for the current location on mount", () => {
    usePostHog.mockReturnValue(posthogClient);

    renderHook(() => useSessionRecordingPathGuard());

    expect(syncSessionRecordingForPath).toHaveBeenCalledWith(
      posthogClient,
      "/results/secret-token",
    );
    expect(syncSentryReplayForPath).toHaveBeenCalledWith(
      "/results/secret-token",
    );
  });

  it("still guards Sentry Replay when PostHog is unavailable", () => {
    // PostHog is routinely ad-blocked, and `VITE_DISABLE_POSTHOG_LOCAL`
    // builds have no client at all. Sentry Replay is gated on the platform,
    // not on PostHog — bailing out early would leave it recording the
    // token-bearing page.
    usePostHog.mockReturnValue(undefined);

    renderHook(() => useSessionRecordingPathGuard());

    expect(syncSessionRecordingForPath).not.toHaveBeenCalled();
    expect(syncSentryReplayForPath).toHaveBeenCalledWith(
      "/results/secret-token",
    );
  });

  it("re-applies on every router navigation, PostHog present or not", () => {
    usePostHog.mockReturnValue(undefined);
    let notify: ((state: { location: { pathname: string } }) => void) | undefined;
    getAppRouter.mockReturnValue({
      subscribe: (fn: (state: { location: { pathname: string } }) => void) => {
        notify = fn;
        return () => {};
      },
    });

    renderHook(() => useSessionRecordingPathGuard());
    notify?.({ location: { pathname: "/results/another-token" } });

    expect(syncSentryReplayForPath).toHaveBeenNthCalledWith(
      2,
      "/results/another-token",
    );
    expect(syncSessionRecordingForPath).not.toHaveBeenCalled();
  });

  it("unsubscribes from the router on unmount", () => {
    usePostHog.mockReturnValue(posthogClient);
    const unsubscribe = vi.fn();
    getAppRouter.mockReturnValue({ subscribe: () => unsubscribe });

    renderHook(() => useSessionRecordingPathGuard()).unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
