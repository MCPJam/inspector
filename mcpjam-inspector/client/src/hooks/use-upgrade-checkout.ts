import { useCallback, useState } from "react";
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
 * `prices.annual` is the full-year amount, so the per-seat monthly figure is
 * a twelfth of it. Mirrors `formatPlanPriceLabel` on the billing page so the
 * same plan never shows two different numbers.
 */
export function formatSeatMonthlyPrice(
  amountInCents: number | null,
  currency: string | undefined,
  interval: BillingInterval,
): string | null {
  if (amountInCents == null || !currency) return null;
  if (interval === "monthly") {
    return `${formatMoney(amountInCents, currency)}/seat/mo`;
  }
  return `${formatMoney(
    Math.round(amountInCents / 12 / 100) * 100,
    currency,
  )}/seat/mo`;
}

interface UseUpgradeCheckoutParams {
  organizationId: string | null;
  origin: UpgradeOrigin;
  /** Forwarded to telemetry so we can compare which wall converts. */
  limitKind: string;
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
    annualSupported ? "annual" : "monthly",
  );

  const annualPriceLabel = formatSeatMonthlyPrice(
    teamEntry?.prices.annual ?? null,
    planCatalog?.currency,
    "annual",
  );
  const monthlyPriceLabel = formatSeatMonthlyPrice(
    teamEntry?.prices.monthly ?? null,
    planCatalog?.currency,
    "monthly",
  );

  const start = useCallback(async () => {
    if (!organizationId) return;
    track("plan_limit_upgrade_clicked", {
      location: "plan_limit_dialog",
      limit_kind: limitKind,
      origin,
      billing_interval: interval,
    });

    const url = new URL(window.location.href);
    url.searchParams.set(UPGRADE_RETURN_PARAM, "return");
    url.searchParams.set(UPGRADE_RETURN_ORG_PARAM, organizationId);
    url.searchParams.set(UPGRADE_RETURN_ORIGIN_PARAM, origin);

    try {
      const result = await startPlanChange(url.toString(), "team", interval, {
        confirmPaidPlanChange: false,
      });
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
          : "Couldn't start checkout. Please try again.",
      );
      return { redirected: false as const };
    }
  }, [interval, limitKind, organizationId, origin, startPlanChange]);

  return {
    interval,
    setInterval,
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
    currentPlan: billingStatus?.plan ?? "free",
    organizationName: billingStatus?.organizationName ?? "your organization",
    canManageBilling: billingStatus?.canManageBilling ?? false,
    isStarting: isStartingPlanChange,
    start,
  };
}
