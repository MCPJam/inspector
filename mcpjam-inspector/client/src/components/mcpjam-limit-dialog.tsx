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
import { useEffect, useRef } from "react";
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
import { track } from "@/lib/analytics";

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
  const { sortedOrganizations, isLoading: isLoadingOrganizations } =
    useOrganizationQueries({ isAuthenticated });
  const appNavigate = useAppNavigate();
  const guestImpressionTrackedRef = useRef(false);
  const creditsImpressionTrackedRef = useRef(false);

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

  const billingOrgId = resolveBillingOrgId();
  const creditsUpgrade = useUpgradeCheckout({
    organizationId: billingOrgId,
    origin: "credits",
    limitKind: "credits",
  });
  const requestRecipients = useUpgradeRequestRecipients(billingOrgId);

  // Only owners/admins/creators can buy credits (mirrors the backend gate).
  // Members instead see an "ask org admin" hint so they don't dead-end on a
  // button the checkout action would reject. While the org membership is
  // still resolving (no match yet) we stay optimistic and show the buy
  // button — `handleTopUp` already no-ops until an org id is available, so an
  // actual admin never sees a premature "ask admin" flash.
  const billingOrg = billingOrgId
    ? sortedOrganizations.find((org) => org._id === billingOrgId) ?? null
    : null;
  const isKnownNonManager = billingOrg
    ? !canManageOrgCredits(billingOrg)
    : false;

  // Guest variant — only renders for unauthenticated users.
  const showGuestDialog = !user && intent === "guest" && isOpen;
  // Top-up variant — only renders for signed-in users.
  const showTopupDialog = !!user && intent === "topup" && isOpen;
  // Pitching Team to an org already on Team would be nonsense; those orgs get
  // the buy-credits path only.
  const isFreeEffectivePlan = creditsUpgrade.effectivePlan === "free";
  const showCreditsUpgrade =
    isFreeEffectivePlan && creditsUpgrade.canManageBilling;
  const creditsRequestAction = isFreeEffectivePlan ? "upgrade" : "buyCredits";
  const memberDescription = isFreeEffectivePlan
    ? "Ask an organization owner or admin to buy credits or upgrade the plan."
    : "Ask an organization owner or admin to buy credits.";

  useEffect(() => {
    if (!showGuestDialog) {
      guestImpressionTrackedRef.current = false;
      return;
    }
    if (isLoading || guestImpressionTrackedRef.current) return;

    guestImpressionTrackedRef.current = true;
    track("plan_limit_dialog_shown", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      primary_action: "sign_in",
      is_identified: false,
    });
  }, [isLoading, showGuestDialog]);

  useEffect(() => {
    if (!showTopupDialog) {
      creditsImpressionTrackedRef.current = false;
      return;
    }
    if (
      isLoadingOrganizations ||
      creditsUpgrade.isLoadingBilling ||
      creditsImpressionTrackedRef.current
    ) {
      return;
    }

    creditsImpressionTrackedRef.current = true;
    track("plan_limit_dialog_shown", {
      location: "plan_limit_dialog",
      wall_kind: "organization_credits",
      organization_id: billingOrgId,
      organization_resolved: Boolean(billingOrgId),
      limit_kind: "credits",
      origin: "credits",
      audience: isKnownNonManager ? "member" : "billing_manager",
      primary_action: isKnownNonManager
        ? requestRecipients.length > 0
          ? "request_owner"
          : "none"
        : showCreditsUpgrade
        ? "upgrade"
        : "buy_credits",
      current_plan: creditsUpgrade.currentPlan,
      effective_plan: creditsUpgrade.effectivePlan,
      can_manage_billing: creditsUpgrade.canManageBilling,
      can_buy_credits: !isKnownNonManager,
      request_action: creditsRequestAction,
      request_recipient_count: requestRecipients.length,
      billing_interval: creditsUpgrade.interval,
      annual_supported: creditsUpgrade.annualSupported,
      monthly_supported: creditsUpgrade.monthlySupported,
    });
  }, [
    billingOrgId,
    creditsRequestAction,
    creditsUpgrade.annualSupported,
    creditsUpgrade.canManageBilling,
    creditsUpgrade.currentPlan,
    creditsUpgrade.effectivePlan,
    creditsUpgrade.interval,
    creditsUpgrade.isLoadingBilling,
    creditsUpgrade.monthlySupported,
    isKnownNonManager,
    isLoadingOrganizations,
    requestRecipients.length,
    showCreditsUpgrade,
    showTopupDialog,
  ]);

  if (isLoading) return null;

  const handleTopUp = () => {
    const orgId = resolveBillingOrgId();
    // Don't dismiss the modal until we know we can route the user — on a
    // fresh sign-in the membership query may still be in flight, in which
    // case closing now would drop them out of the upsell silently.
    if (!orgId) {
      track("plan_limit_buy_credits_clicked", {
        location: "plan_limit_dialog",
        wall_kind: "organization_credits",
        organization_id: null,
        origin: "credits",
        outcome: "blocked_missing_organization",
        current_plan: creditsUpgrade.currentPlan,
        effective_plan: creditsUpgrade.effectivePlan,
      });
      return;
    }
    close();
    // The router strips ?... before resolving the route, so the
    // `topup=open` flag is invisible to navigation but visible to the
    // billing page on mount.
    appNavigate(`/organizations/${orgId}/billing?topup=open`);
    track("plan_limit_buy_credits_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "organization_credits",
      organization_id: orgId,
      origin: "credits",
      outcome: "billing_opened",
      current_plan: creditsUpgrade.currentPlan,
      effective_plan: creditsUpgrade.effectivePlan,
    });
  };

  const handleBYOK = () => {
    // Don't yank the user to the org settings page — just close the dialog
    // and pop open the chat model picker on its "Your providers" tab so they
    // can switch to an own-key model in place. The free models stay grayed.
    close();
    useModelPickerIntentStore.getState().requestOpenProvidersTab();
    track("plan_limit_byok_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "organization_credits",
      organization_id: billingOrgId,
      origin: "credits",
      current_plan: creditsUpgrade.currentPlan,
      effective_plan: creditsUpgrade.effectivePlan,
    });
  };

  const handleGuestDismiss = () => {
    close();
    track("plan_limit_dialog_dismissed", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
    });
  };

  const handleCreditsDismiss = () => {
    close();
    track("plan_limit_dialog_dismissed", {
      location: "plan_limit_dialog",
      wall_kind: "organization_credits",
      organization_id: billingOrgId,
      limit_kind: "credits",
      origin: "credits",
      current_plan: creditsUpgrade.currentPlan,
      effective_plan: creditsUpgrade.effectivePlan,
      audience: isKnownNonManager ? "member" : "billing_manager",
    });
  };

  const handleSignIn = () => {
    signIn();
    track("plan_limit_sign_in_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
    });
  };

  return (
    <>
      {showGuestDialog && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) handleGuestDismiss();
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
            <Button onClick={handleSignIn} className="w-full">
              Sign in
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {showTopupDialog && (
        <CreditsLimitDialogView
          description={
            isKnownNonManager
              ? memberDescription
              : isFreeEffectivePlan
              ? `Free credits reset daily. Our ${creditsUpgrade.teamName} plan replaces the daily cap with a monthly allowance per seat, so usage isn't rationed day to day.`
              : "Buy credits to keep your team going, or use your own API key."
          }
          isKnownNonManager={isKnownNonManager}
          showUpgrade={showCreditsUpgrade}
          requestRecipients={requestRecipients}
          requestAction={creditsRequestAction}
          organizationId={billingOrgId}
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
          onDismiss={handleCreditsDismiss}
        />
      )}
    </>
  );
}
