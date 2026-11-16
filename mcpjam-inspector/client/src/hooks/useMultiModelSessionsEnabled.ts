import { useFeatureFlagEnabled } from "posthog-js/react";

export const MULTI_MODEL_SESSIONS_FEATURE_FLAG = "playground-multi-model-sessions";

/**
 * Multi-model sessions in Sessions: the grouped row, reopening every column,
 * and the single-column branch. While it is off, columns save no group, so
 * turning it on groups only the sessions started after that.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, treated as off,
 * so a cold load shows today's Sessions rail rather than flickering through it.
 */
export function useMultiModelSessionsEnabled(): boolean {
  return useFeatureFlagEnabled(MULTI_MODEL_SESSIONS_FEATURE_FLAG) === true;
}
