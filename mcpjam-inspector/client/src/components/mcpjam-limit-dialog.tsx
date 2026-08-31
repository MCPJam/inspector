import { Button } from "@mcpjam/design-system/button";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
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
import { AllowanceLimitDialogView } from "@/components/billing/AllowanceLimitDialogView";
import { track } from "@/lib/analytics";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";

/**
 * The swarm wall's words, by which allowance ran out. The period itself is
 * resolved through the SDK error catalog, so this and the error card can never
 * disagree about what the backend refused — but the wording lives here, where
 * it can be edited without an SDK change.
 *
 * Every variant leads with the BYOK sentence: "I have my own key, why am I
 * blocked" is the question that filed this bug, and the modal is now the only
 * thing on screen to answer it.
 */
const ALLOWANCE_COPY = {
  daily: {
    title: "Daily MCPJam limit reached",
    description:
      "Swarm generation is always billed to MCPJam, so your own API key doesn't cover it. This organization's daily allowance resets tomorrow.",
  },
  monthly: {
    title: "Monthly MCPJam credits spent",
    description:
      "Swarm generation is always billed to MCPJam, so your own API key doesn't cover it. This organization's monthly credits renew with the billing period.",
  },
  unknown: {
    title: "MCPJam model limit reached",
    description:
      "Swarm generation is always billed to MCPJam, so your own API key doesn't cover it. This organization's MCPJam allowance is spent.",
  },
} as const;

