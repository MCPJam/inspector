import { useCallback, useEffect, useState } from "react";
import {
  useOrganizationBilling,
  type BillingInterval,
} from "@/hooks/useOrganizationBilling";
import { getAnnualDiscountPercent } from "@/lib/billing-entitlements";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";

/** Which wall the user was standing at. Drives the return confirmation copy. */
export type UpgradeOrigin = "evals" | "credits";

/**
 * Marks a hosted-checkout return so the confirmation lands on the surface the
 * user was blocked on rather than the billing page. `upgrade_org` and
 * `upgrade_from` ride along because the dialog stores are empty after the
 * full page reload.
 */
export const UPGRADE_RETURN_PARAM = "upgrade";
export const UPGRADE_RETURN_ORG_PARAM = "upgrade_org";
export const UPGRADE_RETURN_ORIGIN_PARAM = "upgrade_from";

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/**
 * `prices.annual` is the full-year amount, so the per-seat monthly figure is a
 * twelfth of it. Same number as `formatPlanPriceLabel` on the billing page.
 *
 * Returns the bare amount. The unit is rendered separately and smaller by
 * `UpgradeIntervalPicker`: inside the large price span, "$30 per seat/month"
 * wraps mid-phrase in a card this narrow, which reads worse than the "/seat/mo"
 * it replaced.
 */
export function formatSeatMonthlyPrice(
  amountInCents: number | null,
  currency: string | undefined,
  interval: BillingInterval
): string | null {
  if (amountInCents == null || !currency) return null;
  if (interval === "monthly") {
    return formatMoney(amountInCents, currency);
  }
  return formatMoney(Math.round(amountInCents / 12 / 100) * 100, currency);
}

interface UseUpgradeCheckoutParams {
  organizationId: string | null;
  origin: UpgradeOrigin;
  /** Forwarded to telemetry so we can compare which wall converts. */
  limitKind: string;
}

export function resolveUpgradeInterval(
  selected: BillingInterval,
  annualSupported: boolean,
  monthlySupported: boolean
): BillingInterval | null {
  if (selected === "annual" && annualSupported) return "annual";
  if (selected === "monthly" && monthlySupported) return "monthly";
  if (annualSupported) return "annual";
  if (monthlySupported) return "monthly";
  return null;
}

/**
 * Shared upgrade path for the free-plan limit walls. Starts hosted checkout
 * directly instead of routing through the billing page, and returns the user
 * to the surface they were blocked on.
 */
