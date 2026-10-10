import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePostHog, getAppRouter, syncSessionRecording, syncSentryReplay } =
  vi.hoisted(() => ({
    usePostHog: vi.fn(),
    getAppRouter: vi.fn(),
    syncSessionRecording: vi.fn(),
    syncSentryReplay: vi.fn(),
  }));

vi.mock("posthog-js/react", () => ({ usePostHog }));
vi.mock("@/router-ref", () => ({ getAppRouter }));
vi.mock("@/lib/session-privacy", () => ({
  syncSessionRecording,
  isCredentialBearingPath: (location: { pathname: string }) =>
    location.pathname.startsWith("/results/"),
}));
vi.mock("@/lib/sentry", () => ({ syncSentryReplay }));

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

    expect(syncSessionRecording).toHaveBeenCalledWith(
      posthogClient,
      expect.objectContaining({ pathname: "/results/secret-token" }),
    );
    expect(syncSentryReplay).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/results/secret-token" }),
    );
  });

  it("still guards Sentry Replay when PostHog is unavailable", () => {
    // PostHog is routinely ad-blocked, and `VITE_DISABLE_POSTHOG_LOCAL`
    // builds have no client at all. Sentry Replay is gated on the platform,
    // not on PostHog — bailing out early would leave it recording the
    // token-bearing page.
    usePostHog.mockReturnValue(undefined);

    renderHook(() => useSessionRecordingPathGuard());

    expect(syncSessionRecording).not.toHaveBeenCalled();
    expect(syncSentryReplay).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/results/secret-token" }),
    );
  });

  it.each([
    ["present", posthogClient],
    ["absent", undefined],
  ])(
    "stops at once when the router heads for a credential location, PostHog %s",
    (_label, client) => {
      usePostHog.mockReturnValue(client);
      let notify:
        ((state: { location: { pathname: string } }) => void) | undefined;
      getAppRouter.mockReturnValue({
        subscribe: (
          fn: (state: { location: { pathname: string } }) => void,
        ) => {
          notify = fn;
          return () => {};
        },
      });

      renderHook(() => useSessionRecordingPathGuard());
      notify?.({ location: { pathname: "/results/another-token" } });

      expect(syncSentryReplay).toHaveBeenLastCalledWith(
        expect.objectContaining({ pathname: "/results/another-token" }),
      );
      if (client) {
        expect(syncSessionRecording).toHaveBeenLastCalledWith(
          client,
          expect.objectContaining({ pathname: "/results/another-token" }),
        );
      } else {
        expect(syncSessionRecording).not.toHaveBeenCalled();
      }
    },
  );

  it("does not resume from the router event: the old page may still be showing", () => {
    usePostHog.mockReturnValue(posthogClient);
    let notify:
      ((state: { location: { pathname: string } }) => void) | undefined;
    getAppRouter.mockReturnValue({
      subscribe: (fn: (state: { location: { pathname: string } }) => void) => {
        notify = fn;
        return () => {};
      },
    });
    renderHook(() => useSessionRecordingPathGuard());
    vi.clearAllMocks();

    notify?.({ location: { pathname: "/servers" } });

    expect(syncSessionRecording).not.toHaveBeenCalled();
    expect(syncSentryReplay).not.toHaveBeenCalled();
  });

  it("resumes once the new location has committed", () => {
    usePostHog.mockReturnValue(posthogClient);
    renderHook(() => useSessionRecordingPathGuard());
    vi.clearAllMocks();

    // Outside a router the committed location is the window's.
    act(() => {
      window.history.replaceState({}, "", "/servers");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(syncSessionRecording).toHaveBeenCalledWith(
      posthogClient,
      expect.objectContaining({ pathname: "/servers" }),
    );
    expect(syncSentryReplay).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/servers" }),
    );
  });

  it("unsubscribes from the router on unmount", () => {
    usePostHog.mockReturnValue(posthogClient);
    const unsubscribe = vi.fn();
    getAppRouter.mockReturnValue({ subscribe: () => unsubscribe });

    renderHook(() => useSessionRecordingPathGuard()).unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
