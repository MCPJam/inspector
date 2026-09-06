import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  useOrganizationBilling,
  type BillingInterval,
} from "@/hooks/useOrganizationBilling";
import {
  formatPlanName,
  getAnnualDiscountPercent,
} from "@/lib/billing-entitlements";
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

/**
 * The URL params alone can't be trusted: they survive bookmarking, sharing and
 * signed-out loads, and acting on them would announce a purchase (and record a
 * conversion) that never happened. This one-shot token is written in the tab
 * that starts checkout and consumed on the way back, so only a genuine return
 * from Stripe settles.
 *
 * It also keeps a stranger's copy of the link from feeding an org id we have no
 * access to into a Convex `v.id` query.
 */
/**
 * Scoped by user in the KEY, never stored in the value — the same shape
 * `active-organization-storage` uses. It keeps an account identifier out of
 * storage at rest, and it makes a mismatch structurally impossible rather than
 * something we have to notice and clean up: another user simply has no ticket.
 */
const UPGRADE_RETURN_TOKEN_KEY_PREFIX = "mcpjam.upgradeReturnToken";

function upgradeReturnTokenKey(userId: string): string {
  return `${UPGRADE_RETURN_TOKEN_KEY_PREFIX}:${userId}`;
}
const UPGRADE_RETURN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export interface UpgradeReturnTicket {
  organizationId: string;
  origin: UpgradeOrigin;
  /** Whose ticket this is. Comes from the storage key, not the stored value,
   * so it is never written down: sessionStorage is per-tab, not per-identity,
   * and without scoping, signing out and letting someone else sign in inside
   * the same tab would hand them a confirmation they never earned. */
  userId: string;
  /** We already reported one settlement wait for this checkout. Survives a
   * reload so a slow webhook is still recorded as "late", not "immediate". */
  waited: boolean;
}

export function stashUpgradeReturnToken(
  organizationId: string,
  origin: UpgradeOrigin,
  userId: string
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      upgradeReturnTokenKey(userId),
      JSON.stringify({ organizationId, origin, issuedAt: Date.now() })
    );
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). Checkout
    // still works; the user just doesn't get the return confirmation.
  }
}

/**
 * Reads WITHOUT clearing, so the pending confirmation survives a reload or a
 * remount while Stripe's webhook is still in flight — the toast used to depend
 * on the tab staying mounted for the whole round trip, which is not something
 * the user controls.
 *
 * The ticket, not the URL, is what arms the return: params are stripped on
 * arrival, so a shared or bookmarked link still confirms nothing. Clearing is
 * `clearUpgradeReturnToken`, once the outcome is known.
 */
export function readUpgradeReturnToken(
  currentUserId: string | null
): UpgradeReturnTicket | null {
  if (typeof window === "undefined") return null;
  // No identity to check against yet (auth still resolving, or signed out).
  // Leave the ticket alone rather than retiring a pending confirmation that
  // still belongs to whoever comes back — a refresh blip is not a new user.
  if (!currentUserId) return null;
  try {
    const raw = window.sessionStorage.getItem(
      upgradeReturnTokenKey(currentUserId)
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      organizationId?: string;
      origin?: string;
      issuedAt?: number;
      waited?: boolean;
    };
    const fresh =
      typeof parsed?.issuedAt === "number" &&
      Date.now() - parsed.issuedAt < UPGRADE_RETURN_TOKEN_TTL_MS;
    // The TTL is the give-up: a checkout abandoned at Stripe leaves a ticket
    // nothing will ever settle, and it must not wait in this tab forever.
    if (!fresh || !parsed.organizationId) {
      clearUpgradeReturnToken(currentUserId);
      return null;
    }
    return {
      organizationId: parsed.organizationId,
      origin: parsed.origin === "credits" ? "credits" : "evals",
      userId: currentUserId,
      waited: parsed.waited === true,
    };
  } catch {
    return null;
  }
}

/** Records that we already announced a settlement wait for this checkout. */
export function markUpgradeReturnWaited(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    const key = upgradeReturnTokenKey(userId);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    window.sessionStorage.setItem(
      key,
      JSON.stringify({ ...parsed, waited: true })
    );
  } catch {
    // Best effort: losing this only downgrades a "late" report to "immediate".
  }
}

