import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { useEffect } from "react";
import {
  canManageOrgCredits,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";
import { useAppNavigate } from "@/lib/app-navigation";
import { useUpgradeCheckout } from "@/hooks/use-upgrade-checkout";
import { useUpgradeRequestRecipients } from "@/hooks/use-upgrade-request-recipients";
import { CreditsLimitDialogView } from "@/components/billing/CreditsLimitDialogView";

export function MCPJamLimitDialog() {
  const isOpen = useMCPJamLimitDialogStore((s) => s.isOpen);
  const intent = useMCPJamLimitDialogStore((s) => s.intent);
  const limitOrganizationId = useMCPJamLimitDialogStore(
    (s) => s.organizationId
  );
  const close = useMCPJamLimitDialogStore((s) => s.close);
  const setAuthStatus = useMCPJamLimitDialogStore((s) => s.setAuthStatus);
  const { user, isLoading, signIn } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  // Look up the user's orgs as a fallback in case there is no stored
  // active-org for this user (e.g. brand-new sign-in). Sorted most-recent
  // first by useOrganizationQueries.
  const { sortedOrganizations } = useOrganizationQueries({ isAuthenticated });
  const appNavigate = useAppNavigate();

  useEffect(() => {
    setAuthStatus(isLoading ? "loading" : user ? "signedIn" : "guest");
    // Auth flipped to signed-in while the guest variant was open (e.g. user
    // signed in from another tab). Render guards already hide it; close so
    // the store stops reporting an open dialog.
    if (user && intent === "guest" && isOpen) close();
  }, [close, intent, isLoading, isOpen, setAuthStatus, user]);

  // Resolve which org's billing page to redirect to. Prefer the org that
  // actually hit the limit; fall back to local active org / recent org.
  // Declared above the `isLoading` guard so the upgrade hook below keeps a
  // stable call order.
  const resolveBillingOrgId = (): string | null => {
    if (!user) return null;
    if (limitOrganizationId) return limitOrganizationId;
    const stored = readStoredActiveOrganizationId(user.id);
    if (stored) return stored;
    return sortedOrganizations[0]?._id ?? null;
  };

  const creditsUpgrade = useUpgradeCheckout({
    organizationId: resolveBillingOrgId(),
    origin: "credits",
    limitKind: "credits",
  });
  const requestRecipients = useUpgradeRequestRecipients(resolveBillingOrgId());

  if (isLoading) return null;

  // Only owners/admins/creators can buy credits (mirrors the backend gate).
  // Members instead see an "ask org admin" hint so they don't dead-end on a
  // button the checkout action would reject. While the org membership is
  // still resolving (no match yet) we stay optimistic and show the buy
  // button — `handleTopUp` already no-ops until an org id is available, so an
  // actual admin never sees a premature "ask admin" flash.
  const billingOrgId = resolveBillingOrgId();
  const billingOrg = billingOrgId
    ? sortedOrganizations.find((org) => org._id === billingOrgId) ?? null
    : null;
  const isKnownNonManager = billingOrg
    ? !canManageOrgCredits(billingOrg)
    : false;

  const handleTopUp = () => {
    const orgId = resolveBillingOrgId();
    // Don't dismiss the modal until we know we can route the user — on a
    // fresh sign-in the membership query may still be in flight, in which
    // case closing now would drop them out of the upsell silently.
    if (!orgId) return;
    close();
    // The router strips ?... before resolving the route, so the
    // `topup=open` flag is invisible to navigation but visible to the
    // billing page on mount.
    appNavigate(`/organizations/${orgId}/billing?topup=open`);
  };

  const handleBYOK = () => {
    // Don't yank the user to the org settings page — just close the dialog
    // and pop open the chat model picker on its "Your providers" tab so they
    // can switch to an own-key model in place. The free models stay grayed.
    close();
    useModelPickerIntentStore.getState().requestOpenProvidersTab();
  };

  // Guest variant — only renders for unauthenticated users.
  const showGuestDialog = !user && intent === "guest" && isOpen;
  // Top-up variant — only renders for signed-in users.
  const showTopupDialog = !!user && intent === "topup" && isOpen;
  // Pitching Team to an org already on Team would be nonsense; those orgs get
  // the buy-credits path only.
  const showCreditsUpgrade =
    creditsUpgrade.currentPlan === "free" && creditsUpgrade.canManageBilling;

  return (
    <>
      {showGuestDialog && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) close();
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>You've used up your free guest credits.</DialogTitle>
              <DialogDescription>
                Sign in to get{" "}
                <strong className="text-foreground font-medium">10×</strong> the
                free credits.
              </DialogDescription>
            </DialogHeader>
            <Button onClick={() => signIn()} className="w-full">
              Sign in
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {showTopupDialog && (
        <CreditsLimitDialogView
          description={
            isKnownNonManager
              ? "Ask an organization owner or admin to buy credits or upgrade the plan."
              : creditsUpgrade.currentPlan === "free"
                ? `Free credits reset daily. Our ${creditsUpgrade.teamName} plan replaces the daily cap with a monthly allowance per seat, so usage isn't rationed day to day.`
                : "Buy credits to keep your team going, or use your own API key."
          }
          isKnownNonManager={isKnownNonManager}
          showUpgrade={showCreditsUpgrade}
          requestRecipients={requestRecipients}
          organizationName={creditsUpgrade.organizationName}
          interval={creditsUpgrade.interval}
          onIntervalChange={creditsUpgrade.setInterval}
          annualPriceLabel={creditsUpgrade.annualPriceLabel}
          monthlyPriceLabel={creditsUpgrade.monthlyPriceLabel}
          annualDiscountPct={creditsUpgrade.annualDiscountPct}
          annualSupported={creditsUpgrade.annualSupported}
          monthlySupported={creditsUpgrade.monthlySupported}
          teamName={creditsUpgrade.teamName}
          isStarting={creditsUpgrade.isStarting}
          onUpgrade={() => void creditsUpgrade.start()}
          onBuyCredits={handleTopUp}
          onUseOwnKey={handleBYOK}
          onDismiss={close}
        />
      )}
    </>
  );
}
