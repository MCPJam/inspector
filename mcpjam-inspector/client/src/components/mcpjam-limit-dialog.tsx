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
import { useActiveFeatureFlags, useFeatureFlagVariantKey } from "posthog-js/react";
import { useEffect, useRef, useState } from "react";
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
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";

// BB-133 guest credit-wall A/B. PostHog multivariate flag: the "treatment"
// variant renders the benefit-led modal (create-account primary + see-plans
// secondary); anything else (undefined/off/"control") renders the original
// single "Sign in" wall. The flag defaulting to control means the wall is safe
// before the experiment exists in PostHog.
const GUEST_WALL_FLAG = "guest-credit-wall-copy";

// Guests aren't signed in and have no org, so there's no in-app billing route
// to send them to. The public pricing page is the same marketing surface the
// Enterprise CTA already links to (www.mcpjam.com/contact).
const GUEST_PRICING_URL = "https://www.mcpjam.com/pricing";

// Design owns the hero art (Figma node 136-92). It's dropped into client/public
// by design; the modal degrades to no image if the asset isn't present yet, so
// shipping the flag ahead of the export can't render a broken image.
const GUEST_WALL_ILLUSTRATION = "/guest-credit-wall.png";

// The hero art's intrinsic size, used to reserve its box before the PNG decodes.
const GUEST_WALL_ILLUSTRATION_SIZE = 582;

/**
 * The guest out-of-credits wall. Rendered ONLY while the wall is actually shown
 * (see the caller's `showGuestDialog` guard), so the flag read here — and the
 * PostHog `$feature_flag_called` exposure it emits — happens for guests who hit
 * the wall, not for every app session. Mounting it app-wide would enroll all
 * ~10k daily sessions against the ~200 who can convert, diluting both arms and
 * keeping the experiment from ever reaching significance.
 */