export function clearUpgradeReturnToken(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(upgradeReturnTokenKey(userId));
  } catch {
    // Nothing to do; a stale ticket expires on its own via the TTL.
  }
}

/**
 * The desktop shell cancels in-app navigation to an external origin and hands
 * the URL to the system browser, so checkout can never complete in place.
 */
function isDesktopApp(): boolean {
  return typeof window !== "undefined" && window.isElectron === true;
}

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

/**
 * Every `start()` path reports the same two facts: whether the browser is on
 * its way to Stripe, and whether the caller should close its dialog.
 */
export interface UpgradeStartResult {
  redirected: boolean;
  shouldDismiss: boolean;
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
    isLoadingPlanCatalog,
  } = useOrganizationBilling(organizationId);
  // Stamped onto the return ticket so only the buyer can redeem it.
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const teamEntry = planCatalog?.plans.team;
  // One rule for the whole path: an interval is offered only if the catalog
  // both supports it and has priced it, so checkout can never buy something
  // the card didn't name. `checkout: null` means no self-serve intervals at
  // all rather than "assume both". Before the catalog lands there is nothing
  // to trust yet, so both cards render as placeholders and `isLoadingPrices`
  // keeps checkout closed.
  const supportedIntervals: BillingInterval[] = teamEntry
    ? (teamEntry.checkout?.supportedIntervals ?? []).filter(
        (candidate) => teamEntry.prices[candidate] != null
      )
    : ["monthly", "annual"];
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

  const start = useCallback(async (): Promise<UpgradeStartResult> => {
    if (!organizationId) return { redirected: false, shouldDismiss: false };
    // The catalog is a separate query from billingStatus, so the CTA can be
    // live while prices and interval support are still unknown. Never send
    // anyone to checkout on a price we haven't shown them.
    if (isLoadingPlanCatalog || !teamEntry) {
      return { redirected: false, shouldDismiss: false };
    }
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
      return { redirected: false, shouldDismiss: false };
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
      if (result.kind === "checkout" || result.kind === "portal") {
        const nextUrl =
          result.kind === "checkout" ? result.checkoutUrl : result.portalUrl;
        if (isDesktopApp()) {
          // Return-in-place is impossible here: the shell opens Stripe in the
          // system browser, so the return URL lands in a different session.
          // Say where checkout went and release the dialog, rather than
          // leaving it open behind a page that will never navigate.
          window.open(nextUrl, "_blank", "noopener,noreferrer");
          toast.info(
            "Finish checkout in your browser. Your new plan unlocks here automatically."
          );
          return { redirected: true, shouldDismiss: true };
        }
        // Same tab, so the return URL brings the user back in place. The token
        // is what makes that return trustworthy on the way back.
        if (userId) stashUpgradeReturnToken(organizationId, origin, userId);
        window.location.assign(nextUrl);
        return { redirected: true, shouldDismiss: false };
      }

      if (result.kind === "updated") {
        toast.success(
          `Plan updated to ${formatPlanName(
            result.subscription.plan ?? "team"
          )}.`
        );
      } else {
        toast.success("Plan change scheduled for renewal.");
      }
      track("plan_limit_upgrade_resolved", {
        location: "plan_limit_dialog",
        organization_id: organizationId,
        limit_kind: limitKind,
        origin,
        result_kind: result.kind,
        billing_interval: checkoutInterval,
        resulting_plan: result.subscription.plan ?? "team",
        current_plan: currentPlan,
        effective_plan: effectivePlan,
      });
      return { redirected: false, shouldDismiss: true };
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
      return { redirected: false, shouldDismiss: false };
    }
  }, [
    annualSupported,
    canManageBilling,
    currentPlan,
    effectivePlan,
    interval,
    isLoadingPlanCatalog,
    limitKind,
    monthlySupported,
    organizationId,
    origin,
    startPlanChange,
    teamEntry,
    userId,
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
     * in the copy. The backend applies this amount per seat. */
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
    /** Prices and interval support come from here, so the CTA stays disabled
     * until it can name what the user is about to buy. */
    isLoadingPrices: isLoadingPlanCatalog,
    isStarting: isStartingPlanChange,
    start,
  };
}
