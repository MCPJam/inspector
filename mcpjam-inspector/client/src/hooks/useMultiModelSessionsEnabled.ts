import { useFeatureFlagEnabled } from "posthog-js/react";

export const MULTI_MODEL_SESSIONS_FEATURE_FLAG = "playground-multi-model-sessions";

/**
 * Multi-model sessions in Sessions: the grouped row, reopening every column,
 * and the single-column branch. Columns save their group whether or not this
 * is on; the saved group does nothing until the flag shows it.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, treated as off,
 * so a cold load shows today's Sessions rail rather than flickering through it.
 */
export function useMultiModelSessionsEnabled(): boolean {
  return useFeatureFlagEnabled(MULTI_MODEL_SESSIONS_FEATURE_FLAG) === true;
}
