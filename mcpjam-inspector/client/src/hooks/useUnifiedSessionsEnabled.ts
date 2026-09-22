import { useFeatureFlagEnabled } from "posthog-js/react";

export const UNIFIED_SESSIONS_FEATURE_FLAG = "unified-sessions-enabled";

/**
 * The cross-surface Sessions page (`/sessions`) is gated behind one PostHog
 * flag while the backing backend queries (`sessionsFeed:*`) roll out — prod
 * Convex functions only land on a release promotion, so the page must ship
 * dark and be flipped on per-cohort once the backend is live.
 *
 * The sidebar filters the nav item on this flag, but a nav filter is not a
 * gate: `/sessions` is a plain route, so the route guard resolves the same
 * flag (mirrors `useSandboxesEnabled` / `useProjectEnvironmentsEnabled`).
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (fail-closed) here. Route guards that need to tell "loading" from "off"
 * (so a flagged-in user who cold-loads the URL isn't bounced mid-hydrate)
 * should use {@link useUnifiedSessionsEnabledState}.
 */
export function useUnifiedSessionsEnabled(): boolean {
  return useFeatureFlagEnabled(UNIFIED_SESSIONS_FEATURE_FLAG) === true;
}

/** Tri-state variant: `undefined` while PostHog flags are still loading. */
export function useUnifiedSessionsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(UNIFIED_SESSIONS_FEATURE_FLAG);
}
