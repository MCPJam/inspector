import { useFeatureFlagEnabled } from "posthog-js/react";

export const OBSERVE_FIRST_FEATURE_FLAG = "evaluate-observe-first";

/**
 * Observe-first authoring: the case as a SPINE, "Run test" as a judged
 * one-case suite run, and checks suggested from what the run actually did.
 *
 * It replaces the form, the Steps hatch and the header gear together, so it
 * cannot be half-on — a case editing through the spine while the gear still
 * writes the predicate envelope would have two surfaces disagreeing about who
 * owns `replace`.
 *
 * Resolved ONCE here and threaded as a prop, never read inside the shared
 * editor: `/evals` mounts that same editor and must not see this, and a test
 * then toggles a prop instead of mocking PostHog.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, treated as off
 * (fail-closed), so a cold load shows today's page rather than flickering
 * through it.
 */
export function useObserveFirstEnabled(): boolean {
  return useFeatureFlagEnabled(OBSERVE_FIRST_FEATURE_FLAG) === true;
}
