import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRACE_COST_FEATURE_FLAG,
  useTraceCostEnabled,
} from "../useTraceCostEnabled";

const flagMock = vi.hoisted(() => vi.fn<() => boolean | undefined>());
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: flagMock }));

describe("useTraceCostEnabled", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, undefined])("stays off when the flag is %s", (value) => {
    flagMock.mockReturnValue(value);
    const { result } = renderHook(useTraceCostEnabled);
    expect(result.current).toBe(false);
    expect(flagMock).toHaveBeenCalledWith(TRACE_COST_FEATURE_FLAG);
  });

  it("turns on only when the flag is true", () => {
    flagMock.mockReturnValue(true);
    const { result } = renderHook(useTraceCostEnabled);
    expect(result.current).toBe(true);
    expect(TRACE_COST_FEATURE_FLAG).toBe("trace-cost");
  });
});
