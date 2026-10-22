import { useFeatureFlagEnabled } from "posthog-js/react";

export const EVALS_START_RECORDING_FEATURE_FLAG = "evals-start-recording";

/** Recording stays hidden until PostHog explicitly enables it. */
export function useEvalsStartRecordingEnabled(): boolean {
  return useFeatureFlagEnabled(EVALS_START_RECORDING_FEATURE_FLAG) === true;
}
