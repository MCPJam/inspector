import { FrontierSignInDialogView } from "./billing/FrontierSignInDialogView";
import { useFrontierSignInDialogStore } from "@/stores/frontier-sign-in-dialog-store";
import { GuestCreditWallView } from "@/components/billing/GuestCreditWallView";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import {
  useActiveFeatureFlags,
  useFeatureFlagVariantKey,
  usePostHog,
} from "posthog-js/react";
import { useEffect, useRef, useState } from "react";
import {
  canManageOrgCredits,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useAppNavigate } from "@/lib/app-navigation";
import { useUpgradeCheckout } from "@/hooks/use-upgrade-checkout";
import { useUpgradeRequestRecipients } from "@/hooks/use-upgrade-request-recipients";
import { CreditsLimitDialogView } from "@/components/billing/CreditsLimitDialogView";
import { AllowanceLimitDialogView } from "@/components/billing/AllowanceLimitDialogView";
import { ScenarioOwnerLimitDialogView } from "@/components/billing/ScenarioOwnerLimitDialogView";
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

const normalizeGuestVariant = (
  raw: string | boolean | undefined,
): "control" | "treatment" => (raw === "treatment" ? "treatment" : "control");

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
  const posthog = usePostHog();
  // Reading the variant fires the PostHog exposure ($feature_flag_called).
  const rawVariant = useFeatureFlagVariantKey(GUEST_WALL_FLAG);
  // `useActiveFeatureFlags` is here purely for its `onFeatureFlags`
  // subscription: it re-renders when flags resolve even if our flag is absent
  // (the pre-experiment state), which a render-time `hasLoadedFlags` read needs
  // in order to update. It returns string[] (seeded to [] synchronously) and
  // never undefined, so it can't answer "have flags loaded?" — hasLoadedFlags
  // can, and is public on the client.
  useActiveFeatureFlags();
  const flagsLoaded = posthog?.featureFlags?.hasLoadedFlags ?? false;

  // Commit the variant once per opening. Initialize synchronously when flags are
  // already loaded (the common case — the wall shows after the guest has used
  // the app) to avoid a control→treatment flicker; otherwise hold null until
  // flags resolve so we never bake in control while PostHog's exposure has
  // already enrolled a slow guest in treatment.
  const [committedVariant, setCommittedVariant] = useState<
    "control" | "treatment" | null
  >(() => (flagsLoaded ? normalizeGuestVariant(rawVariant) : null));

  // Flags resolved after mount (slow /flags): commit the real value now. We
  // never commit on a timeout — the control layout already renders as a visual
  // fallback below while unresolved, so a timeout would add no UX, and pinning
  // control after N seconds would misattribute a guest whose flag resolves late
  // to treatment (both the shown copy and the recorded variant). If /flags never
  // resolves (e.g. an ad blocker), the guest keeps the control fallback and no
  // impression fires — and a blocked PostHog can't send events anyway, so there
  // is no impression to lose.
  useEffect(() => {
    if (committedVariant !== null || !flagsLoaded) return;
    setCommittedVariant(normalizeGuestVariant(rawVariant));
  }, [committedVariant, flagsLoaded, rawVariant]);

  // One impression per opening, and only once a variant is committed — reporting
  // the control fallback below early would misattribute a treatment guest.
  const impressionTrackedRef = useRef(false);
  useEffect(() => {
    if (committedVariant === null || impressionTrackedRef.current) return;
    impressionTrackedRef.current = true;
    const isTreatment = committedVariant === "treatment";
    track("plan_limit_dialog_shown", {
      location: "plan_limit_dialog",
      wall_kind: "guest_credits",
      limit_kind: "credits",
      origin: "credits",
      audience: "guest",
      variant: committedVariant,
      primary_action: isTreatment ? "create_account" : "sign_in",
      secondary_action: isTreatment ? "see_plans" : null,
      is_identified: false,
    });
  }, [committedVariant]);

  // Show control until a variant is committed so the guest never sees an empty
  // dialog; the impression above holds until then.
  const isTreatment = committedVariant === "treatment";
  const trackedVariant = committedVariant ?? "control";

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
    <GuestCreditWallView
      isTreatment={isTreatment}
      onDismiss={handleDismiss}
      onCreateAccount={handleCreateAccount}
      onSeePlans={handleSeePlans}
      onSignIn={handleSignIn}
    />
  );
}

