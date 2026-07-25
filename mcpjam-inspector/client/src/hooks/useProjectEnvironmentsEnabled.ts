import { useFeatureFlagEnabled } from "posthog-js/react";

export const PROJECT_ENVIRONMENTS_FEATURE_FLAG = "project-environments-enabled";

/**
 * Project Environments (named host + server group + pinned skills bundles)
 * are gated behind a PostHog flag while the backend launch contract rolls
 * out. Gates EVERY client exposure — sidebar item, suite settings row, and
 * direct `/environments` navigation.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (fail-closed) by {@link useProjectEnvironmentsEnabled}. Route guards
 * that want to distinguish "loading" from "off" (to avoid bouncing a
 * flagged-in user who cold-loads /environments) should use
 * {@link useProjectEnvironmentsEnabledState} instead.
 */
export function useProjectEnvironmentsEnabled(): boolean {
  return useFeatureFlagEnabled(PROJECT_ENVIRONMENTS_FEATURE_FLAG) === true;
}

/** Tri-state variant: `undefined` while PostHog flags are still loading. */
export function useProjectEnvironmentsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(PROJECT_ENVIRONMENTS_FEATURE_FLAG);
}
