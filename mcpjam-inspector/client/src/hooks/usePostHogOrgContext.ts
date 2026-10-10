import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";

/**
 * Keep the `organization_id` and `organization_name` super properties pointed
 * at the active org. The caller passes a name only when no organization of the
 * person has enterprise privacy; `sanitizeAnalyticsProperties` also drops it
 * from any event sent while analytics are masked.
 */
export function usePostHogOrgContext(
  organizationId: string | null | undefined,
  organizationName?: string | null,
) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    if (organizationId) {
      posthog.register({ organization_id: organizationId });
    } else {
      posthog.unregister("organization_id");
    }
    if (organizationId && organizationName) {
      posthog.register({ organization_name: organizationName });
    } else {
      posthog.unregister("organization_name");
    }
  }, [posthog, organizationId, organizationName]);
}
