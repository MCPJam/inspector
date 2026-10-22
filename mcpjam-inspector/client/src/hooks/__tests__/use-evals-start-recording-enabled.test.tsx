import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVALS_START_RECORDING_FEATURE_FLAG,
  useEvalsStartRecordingEnabled,
} from "../useEvalsStartRecordingEnabled";

const flagMock = vi.hoisted(() => vi.fn<() => boolean | undefined>());
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: flagMock }));

describe("evals-start-recording", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, undefined])("stays off when the flag is %s", (value) => {
    flagMock.mockReturnValue(value);
    const { result } = renderHook(useEvalsStartRecordingEnabled);
    expect(result.current).toBe(false);
    expect(flagMock).toHaveBeenCalledWith(EVALS_START_RECORDING_FEATURE_FLAG);
  });

  it("enables recording only when the flag is true", () => {
    flagMock.mockReturnValue(true);
    const { result } = renderHook(useEvalsStartRecordingEnabled);
    expect(result.current).toBe(true);
    expect(EVALS_START_RECORDING_FEATURE_FLAG).toBe("evals-start-recording");
  });
});
