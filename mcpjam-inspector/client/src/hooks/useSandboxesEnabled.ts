import { useFeatureFlagEnabled } from "posthog-js/react";

export const SANDBOXES_FEATURE_FLAG = "sandboxes-enabled";

/**
 * The Scenario + Swarms product surfaces are gated behind one PostHog flag.
 *
 * The sidebar has always filtered its two nav items on this flag
 * (`mcp-sidebar.tsx`), but a nav filter is not a gate: `/swarms` and its
 * siblings are plain routes, so a direct URL (or a stale bookmark) mounted the
 * surface for users the flag excludes. These hooks are what the route guards
 * use so every exposure resolves the same flag.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (fail-closed) here. Route guards that need to tell "loading" from "off"
 * (so a flagged-in user who cold-loads the URL isn't bounced mid-hydrate)
 * should use {@link useSandboxesEnabledState}. Mirrors
 * `useProjectEnvironmentsEnabled`.
 */
export function useSandboxesEnabled(): boolean {
  return useFeatureFlagEnabled(SANDBOXES_FEATURE_FLAG) === true;
}

/** Tri-state variant: `undefined` while PostHog flags are still loading. */
export function useSandboxesEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(SANDBOXES_FEATURE_FLAG);
}
