import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";

export function usePostHogOrgContext(organizationId: string | null | undefined) {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    if (organizationId) {
      posthog.register({ organization_id: organizationId });
    } else {
      posthog.unregister("organization_id");
    }
  }, [posthog, organizationId]);
}
