import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  usePostHog,
  setOrganizationRecordingOptOut,
  syncSessionRecordingForPath,
  syncSentryReplayForPath,
} = vi.hoisted(() => ({
  usePostHog: vi.fn(),
  setOrganizationRecordingOptOut: vi.fn(),
  syncSessionRecordingForPath: vi.fn(),
  syncSentryReplayForPath: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({ usePostHog }));
vi.mock("@/lib/PosthogUtils", () => ({
  setOrganizationRecordingOptOut,
  syncSessionRecordingForPath,
}));
vi.mock("@/lib/sentry", () => ({ syncSentryReplayForPath }));

import { useSessionRecordingOrgGuard } from "../useSessionRecordingOrgGuard";

const posthogClient = { startSessionRecording: vi.fn() };

describe("useSessionRecordingOrgGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/servers");
  });

  it("decides nothing while the organization list has not answered", () => {
    // An unknown answer must neither stop nor resume a recorder, and must not
    // overwrite the remembered answer that is covering this load.
    usePostHog.mockReturnValue(posthogClient);

    renderHook(() => useSessionRecordingOrgGuard(undefined));

    expect(setOrganizationRecordingOptOut).not.toHaveBeenCalled();
    expect(syncSessionRecordingForPath).not.toHaveBeenCalled();
    expect(syncSentryReplayForPath).not.toHaveBeenCalled();
  });

  it("records the answer, then applies both recorders for the current location", () => {
    usePostHog.mockReturnValue(posthogClient);

    renderHook(() => useSessionRecordingOrgGuard(true));

    expect(setOrganizationRecordingOptOut).toHaveBeenCalledWith(true);
    expect(syncSessionRecordingForPath).toHaveBeenCalledWith(
      posthogClient,
      "/servers",
    );
    expect(syncSentryReplayForPath).toHaveBeenCalledWith("/servers");
    // The guards read the answer, so it must be in place before they run.
    expect(
      setOrganizationRecordingOptOut.mock.invocationCallOrder[0],
    ).toBeLessThan(syncSessionRecordingForPath.mock.invocationCallOrder[0]);
    expect(
      setOrganizationRecordingOptOut.mock.invocationCallOrder[0],
    ).toBeLessThan(syncSentryReplayForPath.mock.invocationCallOrder[0]);
  });

  it("re-applies on an organization switch", () => {
    usePostHog.mockReturnValue(posthogClient);

    const { rerender } = renderHook(
      ({ optedOut }: { optedOut: boolean | undefined }) =>
        useSessionRecordingOrgGuard(optedOut),
      { initialProps: { optedOut: true as boolean | undefined } },
    );
    rerender({ optedOut: false });

    expect(setOrganizationRecordingOptOut).toHaveBeenNthCalledWith(2, false);
    expect(syncSessionRecordingForPath).toHaveBeenCalledTimes(2);
    expect(syncSentryReplayForPath).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer while a switch is still resolving", () => {
    usePostHog.mockReturnValue(posthogClient);

    const { rerender } = renderHook(
      ({ optedOut }: { optedOut: boolean | undefined }) =>
        useSessionRecordingOrgGuard(optedOut),
      { initialProps: { optedOut: true as boolean | undefined } },
    );
    rerender({ optedOut: undefined });

    expect(setOrganizationRecordingOptOut).toHaveBeenCalledTimes(1);
    expect(syncSessionRecordingForPath).toHaveBeenCalledTimes(1);
  });

  it("still guards Sentry Replay when PostHog is unavailable", () => {
    // Same asymmetry as the path guard: PostHog is routinely ad-blocked,
    // Sentry Replay is not gated on it.
    usePostHog.mockReturnValue(undefined);

    renderHook(() => useSessionRecordingOrgGuard(true));

    expect(setOrganizationRecordingOptOut).toHaveBeenCalledWith(true);
    expect(syncSessionRecordingForPath).not.toHaveBeenCalled();
    expect(syncSentryReplayForPath).toHaveBeenCalledWith("/servers");
  });
});