export function MCPJamLimitDialog() {
  const isOpen = useMCPJamLimitDialogStore((s) => s.isOpen);
  const intent = useMCPJamLimitDialogStore((s) => s.intent);
  const limitOrganizationId = useMCPJamLimitDialogStore(
    (s) => s.organizationId
  );
  const limitSurface = useMCPJamLimitDialogStore((s) => s.surface);
  const limitPeriod = useMCPJamLimitDialogStore((s) => s.period);
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

  // Decide whether either variant is active before wiring billing hooks. This
  // component is mounted app-wide, so a closed dialog must not keep billing
  // and owner-member Convex subscriptions alive for the whole session.
  const showGuestDialog = !user && intent === "guest" && isOpen;
  const showTopupDialog = !!user && intent === "topup" && isOpen;
  // A swarm gets its own variant of the wall, not just different words: both
  // the upgrade picker and the BYOK link dead-end there, so neither renders.
  const isSwarmWall = limitSurface === "swarm";
  const allowanceCopy = ALLOWANCE_COPY[limitPeriod ?? "unknown"];

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
  const openBillingOrgId = showTopupDialog ? billingOrgId : null;
  const creditsUpgrade = useUpgradeCheckout({
    organizationId: openBillingOrgId,
    origin: "credits",
    limitKind: "credits",
  });
  const {
    recipients: requestRecipients,
    isLoading: isLoadingRequestRecipients,
  } = useUpgradeRequestRecipients(openBillingOrgId);

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

  // Pitching Team to an org already on Team would be nonsense; those orgs get
  // the buy-credits path only. Until billing resolves we don't know which this
  // is, and the hook defaults to Free — so hold the plan-specific copy rather
  // than flash a Free pitch at a Team org.
  const isBillingReady = !creditsUpgrade.isLoadingBilling;
  const isFreeEffectivePlan =
    isBillingReady && creditsUpgrade.effectivePlan === "free";
  const showCreditsUpgrade =
    isFreeEffectivePlan && creditsUpgrade.canManageBilling;
  // Buying credits and upgrading the plan are two different permissions:
  // admins can do the first, only owners the second. An admin who can't
  // upgrade must not be pitched the upgrade with no way to act on it — they
  // get the buy-credits copy plus a way to ask an owner.
  const showCreditsUpgradeRequest =
    !isKnownNonManager && isFreeEffectivePlan && !creditsUpgrade.canManageBilling;
  const creditsRequestAction =
    isKnownNonManager && !isFreeEffectivePlan ? "buyCredits" : "upgrade";
  // Names owners only, because the one action this wall offers is an email to
  // the resolved owners. Admins can buy credits but cannot upgrade, so naming
  // them here promised a recipient the button never writes to — and, on Free,
  // implied admins could upgrade at all.
  const memberDescription = isFreeEffectivePlan
    ? "Ask an organization owner to buy credits or upgrade the plan."
    : "Ask an organization owner to buy credits.";
  // Audience follows the billing permission, the same rule the eval wall uses.
  // `can_buy_credits` is what separates an admin from a plain member.
  const creditsAudience = creditsUpgrade.canManageBilling
    ? "billing_manager"
    : "member";

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
      // Both request paths render a recipient button, so both have to wait for
      // the owner list. Reporting early on the admin path recorded
      // `request_recipient_count: 0` for a button that then appeared.
      ((isKnownNonManager || showCreditsUpgradeRequest) &&
        isLoadingRequestRecipients) ||
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
      audience: creditsAudience,
      surface: limitSurface,
      // The swarm variant renders no upgrade picker, so reporting "upgrade"
      // there would name an action that isn't on screen.
      primary_action: isKnownNonManager
        ? requestRecipients.length > 0
          ? "request_owner"
          : "none"
        : showCreditsUpgrade && !isSwarmWall
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
    creditsAudience,
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
    isLoadingRequestRecipients,
    isSwarmWall,
    limitSurface,
    requestRecipients.length,
    showCreditsUpgrade,
    showCreditsUpgradeRequest,
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

  const handleExplorePlans = () => {
    const orgId = resolveBillingOrgId();
    // Same guard as `handleTopUp`: without an org there is no billing page to
    // land on, so keep the dialog up rather than dropping them on nothing.
    if (!orgId) {
      track("plan_limit_explore_plans_clicked", {
        location: "plan_limit_dialog",
        wall_kind: "organization_credits",
        organization_id: null,
        origin: "credits",
        outcome: "blocked_missing_organization",
      });
      return;
    }
    close();
    // Plans render below credits and payment history, so the flag tells the
    // billing page to scroll to them instead of landing at the top.
    appNavigate(`/organizations/${orgId}/billing?plans=open`);
    track("plan_limit_explore_plans_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "organization_credits",
      organization_id: orgId,
      origin: "credits",
      outcome: "billing_opened",
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
      audience: creditsAudience,
    });
  };

  const handleSignIn = () => {
    // Remember where they were, so WorkOS returns them here rather than to
    // the app's front door.
    captureAppSignInReturnPath();
    signIn(permalinkSignInOptions());
    track("plan_limit_sign_in_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
    });
  };

  const handleUpgrade = async () => {
    const result = await creditsUpgrade.start();
    if (result?.shouldDismiss) close();
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
      {showTopupDialog && isSwarmWall && (
        <AllowanceLimitDialogView
          title={allowanceCopy.title}
          description={
            isKnownNonManager ? memberDescription : allowanceCopy.description
          }
          isKnownNonManager={isKnownNonManager}
          requestRecipients={isBillingReady ? requestRecipients : []}
          organizationId={billingOrgId}
          organizationName={creditsUpgrade.organizationName}
          teamName={creditsUpgrade.teamName}
          onBuyCredits={handleTopUp}
          onExplorePlans={handleExplorePlans}
          onDismiss={handleCreditsDismiss}
        />
      )}
      {showTopupDialog && !isSwarmWall && (
        <CreditsLimitDialogView
          description={
            isKnownNonManager
              ? memberDescription
              : showCreditsUpgrade
              ? `Free credits reset daily. The ${creditsUpgrade.teamName} plan replaces the daily cap with a monthly allowance per seat, so usage isn't rationed day to day.`
              : "Buy credits to keep your team going, or use your own API key."
          }
          isKnownNonManager={isKnownNonManager}
          showUpgrade={showCreditsUpgrade}
          showRequestUpgrade={showCreditsUpgradeRequest}
          // Empty until billing resolves: the draft's wording depends on the
          // plan, and RequestUpgradeButton already renders nothing without a
          // recipient.
          requestRecipients={isBillingReady ? requestRecipients : []}
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
          isLoadingPrices={creditsUpgrade.isLoadingPrices}
          onUpgrade={() => void handleUpgrade()}
          onBuyCredits={handleTopUp}
          onUseOwnKey={handleBYOK}
          onDismiss={handleCreditsDismiss}
        />
      )}
    </>
  );
}
