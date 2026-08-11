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
export function useUpgradeRequestRecipients(
  organizationId: string | null,
): UpgradeRequestRecipient[] {
  const { isAuthenticated } = useConvexAuth();
  const { activeMembers } = useOrganizationMembers({
    isAuthenticated,
    organizationId,
  });

  // `activeMembers` is [] while the query is in flight, which collapses into
  // the same render as "this org has no reachable owner": nothing. Both are
  // states where there is no address to write to, so neither earns a button.
  return useMemo(
    () =>
      activeMembers
        .filter((member) => resolveOrganizationRole(member) === "owner")
        .map((member) => ({
          email: member.email,
          name: member.user?.name ?? null,
        }))
        .filter((recipient) => Boolean(recipient.email)),
    [activeMembers],
  );
}
