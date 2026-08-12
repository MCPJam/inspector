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
  const { isAuthenticated } = useConvexAuth();
  const { activeMembers, isLoading } = useOrganizationMembers({
    isAuthenticated,
    organizationId,
  });

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

  return { recipients, isLoading };
}
