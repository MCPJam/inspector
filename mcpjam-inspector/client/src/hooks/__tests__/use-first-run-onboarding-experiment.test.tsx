import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  actorKey: "user_1" as string | null,
  flagsActorKey: null as string | null,
  flagsActorListeners: new Set<() => void>(),
  flags: {} as Record<string, string | boolean>,
  postHogDisabled: false,
  getFeatureFlag: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ getFeatureFlag: state.getFeatureFlag }),
  useFeatureFlagVariantKey: () => undefined,
  useActiveFeatureFlags: () => [],
}));

vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => state.actorKey,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  get isPostHogDisabled() {
    return state.postHogDisabled;
  },
}));

vi.mock("@/lib/server-feature-flags", () => ({
  getFeatureFlagsActorKey: () => state.flagsActorKey,
  subscribeFeatureFlagsActor: (listener: () => void) => {
    state.flagsActorListeners.add(listener);
    return () => state.flagsActorListeners.delete(listener);
  },
}));

import {
  FIRST_RUN_EXPERIMENT_WAIT_MS,
  FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG,
  useFirstRunOnboardingExperiment,
} from "../use-first-run-onboarding-experiment";

const HOME_CHECKLIST_FLAG = "home-setup-checklist";

function flagsArriveFor(actorKey: string) {
  act(() => {
    state.flagsActorKey = actorKey;
    for (const listener of state.flagsActorListeners) listener();
  });
}

function experimentExposures() {
  return state.getFeatureFlag.mock.calls.filter(
    ([key]) => key === FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG,
  );
}

describe("useFirstRunOnboardingExperiment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.actorKey = "user_1";
    state.flagsActorKey = "user_1";
    state.flagsActorListeners.clear();
    state.flags = {
      [HOME_CHECKLIST_FLAG]: "treatment",
      [FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG]: "control",
    };
    state.postHogDisabled = false;
    state.getFeatureFlag = vi.fn((key: string) => state.flags[key]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens onboarding for the control arm and records the exposure", () => {
    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));

    expect(result.current).toBe("onboarding");
    expect(experimentExposures()).toHaveLength(1);
  });

  it("skips onboarding for the test arm", () => {
    state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG] = "test";

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));

    expect(result.current).toBe("checklist");
  });

  it("opens onboarding while the experiment flag is off", () => {
    delete state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG];

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));

    expect(result.current).toBe("onboarding");
  });

  it("never reads the experiment flag for a user who is not a candidate", () => {
    state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG] = "test";

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(false));

    expect(result.current).toBe("pending");
    expect(state.getFeatureFlag).not.toHaveBeenCalled();
  });

  it("keeps onboarding, without an exposure, when Home has no checklist", () => {
    state.flags[HOME_CHECKLIST_FLAG] = "control";
    state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG] = "test";

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));

    expect(result.current).toBe("onboarding");
    expect(experimentExposures()).toHaveLength(0);
    expect(state.getFeatureFlag).toHaveBeenCalledWith(HOME_CHECKLIST_FLAG, {
      send_event: false,
    });
  });

  it("waits for this user's own flags instead of the previous actor's", () => {
    state.flagsActorKey = "guest_1";
    state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG] = "test";

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));
    expect(result.current).toBe("pending");
    expect(state.getFeatureFlag).not.toHaveBeenCalled();

    flagsArriveFor("user_1");
    expect(result.current).toBe("checklist");
  });

  it("falls back to onboarding, without an exposure, when flags never arrive", () => {
    state.flagsActorKey = null;

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));
    expect(result.current).toBe("pending");

    act(() => {
      vi.advanceTimersByTime(FIRST_RUN_EXPERIMENT_WAIT_MS);
    });
    expect(result.current).toBe("onboarding");
    expect(experimentExposures()).toHaveLength(0);
  });

  it("keeps its decision when the flag value changes later", () => {
    const { result, rerender } = renderHook(() =>
      useFirstRunOnboardingExperiment(true),
    );
    state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG] = "test";
    rerender();

    expect(result.current).toBe("onboarding");
    expect(experimentExposures()).toHaveLength(1);
  });

  it("opens onboarding without reading flags when PostHog is disabled", () => {
    state.postHogDisabled = true;
    state.flags[FIRST_RUN_ONBOARDING_EXPERIMENT_FLAG] = "test";

    const { result } = renderHook(() => useFirstRunOnboardingExperiment(true));

    expect(result.current).toBe("onboarding");
    expect(state.getFeatureFlag).not.toHaveBeenCalled();
  });
});
