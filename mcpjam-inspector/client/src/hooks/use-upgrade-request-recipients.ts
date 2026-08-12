import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import {
  resolveOrganizationRole,
  useOrganizationMembers,
} from "@/hooks/useOrganizations";
import type { UpgradeRequestRecipient } from "@/components/billing/RequestUpgradeButton";

/**
 * The org owners a blocked member should be pointed at. Owners only: admins
 * can't start checkout either (`canManageBilling` is owner-only in Convex), so
 * addressing them would route the ask to someone who also can't act on it.
 *
 * Pending invites are excluded — `activeMembers` already filters to members
 * with a resolved `userId`.
 */
export function useUpgradeRequestRecipients(organizationId: string | null): {
  recipients: UpgradeRequestRecipient[];
  isLoading: boolean;
} {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { activeMembers, isLoading: isMembersLoading } = useOrganizationMembers(
    {
      isAuthenticated,
      organizationId,
    }
  );

  const recipients = useMemo(
    () =>
      activeMembers
        .filter((member) => resolveOrganizationRole(member) === "owner")
        .map((member) => ({
          email: member.email,
          name: member.user?.name ?? null,
        }))
        .filter((recipient) => Boolean(recipient.email)),
    [activeMembers]
  );

  // While Convex auth resolves, isAuthenticated is temporarily false and the
  // members query is skipped. Keep the result pending so callers do not treat
  // that temporary empty list as a settled "no owner" result.
  return { recipients, isLoading: isAuthLoading || isMembersLoading };
}
