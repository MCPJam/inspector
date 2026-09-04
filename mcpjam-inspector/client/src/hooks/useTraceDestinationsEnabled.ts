import { useFeatureFlagEnabled } from "posthog-js/react";

export const TRACE_DESTINATIONS_FEATURE_FLAG = "trace-destinations";

/**
 * Whether to ADVERTISE trace destinations — the org-settings nav entry and the
 * Integrations card.
 *
 * The same PostHog key the backend enforces (`POSTHOG_FLAGS.traceDestinations
 * Enabled` in `convex/lib/posthogFeatureFlags.ts`). One flag per feature,
 * deliberately shared: the advertised surface and the enforced surface must be
 * a single lever, or they drift and someone sees a section whose every write
 * is refused.
 *
 * This is NOT the authority on availability — `traceDestinations:getAvailability`
 * is, and the section re-checks it server-side (a member of an org the flag
 * does not cover gets nothing even by typing the URL). This exists because
 * `OrganizationsTab` cannot ask: `useQuery` re-throws during render and that
 * component is not inside an `ErrorBoundary`, so one un-deployed backend would
 * take the whole organization screen down. A flag read cannot throw.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, treated as OFF
 * like every sibling flag hook.
 */
export function useTraceDestinationsEnabled(): boolean {
  return useFeatureFlagEnabled(TRACE_DESTINATIONS_FEATURE_FLAG) === true;
}
