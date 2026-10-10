import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrivacy } from "@/lib/session-privacy";

const {
  usePostHog,
  setSessionPrivacy,
  syncSessionRecording,
  syncSentryReplay,
} = vi.hoisted(() => ({
  usePostHog: vi.fn(),
  setSessionPrivacy: vi.fn(),
  syncSessionRecording: vi.fn(),
  syncSentryReplay: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({ usePostHog }));
vi.mock("@/lib/session-privacy", () => ({
  setSessionPrivacy,
  syncSessionRecording,
}));
vi.mock("@/lib/sentry", () => ({ syncSentryReplay }));

import {
  MASKED_TO_FULL_SETTLE_MS,
  PRIVACY_PENDING_TIMEOUT_MS,
  useSessionPrivacy,
} from "../useSessionPrivacy";

const posthogClient = { startSessionRecording: vi.fn() };

function render(initial: SessionPrivacy, contextReady = true) {
  return renderHook(
    ({
      level,
      contextReady: ready = true,
    }: {
      level: SessionPrivacy;
      contextReady?: boolean;
    }) => useSessionPrivacy(level, { contextReady: ready }),
    { initialProps: { level: initial, contextReady } },
  );
}

/** The levels handed to the recorders, in order. */
const applied = () => setSessionPrivacy.mock.calls.map(([level]) => level);

describe("useSessionPrivacy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePostHog.mockReturnValue(posthogClient);
    window.history.replaceState({}, "", "/servers");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the level, then syncs both recorders for the current location", () => {
    render("full");

    expect(applied()).toEqual(["full"]);
    expect(syncSessionRecording).toHaveBeenCalledWith(
      posthogClient,
      "/servers",
    );
    expect(syncSentryReplay).toHaveBeenCalledWith("/servers");
    // The recorders read the level, so it must be in place first.
    expect(setSessionPrivacy.mock.invocationCallOrder[0]).toBeLessThan(
      syncSessionRecording.mock.invocationCallOrder[0],
    );
    expect(setSessionPrivacy.mock.invocationCallOrder[0]).toBeLessThan(
      syncSentryReplay.mock.invocationCallOrder[0],
    );
  });

  it("holds the recorders while pending, and fails closed to masked", () => {
    render("pending");
    expect(applied()).toEqual(["pending"]);

    act(() => {
      vi.advanceTimersByTime(PRIVACY_PENDING_TIMEOUT_MS - 1);
    });
    expect(applied()).toEqual(["pending"]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(applied()).toEqual(["pending", "masked"]);
  });

  it("an answer that arrives in time is applied as is", () => {
    const { rerender } = render("pending");
    rerender({ level: "full" });
    act(() => {
      vi.advanceTimersByTime(PRIVACY_PENDING_TIMEOUT_MS);
    });

    expect(applied()).toEqual(["pending", "full"]);
  });

  it("full → masked applies in the same commit, with no unmasked window", () => {
    // No timers involved: the switch must land before anything else runs.
    const { rerender } = render("full");
    rerender({ level: "masked" });

    expect(applied()).toEqual(["full", "masked"]);
    expect(syncSessionRecording).toHaveBeenCalledTimes(2);
  });

  it("masked → full waits for the settle period, recording masked meanwhile", () => {
    const { rerender } = render("masked");
    rerender({ level: "full" });
    expect(applied()).toEqual(["masked"]);

    act(() => {
      vi.advanceTimersByTime(MASKED_TO_FULL_SETTLE_MS);
    });
    expect(applied()).toEqual(["masked", "full"]);
  });

  it("going back to masked inside the settle period cancels the switch", () => {
    const { rerender } = render("masked");
    rerender({ level: "full" });
    rerender({ level: "masked" });
    act(() => {
      vi.advanceTimersByTime(MASKED_TO_FULL_SETTLE_MS * 2);
    });

    expect(applied()).not.toContain("full");
  });

  it("masked → pending → full stays masked through pending and still waits out the settle period", () => {
    const { rerender } = render("masked");
    rerender({ level: "pending" });
    // A navigation whose destination has not answered: masked, not stopped.
    expect(applied()).toEqual(["masked"]);

    rerender({ level: "full" });
    expect(applied()).toEqual(["masked"]);
    act(() => {
      vi.advanceTimersByTime(MASKED_TO_FULL_SETTLE_MS);
    });
    expect(applied()).toEqual(["masked", "full"]);
  });

  it("full → pending (a navigation) goes masked in the same commit", () => {
    const { rerender } = render("full");
    rerender({ level: "pending" });
    expect(applied()).toEqual(["full", "masked"]);
  });

  it("holds full back until the destination has finished loading, then settles", () => {
    const { rerender } = render("masked");
    rerender({ level: "full", contextReady: false });
    act(() => {
      vi.advanceTimersByTime(MASKED_TO_FULL_SETTLE_MS * 3);
    });
    expect(applied()).toEqual(["masked"]);

    rerender({ level: "full", contextReady: true });
    expect(applied()).toEqual(["masked"]);
    act(() => {
      vi.advanceTimersByTime(MASKED_TO_FULL_SETTLE_MS);
    });
    expect(applied()).toEqual(["masked", "full"]);
  });

  it("drops back to masked at once when the destination starts loading again", () => {
    const { rerender } = render("full");
    rerender({ level: "full", contextReady: false });
    expect(applied()).toEqual(["full", "masked"]);
  });

  it("at startup, a full answer whose context is still loading records masked", () => {
    render("full", false);
    expect(applied()).toEqual(["masked"]);
  });

  it("still applies the Sentry half when PostHog is unavailable", () => {
    // PostHog is routinely ad-blocked; Sentry Replay is not gated on it.
    usePostHog.mockReturnValue(undefined);

    render("masked");

    expect(syncSessionRecording).not.toHaveBeenCalled();
    expect(syncSentryReplay).toHaveBeenCalledWith("/servers");
  });
});
