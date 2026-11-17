import { renderHook } from "@testing-library/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { describe, expect, it, vi } from "vitest";
import {
  SUITE_RESULTS_PAGE_FEATURE_FLAG,
  useSuiteResultsPageEnabled,
} from "../use-suite-results-page-enabled";

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: vi.fn() }));

describe("useSuiteResultsPageEnabled", () => {
  it.each([undefined, true, false])(
    "returns PostHog's %s unchanged",
    (value) => {
      vi.mocked(useFeatureFlagEnabled).mockReturnValue(value);
      const { result } = renderHook(() => useSuiteResultsPageEnabled());
      expect(result.current).toBe(value);
      expect(useFeatureFlagEnabled).toHaveBeenCalledWith(
        "eval-suite-results-page",
      );
      expect(SUITE_RESULTS_PAGE_FEATURE_FLAG).toBe("eval-suite-results-page");
    },
  );
});
