import { useFeatureFlagEnabled } from "posthog-js/react";

export const DESCRIPTION_EXPERIMENT_FEATURE_FLAG =
  "description-experiments-enabled";

/**
 * Controlled description-rewrite experiments on the Evaluate run page.
 *
 * Fail-closed: `useFeatureFlagEnabled` is `undefined` while flags load, and
 * that is treated as off. Flag off means no computation, no DOM, and no
 * requests — the propose buttons and the card are not mounted.
 */
export function useDescriptionExperimentEnabled(): boolean {
  return useFeatureFlagEnabled(DESCRIPTION_EXPERIMENT_FEATURE_FLAG) === true;
}
