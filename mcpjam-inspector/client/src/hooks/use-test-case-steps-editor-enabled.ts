import { useEffect, useState } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";

export const TEST_CASE_STEPS_EDITOR_FLAG = "eval-test-case-steps-editor";

/** How long a saved case waits for flags before it keeps today's editor. */
export const STEPS_EDITOR_FLAG_WAIT_MS = 1500;

/** Set once flags miss the wait, so later cases in this page load don't wait. */
let flagsMissed = false;

/**
 * `undefined` while flags load, so a saved case can wait instead of opening
 * today's editor and swapping mid-edit. Flags that never arrive (PostHog
 * blocked or off) read as `false` after a short wait, once per page load.
 */
export function useTestCaseStepsEditorEnabled(): boolean | undefined {
  const enabled = useFeatureFlagEnabled(TEST_CASE_STEPS_EDITOR_FLAG);
  const [timedOut, setTimedOut] = useState(flagsMissed);
  useEffect(() => {
    if (enabled !== undefined || timedOut) return;
    const timer = setTimeout(() => {
      flagsMissed = true;
      setTimedOut(true);
    }, STEPS_EDITOR_FLAG_WAIT_MS);
    return () => clearTimeout(timer);
  }, [enabled, timedOut]);
  return enabled ?? (timedOut ? false : undefined);
}
