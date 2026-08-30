import { useFeatureFlagEnabled } from "posthog-js/react";

export const EVALUATE_FEATURE_FLAG = "evaluate-enabled";

/**
 * Evaluate (New) — the redesigned Evaluate tab (`/evaluate`) — is gated behind
 * one PostHog flag while it is dogfooded beside the shipped `/evals` tab.
 *
 * The sidebar filters the nav item on this flag, but a nav filter is not a
 * gate: `/evaluate` is a plain route, and `navSegments` feeds
 * `KNOWN_APP_TAB_SEGMENTS`, so the agent's `ui_navigate` reaches it too. The
 * route guard resolves the same flag (mirrors `useUnifiedSessionsEnabled`).
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (fail-closed) here. Route guards that need to tell "loading" from "off"
 * (so a flagged-in user who cold-loads the URL isn't bounced mid-hydrate)
 * should use {@link useEvaluateEnabledState}.
 */
export function useEvaluateEnabled(): boolean {
  return useFeatureFlagEnabled(EVALUATE_FEATURE_FLAG) === true;
}

/** Tri-state variant: `undefined` while PostHog flags are still loading. */
export function useEvaluateEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(EVALUATE_FEATURE_FLAG);
}
