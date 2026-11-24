import { useOrganizationBillingStatus } from "@/hooks/useOrganizationBilling";
import {
  SidebarGuestSignUpPrompt,
  useAccountCreatedToast,
} from "./sidebar-guest-signup-prompt";
import { SidebarOwnerRequestPrompt } from "./sidebar-owner-request-prompt";
import { SidebarProUpgradePrompt } from "./sidebar-pro-upgrade-prompt";

/**
 * The always-on footer card: create an account for hosted guests, upgrade to
 * Pro for Free orgs. Paid orgs and active trials (the countdown owns that
 * slot) see nothing.
 */
export function SidebarUpgradePrompt({
  isGuest,
  organizationId,
}: {
  isGuest: boolean;
  organizationId: string | null;
}) {
  useAccountCreatedToast();
  const billing = useOrganizationBillingStatus(
    isGuest ? null : organizationId,
  );
  if (isGuest) return <SidebarGuestSignUpPrompt />;
  if (!organizationId || !billing) return null;
  if (billing.effectivePlan !== "free" || billing.trialStatus === "active") {
    return null;
  }
  return billing.canManageBilling ? (
    <SidebarProUpgradePrompt organizationId={organizationId} />
  ) : (
    <SidebarOwnerRequestPrompt
      organizationId={organizationId}
      organizationName={billing.organizationName}
    />
  );
}
