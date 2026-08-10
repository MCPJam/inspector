import { useFeatureFlagEnabled } from "posthog-js/react";

export const ADHOC_ENVIRONMENTS_FEATURE_FLAG = "environments-adhoc-enabled";

/**
 * Ad-hoc environments — unnamed, content-addressed rows a surface mints from a
 * loose composition instead of forcing the user to pre-create one.
 *
 * Separate from `project-environments-enabled` because it gates a BACKEND
 * capability, not a UI surface: `projectEnvironments:ensureAdhocEnvironments`
 * has to exist on the deployment being talked to. Self-hosted backends upgrade
 * on their own schedule and the desktop app can meet an old one, so every caller
 * also handles the function being missing at runtime (`isAdhocUnavailable`) —
 * this flag is the deliberate rollout control, that check is the safety net.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load; treated as off.
 */
export function useAdhocEnvironmentsEnabled(): boolean {
  return useFeatureFlagEnabled(ADHOC_ENVIRONMENTS_FEATURE_FLAG) === true;
}
