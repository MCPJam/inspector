import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for choosing which accounts an eval suite runs with
 * (EFTW-5): the Accounts row in suite settings, the "Runs as you" line, the
 * Setup Run account checks, and the accounts a finished run records.
 *
 * Everything it gates reads data only a backend with suite account choices
 * has, so the flag also keeps a browser from asking an older deployment for
 * a function it does not have.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, treated as off
 * (`=== true`) so nothing flickers in before PostHog resolves.
 */
export const EVAL_ACCOUNT_SELECTION_FEATURE_FLAG =
  "eval-account-selection-enabled";

export function useEvalAccountSelectionEnabled(): boolean {
  return useFeatureFlagEnabled(EVAL_ACCOUNT_SELECTION_FEATURE_FLAG) === true;
}