export function MCPJamLimitDialog() {
  const frontierOpen = useFrontierSignInDialogStore((s) => s.isOpen);
  const closeFrontier = useFrontierSignInDialogStore((s) => s.close);
  const isOpen = useMCPJamLimitDialogStore((s) => s.isOpen);
  const intent = useMCPJamLimitDialogStore((s) => s.intent);
  const limitOrganizationId = useMCPJamLimitDialogStore(
    (s) => s.organizationId,
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
  const creditsImpressionTrackedRef = useRef(false);

  // A User Testing link is billed to the scenario owner, so a tester (guest or
  // signed in) has nothing to buy or sign in to. They get a notice instead, and
  // none of the billing hooks below run for an org they may not belong to.
  const isScenarioWall = limitSurface === "scenario";
  const showScenarioWall =
    isOpen && intent !== null && isScenarioWall && !frontierOpen;
  // Decide whether either variant is active before wiring billing hooks. This
  // component is mounted app-wide, so a closed dialog must not keep billing
  // and owner-member Convex subscriptions alive for the whole session.
  const showGuestDialog =
    !user && intent === "guest" && isOpen && !isScenarioWall;
  const showTopupDialog =
    !!user && intent === "topup" && isOpen && !isScenarioWall;
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
  // Every candidate must be an org the user can open: the stored id is raw
  // localStorage and can outlive a membership, and a billing query for an org
  // the user isn't in throws into the app error boundary. `seatPending` orgs
  // are listed but unlinked, so they are excluded the same way App does.
  // Declared above the `isLoading` guard so the upgrade hook below keeps a
  // stable call order.
  const resolveBillingOrgId = (): string | null => {
    if (!user) return null;
    const selectableOrganizations = sortedOrganizations.filter(
      (org) => !org.seatPending,
    );
    const candidates = [
      limitOrganizationId,
      readStoredActiveOrganizationId(user.id),
      selectableOrganizations[0]?._id,
    ];
    return (
      candidates.find(
        (candidate) =>
          !!candidate &&
          selectableOrganizations.some((org) => org._id === candidate),
      ) ?? null
    );
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
  const showCreditWall =
    showTopupDialog && isBillingReady && !frontierOpen && !isLoading;
  const showCreditsUpgrade =
    isFreeEffectivePlan && creditsUpgrade.canManageBilling;
  // Buying credits and upgrading the plan are two different permissions:
  // admins can do the first, only owners the second. An admin who can't
  // upgrade must not be pitched the upgrade with no way to act on it — they
  // get a way to ask an owner plus BYOK information.
  const showCreditsUpgradeRequest =
    !isKnownNonManager &&
    isFreeEffectivePlan &&
    !creditsUpgrade.canManageBilling;
  const creditsRequestAction =
    isKnownNonManager && !isFreeEffectivePlan ? "buyCredits" : "upgrade";
  // Names owners only, because the one action this wall offers is an email to
  // the resolved owners. Admins can buy credits but cannot upgrade, so naming
  // them here promised a recipient the button never writes to — and, on Free,
  // implied admins could upgrade at all.
  const memberDescription = isFreeEffectivePlan
    ? "Ask an organization owner to upgrade the plan."
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
      !showCreditWall ||
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
      primary_action:
        isKnownNonManager || showCreditsUpgradeRequest
          ? requestRecipients.length > 0
            ? "request_owner"
            : "none"
          : isFreeEffectivePlan
          ? "explore_plans"
          : "buy_credits",
      current_plan: creditsUpgrade.currentPlan,
      effective_plan: creditsUpgrade.effectivePlan,
      can_manage_billing: creditsUpgrade.canManageBilling,
      can_buy_credits: !isKnownNonManager && !isFreeEffectivePlan,
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
    showCreditWall,
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
    const orgId = resolveBillingOrgId();
    if (!orgId) return;
    close();
    appNavigate(`/organizations/${orgId}/billing/byok`);
    track("plan_limit_byok_clicked", {
      location: "plan_limit_dialog",
      organization_id: orgId,
      outcome: "byok_explainer_opened",
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
    // Open the organization’s plans settings.
    appNavigate(`/organizations/${orgId}/plans`);
    track("plan_limit_explore_plans_clicked", {
      location: "plan_limit_dialog",
      wall_kind: "organization_credits",
      organization_id: orgId,
      origin: "credits",
      outcome: "billing_opened",
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
      {frontierOpen && (
        <FrontierSignInDialogView
          onDismiss={closeFrontier}
          onSignIn={() => {
            captureAppSignInReturnPath();
            closeFrontier();
            signIn(permalinkSignInOptions());
          }}
        />
      )}
      {showScenarioWall && <ScenarioOwnerLimitDialogView onDismiss={close} />}
      {showGuestDialog && !frontierOpen && <GuestCreditWall />}
      {showCreditWall && isSwarmWall && (
        <AllowanceLimitDialogView
          isFreePlan={isFreeEffectivePlan}
          title={allowanceCopy.title}
          // A member gets the owner guidance ON TOP of the explanation, not
          // instead of it: "my own key is configured, why am I blocked" is the
          // question that filed this bug, and it is not a question only
          // billing managers ask.
          description={
            isKnownNonManager || showCreditsUpgradeRequest
              ? `${allowanceCopy.description} ${memberDescription}`
              : allowanceCopy.description
          }
          isKnownNonManager={isKnownNonManager}
          showRequestUpgrade={showCreditsUpgradeRequest}
          requestRecipients={isBillingReady ? requestRecipients : []}
          organizationId={billingOrgId}
          organizationName={creditsUpgrade.organizationName}
          teamName={creditsUpgrade.teamName}
          onBuyCredits={handleTopUp}
          onLearnMore={handleBYOK}
          onExplorePlans={handleExplorePlans}
          onDismiss={handleCreditsDismiss}
        />
      )}
      {showCreditWall && !isSwarmWall && (
        <CreditsLimitDialogView
          isFreePlan={isFreeEffectivePlan}
          description={
            isFreeEffectivePlan &&
            !isKnownNonManager &&
            !showCreditsUpgradeRequest
              ? "Your Free credits reset daily. Explore Pro or Team for more credits and credit top-ups."
              : isKnownNonManager || showCreditsUpgradeRequest
              ? memberDescription
              : showCreditsUpgrade
              ? `Free credits reset daily. The ${
                  creditsUpgrade.teamName
                } plan replaces the daily cap with a monthly allowance${
                  creditsUpgrade.isFlatPlan ? "" : " per seat"
                }, so usage isn't rationed day to day.`
              : "Buy credits to keep your team going."
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
          priceUnit={creditsUpgrade.priceUnit}
          teamName={creditsUpgrade.teamName}
          isStarting={creditsUpgrade.isStarting}
          isLoadingPrices={creditsUpgrade.isLoadingPrices}
          onUpgrade={() => void handleUpgrade()}
          onBuyCredits={handleTopUp}
          onUseOwnKey={handleBYOK}
          onExplorePlans={handleExplorePlans}
          onDismiss={handleCreditsDismiss}
        />
      )}
    </>
  );
}
