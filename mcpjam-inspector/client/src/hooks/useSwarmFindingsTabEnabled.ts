import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the Swarm Findings tab (the persona-journey
 * narrative beside Insights | Sessions). Sibling of
 * `useRunDisclosureEnabled` — same fail-closed reasoning: the tab is a new
 * reading of data the detail page already subscribes to, so the gate exists
 * purely to control rollout, never access.
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` both while flags
 * load AND when the flag does not exist, and both are treated as "not
 * enabled" (`=== true`). Flag off means the tab option is absent and a
 * `?tab=findings` deep link coerces to Insights — no other surface knows the
 * feature exists.
 */
export const SWARM_FINDINGS_TAB_FEATURE_FLAG = "swarm-findings-tab";

export function useSwarmFindingsTabEnabled(): boolean {
  return useFeatureFlagEnabled(SWARM_FINDINGS_TAB_FEATURE_FLAG) === true;
}