export function useUpgradeCheckout({
  organizationId,
  origin,
  limitKind,
}: UseUpgradeCheckoutParams) {
  const {
    billingStatus,
    planCatalog,
    startPlanChange,
    isStartingPlanChange,
    isLoadingBilling,
  } = useOrganizationBilling(organizationId);

  const teamEntry = planCatalog?.plans.team;
  const supportedIntervals = teamEntry?.checkout?.supportedIntervals ?? [
    "monthly",
    "annual",
  ];
  const annualSupported = supportedIntervals.includes("annual");
  const monthlySupported = supportedIntervals.includes("monthly");

  // Annual leads: it's the cheaper per-seat figure and matches the pricing
  // page. Both prices render at once, so nothing is hidden behind the choice.
  const [interval, setInterval] = useState<BillingInterval>(
    annualSupported ? "annual" : "monthly"
  );

  useEffect(() => {
    const availableInterval = resolveUpgradeInterval(
      interval,
      annualSupported,
      monthlySupported
    );
    if (availableInterval && availableInterval !== interval) {
      setInterval(availableInterval);
    }
  }, [annualSupported, interval, monthlySupported]);

  const annualPriceLabel = formatSeatMonthlyPrice(
    teamEntry?.prices.annual ?? null,
    planCatalog?.currency,
    "annual"
  );
  const monthlyPriceLabel = formatSeatMonthlyPrice(
    teamEntry?.prices.monthly ?? null,
    planCatalog?.currency,
    "monthly"
  );

  const currentPlan = billingStatus?.plan ?? "free";
  const effectivePlan = billingStatus?.effectivePlan ?? currentPlan;
  const canManageBilling = billingStatus?.canManageBilling ?? false;

  const selectInterval = useCallback(
    (nextInterval: BillingInterval) => {
      // The product choice happens first; telemetry is best-effort and cannot
      // prevent the selection even if the analytics SDK is unavailable.
      setInterval(nextInterval);
      track("plan_limit_interval_selected", {
        location: "plan_limit_dialog",
        organization_id: organizationId,
        limit_kind: limitKind,
        origin,
        billing_interval: nextInterval,
        price_cents: teamEntry?.prices[nextInterval] ?? null,
        current_plan: currentPlan,
        effective_plan: effectivePlan,
        can_manage_billing: canManageBilling,
        annual_supported: annualSupported,
        monthly_supported: monthlySupported,
      });
    },
    [
      annualSupported,
      canManageBilling,
      currentPlan,
      effectivePlan,
      limitKind,
      monthlySupported,
      organizationId,
      origin,
      teamEntry?.prices,
    ]
  );

  const start = useCallback(async () => {
    if (!organizationId) return;
    const checkoutInterval = resolveUpgradeInterval(
      interval,
      annualSupported,
      monthlySupported
    );
    if (!checkoutInterval) {
      toast.error("Checkout is not available for this plan right now.");
      track("plan_limit_upgrade_failed", {
        location: "plan_limit_dialog",
        organization_id: organizationId,
        limit_kind: limitKind,
        origin,
        error_kind: "no_supported_interval",
        current_plan: currentPlan,
        effective_plan: effectivePlan,
        can_manage_billing: canManageBilling,
        annual_supported: annualSupported,
        monthly_supported: monthlySupported,
      });
      return { redirected: false as const };
    }

    const url = new URL(window.location.href);
    url.searchParams.set(UPGRADE_RETURN_PARAM, "return");
    url.searchParams.set(UPGRADE_RETURN_ORG_PARAM, organizationId);
    url.searchParams.set(UPGRADE_RETURN_ORIGIN_PARAM, origin);

    try {
      // Start the real checkout work before emitting analytics. We never await
      // analytics, and track() is failure-isolated.
      const resultPromise = startPlanChange(
        url.toString(),
        "team",
        checkoutInterval,
        {
          confirmPaidPlanChange: false,
        }
      );
      track("plan_limit_upgrade_clicked", {
        location: "plan_limit_dialog",
        organization_id: organizationId,
        limit_kind: limitKind,
        origin,
        billing_interval: checkoutInterval,
        price_cents: teamEntry?.prices[checkoutInterval] ?? null,
        current_plan: currentPlan,
        effective_plan: effectivePlan,
        can_manage_billing: canManageBilling,
        annual_supported: annualSupported,
        monthly_supported: monthlySupported,
      });
      const result = await resultPromise;
      const nextUrl =
        result.kind === "checkout"
          ? result.checkoutUrl
          : result.kind === "portal"
          ? result.portalUrl
          : null;
      if (nextUrl) {
        // Same tab, so the return URL brings the user back in place.
        window.location.assign(nextUrl);
        return { redirected: true as const };
      }
      return { redirected: false as const };
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't start checkout. Please try again."
      );
      track("plan_limit_upgrade_failed", {
        location: "plan_limit_dialog",
        organization_id: organizationId,
        limit_kind: limitKind,
        origin,
        error_kind: "start_plan_change_failed",
        error_name: error instanceof Error ? error.name : "unknown",
        billing_interval: checkoutInterval,
        current_plan: currentPlan,
        effective_plan: effectivePlan,
        can_manage_billing: canManageBilling,
      });
      return { redirected: false as const };
    }
  }, [
    annualSupported,
    canManageBilling,
    currentPlan,
    effectivePlan,
    interval,
    limitKind,
    monthlySupported,
    organizationId,
    origin,
    startPlanChange,
    teamEntry?.prices,
  ]);

  return {
    interval,
    setInterval: selectInterval,
    annualPriceLabel,
    monthlyPriceLabel,
    annualDiscountPct: getAnnualDiscountPercent(planCatalog),
    annualSupported,
    monthlySupported,
    teamName: teamEntry?.displayName ?? "Team",
    /** Team's monthly eval cap, straight from the catalog so it can't go stale
     * in the copy. Whether the catalog itself matches the public pricing page
     * is a separate question, tracked in the PR. */
    teamEvalIterations: teamEntry?.limits.maxEvalIterationsPerMonth ?? null,
    // Limit-wall copy and destinations follow the plan whose limits the user
    // is actually receiving. During a Team trial the persisted billing plan is
    // still Free, while the effective plan (and its limits) is Team.
    effectivePlan,
    // Keep the persisted plan separate for real billing/checkout decisions.
    currentPlan,
    organizationName: billingStatus?.organizationName ?? "your organization",
    canManageBilling,
    isLoadingBilling,
    isStarting: isStartingPlanChange,
    start,
  };
}
