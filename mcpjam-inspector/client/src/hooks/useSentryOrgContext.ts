import { useEffect } from "react";
import { setSentryOrganization } from "@/lib/sentry-identity";

/**
 * Keep the Sentry scope's `organization_id` tag pointed at the active org.
 *
 * Deliberately a sibling of `usePostHogOrgContext` rather than a branch inside
 * it: the two sinks have different lifecycles (PostHog registers super
 * properties, Sentry tags a scope) and folding them together would couple an
 * analytics concern to an error-reporting one. Mounting them side by side at
 * the same call site is what keeps them from drifting.
 */
export function useSentryOrgContext(
  organizationId: string | null | undefined
): void {
  useEffect(() => {
    setSentryOrganization(organizationId);
    // Cleared on unmount, not just replaced on the next org. `sentry-identity`
    // promises a scope that carries the current attribution or none, and the
    // scope is global while this hook is not: an error boundary that unmounts
    // the tree would otherwise leave `organization_id` behind on every event
    // that followed.
    return () => setSentryOrganization(null);
  }, [organizationId]);
}
