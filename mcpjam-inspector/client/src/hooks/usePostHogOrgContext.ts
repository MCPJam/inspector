import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import { setAnalyticsOrganizationGroup } from "@/lib/analytics";

export function usePostHogOrgContext(
  organizationId: string | null | undefined,
  isMember: boolean,
) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    if (organizationId) {
      posthog.register({ organization_id: organizationId });
    } else {
      posthog.unregister("organization_id");
    }
  }, [posthog, organizationId]);

  // Derived from this render's inputs and read by `track()` when an event
  // fires, like a ref assigned in render. Idempotent, so no effect is needed.
  setAnalyticsOrganizationGroup(
    isMember && organizationId ? organizationId : null,
  );
}