function GuestCreditWall() {
  const { signIn, signUp } = useAuth();
  const close = useMCPJamLimitDialogStore((s) => s.close);
  // Reading the variant fires the PostHog exposure ($feature_flag_called).
  const rawVariant = useFeatureFlagVariantKey(GUEST_WALL_FLAG);
  // Subscribe to flag *resolution* separately: when our flag is absent (the
  // pre-experiment state), `useFeatureFlagVariantKey` stays undefined and never
  // re-renders on load, so a render-time `hasLoadedFlags` read would never
  // update and pin the wall to the control fallback. `useActiveFeatureFlags`
  // returns undefined until flags load, then an array, and re-renders on that.
  const activeFlags = useActiveFeatureFlags();
  const flagsLoaded = activeFlags !== undefined;

  // Distinguish "flags still loading" from "flag resolved to control": both read
  // as undefined from the variant hook, but treating a still-loading flag as
  // control would bucket a slow-network guest to control while PostHog's
  // exposure already enrolled them in treatment. Wait for load before committing.
  const resolvedVariant: "control" | "treatment" | null = !flagsLoaded
    ? null
    : rawVariant === "treatment"
    ? "treatment"
    : "control";

  // Freeze the variant for this opening so a mid-open flag change can't swap the
  // copy under the user or desync the recorded variant from what was shown. The
  // component unmounts on close, so the next opening resolves fresh.
  const [variant, setVariant] = useState<"control" | "treatment" | null>(null);
  useEffect(() => {
    if (resolvedVariant !== null) setVariant((prev) => prev ?? resolvedVariant);
  }, [resolvedVariant]);

  // One impression per opening, and only once the variant is real — reporting
  // the control fallback below would misattribute a treatment guest.
  const impressionTrackedRef = useRef(false);
  useEffect(() => {
    if (variant === null || impressionTrackedRef.current) return;
    impressionTrackedRef.current = true;
    const isTreatment = variant === "treatment";
    track("plan_limit_dialog_shown", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      variant,
      primary_action: isTreatment ? "create_account" : "sign_in",
      secondary_action: isTreatment ? "see_plans" : null,
      is_identified: false,
    });
  }, [variant]);

  // Show control until the flag resolves so the guest never sees an empty
  // dialog; the impression above holds until the real value arrives.
  const isTreatment = variant === "treatment";
  const trackedVariant = variant ?? "control";

  const handleDismiss = () => {
    close();
    track("plan_limit_dialog_dismissed", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      variant: trackedVariant,
    });
  };

  const handleSignIn = () => {
    // Remember where they were, so WorkOS returns them here rather than the
    // app's front door.
    captureAppSignInReturnPath();
    signIn(permalinkSignInOptions());
    track("plan_limit_sign_in_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      variant: trackedVariant,
    });
  };

  // Treatment primary CTA: start the WorkOS create-account flow rather than
  // plain sign-in, matching the Figma "Create free account" button. Capture the
  // return path so a new account lands back on the wall's surface, not the root.
  const handleCreateAccount = () => {
    captureAppSignInReturnPath();
    signUp(permalinkSignInOptions());
    track("plan_limit_create_account_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      variant: trackedVariant,
    });
  };

  // Treatment secondary CTA: open the public pricing page in a new tab so the
  // guest keeps their place in the app (mirrors the Enterprise CTA behavior).
  const handleSeePlans = () => {
    window.open(GUEST_PRICING_URL, "_blank", "noopener,noreferrer");
    track("plan_limit_see_plans_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      variant: trackedVariant,
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) handleDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {isTreatment ? (
          <>
            <img
              src={GUEST_WALL_ILLUSTRATION}
              alt=""
              aria-hidden
              width={GUEST_WALL_ILLUSTRATION_SIZE}
              height={GUEST_WALL_ILLUSTRATION_SIZE}
              // Explicit intrinsic size reserves the box before the PNG decodes,
              // so the CTAs don't jump up under a reaching cursor when it paints.
              className="w-full h-auto rounded-lg"
              // Degrade to no image if the asset hasn't been dropped in yet, so
              // the flag can ship ahead of the design export.
              onError={(event) => {
                event.currentTarget.style.display = "none";
              }}
            />
            <DialogHeader>
              <DialogTitle>There's so much more to jam on.</DialogTitle>
              <DialogDescription>
                You're out of guest credits. Create a free account to keep
                inspecting your traces, evaluating tool calls, and comparing
                clients.
              </DialogDescription>
            </DialogHeader>
            {/* Primary is first in the DOM so Radix's focus scope lands on it —
                Enter converts instead of opening pricing — and flex-row-reverse
                restores the Figma order with the primary on the right. On a
                narrow modal the buttons stack instead of cramping. */}
            <div className="flex flex-col-reverse gap-2 sm:flex-row-reverse">
              <Button onClick={handleCreateAccount} className="flex-1">
                Create free account
              </Button>
              <Button
                variant="outline"
                onClick={handleSeePlans}
                className="flex-1"
              >
                See paid plans
              </Button>
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function MCPJamLimitDialog() {
  const isOpen = useMCPJamLimitDialogStore((s) => s.isOpen);
  const intent = useMCPJamLimitDialogStore((s) => s.intent);
  const limitOrganizationId = useMCPJamLimitDialogStore(
    (s) => s.organizationId
  );
  const close = useMCPJamLimitDialogStore((s) => s.close);
  const setAuthStatus = useMCPJamLimitDialogStore((s) => s.setAuthStatus);
  const { user, isLoading } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  // Look up the user's orgs as a fallback in case there is no stored
  // active-org for this user (e.g. brand-new sign-in). Sorted most-recent
  // first by useOrganizationQueries.
  const { sortedOrganizations, isLoading: isLoadingOrganizations } =
    useOrganizationQueries({ isAuthenticated });
  const appNavigate = useAppNavigate();
  const creditsImpressionTrackedRef = useRef(false);

  // Decide whether either variant is active before wiring billing hooks. This
  // component is mounted app-wide, so a closed dialog must not keep billing
  // and owner-member Convex subscriptions alive for the whole session.
  const showGuestDialog = !user && intent === "guest" && isOpen;
  const showTopupDialog = !!user && intent === "topup" && isOpen;

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

  const handleUpgrade = async () => {
    const result = await creditsUpgrade.start();
    if (result?.shouldDismiss) close();
  };

  return (
    <>
      {showGuestDialog && <GuestCreditWall />}
      {showTopupDialog && (
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
