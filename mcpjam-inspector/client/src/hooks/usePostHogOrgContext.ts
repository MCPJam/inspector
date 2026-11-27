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

  // Set during render so a child's mount effect already tracks with it. The
  // effect clears it once App unmounts (AuthRecoveryBoundary can replace App
  // with a sign-in banner) and sets it again, since StrictMode runs that
  // cleanup once on mount.
  const group = isMember && organizationId ? organizationId : null;
  setAnalyticsOrganizationGroup(group);
  useEffect(() => {
    setAnalyticsOrganizationGroup(group);
    return () => setAnalyticsOrganizationGroup(null);
  }, [group]);
}
