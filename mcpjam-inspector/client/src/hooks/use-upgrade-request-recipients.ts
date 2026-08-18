import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import {
  resolveOrganizationRole,
  useOrganizationMembers,
} from "@/hooks/useOrganizations";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
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
  // Convex auth flips to authenticated before `users:ensureUser` has created
  // the row every org query resolves the caller against, so `isAuthenticated`
  // alone would fire `getOrganizationMembers` during bootstrap, where it
  // throws instead of returning empty. Same gate every other org-scoped hook
  // uses (useOrgSlackSettings, useProjectEnvironments, useGithubChecksSettings).
  const isUserReady = useDbUserReady();
  const { activeMembers, isLoading: isMembersLoading } = useOrganizationMembers(
    {
      isAuthenticated: isAuthenticated && isUserReady,
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

  // While Convex auth resolves, isAuthenticated is temporarily false, and
  // while the db user bootstraps the query is gated off — in both windows the
  // members query is skipped. Keep the result pending so callers do not treat
  // that temporary empty list as a settled "no owner" result.
  //
  // Bounded rather than a permanent "loading": the bootstrap term is guarded
  // on `isAuthenticated`, so signed-out callers settle immediately, and an
  // authenticated session whose ensureUser never lands is already replaced by
  // App's `UserSetupError` screen.
  return {
    recipients,
    isLoading:
      isAuthLoading || (isAuthenticated && !isUserReady) || isMembersLoading,
  };
}
