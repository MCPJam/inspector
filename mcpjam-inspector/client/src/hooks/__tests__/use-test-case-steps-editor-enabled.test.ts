import { act, renderHook } from "@testing-library/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STEPS_EDITOR_FLAG_WAIT_MS,
  useTestCaseStepsEditorEnabled,
} from "../use-test-case-steps-editor-enabled";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: vi.fn() }));

afterEach(() => vi.useRealTimers());

describe("useTestCaseStepsEditorEnabled", () => {
  it.each([true, false])("returns PostHog's %s", (value) => {
    vi.mocked(useFeatureFlagEnabled).mockReturnValue(value);
    const { result } = renderHook(() => useTestCaseStepsEditorEnabled());
    expect(result.current).toBe(value);
    expect(useFeatureFlagEnabled).toHaveBeenCalledWith(
      "eval-test-case-steps-editor",
    );
  });

  it("waits while flags load, then reads false if they never arrive", () => {
    vi.useFakeTimers();
    vi.mocked(useFeatureFlagEnabled).mockReturnValue(undefined);
    const { result } = renderHook(() => useTestCaseStepsEditorEnabled());
    expect(result.current).toBeUndefined();
    act(() => vi.advanceTimersByTime(STEPS_EDITOR_FLAG_WAIT_MS));
    expect(result.current).toBe(false);
    // Later cases in the same page load don't wait again.
    const next = renderHook(() => useTestCaseStepsEditorEnabled());
    expect(next.result.current).toBe(false);
  });

  it("keeps its first answer when the flag changes later", () => {
    const flag = vi.mocked(useFeatureFlagEnabled);
    flag.mockReturnValue(undefined);
    // Flags already missed the wait in this page load, so this reads false.
    const late = renderHook(() => useTestCaseStepsEditorEnabled());
    expect(late.result.current).toBe(false);
    flag.mockReturnValue(true);
    late.rerender();
    expect(late.result.current).toBe(false);
    const on = renderHook(() => useTestCaseStepsEditorEnabled());
    expect(on.result.current).toBe(true);
    flag.mockReturnValue(false);
    on.rerender();
    expect(on.result.current).toBe(true);
  });
});
