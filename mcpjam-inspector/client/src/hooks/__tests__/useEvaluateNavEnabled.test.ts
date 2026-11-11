import { renderHook } from "@testing-library/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { describe, expect, it, vi } from "vitest";
import {
  EVALUATE_NAV_FEATURE_FLAG,
  useEvaluateNavEnabled,
} from "../useEvaluateNavEnabled";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: vi.fn() }));

describe("useEvaluateNavEnabled", () => {
  it.each([undefined, true, false])(
    "returns PostHog's %s unchanged",
    (value) => {
      vi.mocked(useFeatureFlagEnabled).mockReturnValue(value);
      const { result } = renderHook(() => useEvaluateNavEnabled());
      expect(result.current).toBe(value);
      expect(useFeatureFlagEnabled).toHaveBeenCalledWith(
        "evaluate-nav-enabled",
      );
      expect(EVALUATE_NAV_FEATURE_FLAG).toBe("evaluate-nav-enabled");
    },
  );
});
