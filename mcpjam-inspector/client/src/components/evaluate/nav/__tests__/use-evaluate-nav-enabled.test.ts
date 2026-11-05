import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  EVALUATE_NAV_FLAG_TIMEOUT_MS,
  useEvaluateNavEnabled,
} from "../use-evaluate-nav-enabled";

const posthog = vi.hoisted(() => ({
  value: undefined as boolean | undefined,
  featureFlags: { hasLoadedFlags: false },
}));
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => posthog.value,
  usePostHog: () => posthog,
  useActiveFeatureFlags: () => [],
}));

describe("useEvaluateNavEnabled", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    posthog.value = undefined;
    posthog.featureFlags.hasLoadedFlags = false;
  });

  it.each([true, false])("returns the flag when it loads as %s", (value) => {
    posthog.value = value;
    posthog.featureFlags.hasLoadedFlags = true;
    const { result } = renderHook(() => useEvaluateNavEnabled());
    expect(result.current).toBe(value);
  });

  it("waits while flags load, then shows today's page after the timeout", () => {
    const { result, rerender } = renderHook(() => useEvaluateNavEnabled());
    expect(result.current).toBeUndefined();
    act(() => vi.advanceTimersByTime(EVALUATE_NAV_FLAG_TIMEOUT_MS - 1));
    expect(result.current).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
    // A late answer does not swap the page under the user.
    posthog.value = true;
    rerender();
    expect(result.current).toBe(false);
  });

  it("uses a flag that arrives before the timeout", () => {
    const { result, rerender } = renderHook(() => useEvaluateNavEnabled());
    posthog.value = true;
    rerender();
    act(() => vi.advanceTimersByTime(EVALUATE_NAV_FLAG_TIMEOUT_MS));
    expect(result.current).toBe(true);
  });

  it("treats a failed load, flags loaded without this one, as off", () => {
    posthog.featureFlags.hasLoadedFlags = true;
    const { result } = renderHook(() => useEvaluateNavEnabled());
    expect(result.current).toBe(false);
  });
});
