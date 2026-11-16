import { useFeatureFlagEnabled } from "posthog-js/react";

export const TEST_CASE_STEPS_EDITOR_FLAG = "eval-test-case-steps-editor";

/** `undefined` while flags load: a saved case keeps today's editor until `true`. */
export function useTestCaseStepsEditorEnabled(): boolean | undefined {
  return useFeatureFlagEnabled(TEST_CASE_STEPS_EDITOR_FLAG);
}
