import { useCallback, useEffect, useRef, useState } from "react";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import {
  UPGRADE_RETURN_ORG_PARAM,
  UPGRADE_RETURN_ORIGIN_PARAM,
  UPGRADE_RETURN_PARAM,
  useUpgradeCheckout,
  type UpgradeOrigin,
} from "@/hooks/use-upgrade-checkout";
import { track } from "@/lib/analytics";
import { toast } from "@/lib/toast";
import { usePlanLimitDialogStore } from "@/stores/plan-limit-dialog-store";
import { useUpgradeRequestRecipients } from "@/hooks/use-upgrade-request-recipients";
import { PlanLimitDialogView } from "@/components/billing/PlanLimitDialogView";

/** Same destination as the pricing page's Enterprise CTA. */
const ENTERPRISE_CONTACT_URL = "https://www.mcpjam.com/contact";

// Stripe redirects before its webhook-backed billing state is guaranteed to
// have reached the client. Keep the return marker alive briefly so the reactive
// billing query can observe a successful plan change before we classify a
// still-Free result as an abandoned checkout.
const UPGRADE_RETURN_SETTLEMENT_GRACE_MS = 30_000;

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatResetClock(resetsAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetsAt));
}

/** "about 9 hours". The absolute timestamp alone makes the user do arithmetic
 * at exactly the wrong moment. */
function formatResetDistance(resetsAt: number): string | null {
  const diffMs = resetsAt - Date.now();
  if (diffMs <= 0) return null;
  const hours = Math.round(diffMs / (60 * 60 * 1000));
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(diffMs / 60_000));
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 36) {
    return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

interface UpgradeReturn {
  organizationId: string;
  origin: UpgradeOrigin;
}

function readUpgradeReturn(): UpgradeReturn | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get(UPGRADE_RETURN_PARAM) !== "return") return null;
  const organizationId = params.get(UPGRADE_RETURN_ORG_PARAM);
  if (!organizationId) return null;
  const rawOrigin = params.get(UPGRADE_RETURN_ORIGIN_PARAM);
  return {
    organizationId,
    origin: rawOrigin === "credits" ? "credits" : "evals",
  };
}

function stripUpgradeReturnParams(): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.delete(UPGRADE_RETURN_PARAM);
  params.delete(UPGRADE_RETURN_ORG_PARAM);
  params.delete(UPGRADE_RETURN_ORIGIN_PARAM);
  const search = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname +
      (search ? `?${search}` : "") +
      window.location.hash,
  );
}

/**
 * Handles the post-checkout return for both limit walls. Mounted app-wide, so
 * it runs wherever the user was blocked rather than on the billing page.
 *
 * The return marker is present whether the user paid or bailed at Stripe, so
 * the confirmation is gated on the plan having actually changed. Never
 * announce a purchase we can't see.
 */
function useUpgradeReturnFlow(): void {
  const [upgradeReturn] = useState<UpgradeReturn | null>(() =>
    readUpgradeReturn(),
  );
  const [settlementGraceElapsed, setSettlementGraceElapsed] = useState(false);
  const handledRef = useRef(false);
  const { billingStatus, planCatalog, isLoadingBilling } =
    useOrganizationBilling(upgradeReturn?.organizationId ?? null);

  useEffect(() => {
    if (
      !upgradeReturn ||
      handledRef.current ||
      isLoadingBilling ||
      billingStatus?.plan !== "free"
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSettlementGraceElapsed(true);
    }, UPGRADE_RETURN_SETTLEMENT_GRACE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [billingStatus?.plan, isLoadingBilling, upgradeReturn]);

  useEffect(() => {
    if (!upgradeReturn || handledRef.current) return;
    if (isLoadingBilling || !billingStatus) return;

    const upgraded = billingStatus.plan !== "free";
    if (!upgraded && !settlementGraceElapsed) return;

    handledRef.current = true;
    stripUpgradeReturnParams();

    if (upgraded) {
      const teamName = planCatalog?.plans.team.displayName ?? "Team";
      toast.success(
        upgradeReturn.origin === "credits"
          ? `You're on our ${teamName} plan. Your credits are available now.`
          : `You're on our ${teamName} plan. Run your suite again to pick up where you left off.`,
      );
    }

    track("plan_limit_upgrade_returned", {
      location: "plan_limit_dialog",
      origin: upgradeReturn.origin,
      upgraded,
      plan: billingStatus.plan,
      billing_interval: billingStatus.billingInterval,
    });
  }, [
    billingStatus,
    isLoadingBilling,
    planCatalog,
    settlementGraceElapsed,
    upgradeReturn,
  ]);
}

/**
 * The free-plan wall for eval iterations. Replaces a dead-end `toast.error`
 * with a decision surface, and starts checkout directly rather than routing
 * through the billing page.
 */
export function PlanLimitDialog() {
  useUpgradeReturnFlow();

  const isOpen = usePlanLimitDialogStore((s) => s.isOpen);
  const limit = usePlanLimitDialogStore((s) => s.limit);
  const close = usePlanLimitDialogStore((s) => s.close);

  const organizationId = limit?.organizationId ?? null;
  const upgrade = useUpgradeCheckout({
    organizationId,
    origin: "evals",
    limitKind: limit?.kind ?? "evalIterations",
  });
  const requestRecipients = useUpgradeRequestRecipients(organizationId);

  useEffect(() => {
    if (!isOpen || !limit) return;
    track("plan_limit_dialog_shown", {
      location: "plan_limit_dialog",
      limit_kind: limit.kind,
      origin: limit.origin,
      used: limit.used,
      allowed: limit.allowed,
      window_kind: limit.windowKind,
    });
  }, [isOpen, limit]);

  // New tab, not a same-tab navigation or a mailto. The user is mid-task with a
  // blocked eval run; sending them away from the app (or into a mail client
  // that may not be configured) loses their place for no reason.
  const handleRequestEnterprise = useCallback(() => {
    track("plan_limit_enterprise_cta_clicked", {
      location: "plan_limit_dialog",
      limit_kind: limit?.kind ?? "evalIterations",
      origin: limit?.origin,
      plan: upgrade.currentPlan,
    });
    window.open(ENTERPRISE_CONTACT_URL, "_blank", "noopener,noreferrer");
    close();
  }, [close, limit, upgrade.currentPlan]);

  const handleDismiss = useCallback(() => {
    if (limit) {
      track("plan_limit_dialog_dismissed", {
        location: "plan_limit_dialog",
        limit_kind: limit.kind,
        origin: limit.origin,
      });
    }
    close();
  }, [close, limit]);

  if (!isOpen || !limit || limit.kind !== "evalIterations") return null;

  const windowLabel = limit.windowKind === "day" ? "today" : "this month";
  const perWindow = limit.windowKind === "day" ? "a day" : "a month";

  // An org already on a paid plan can hit its own ceiling. Naming "Free" there
  // would be wrong, and so would pitching the plan they're already on.
  const isFreePlan = upgrade.currentPlan === "free";
  const planName = isFreePlan ? "Free" : "Your plan";
  const planSentence =
    limit.allowed != null
      ? `${planName} includes ${formatCount(limit.allowed)} ${perWindow}, and `
      : "";
  const resetDistance = limit.resetsAt
    ? formatResetDistance(limit.resetsAt)
    : null;
  const resetSentence = limit.resetsAt
    ? `${planSentence ? "yours reset" : "Yours reset"} at ${formatResetClock(
        limit.resetsAt,
      )}${resetDistance ? `, ${resetDistance} from now` : ""}.`
    : "";

  const showUpgrade = isFreePlan && upgrade.canManageBilling;
  // A paid org at its own ceiling has no self-serve step left, so it gets the
  // sales path instead of a checkout button.
  const showEnterprise = !isFreePlan && upgrade.currentPlan !== "enterprise";
  // The eval figure comes from the plan catalog, never a hardcoded string, so
  // it tracks whatever billing actually enforces. Credits deliberately have no
  // figure: they aren't in the catalog, so the only source would be the
  // hardcoded marketing table, which is exactly what goes stale.
  const upgradeSentence = isFreePlan
    ? `Our ${upgrade.teamName} plan includes ${
        upgrade.teamEvalIterations
          ? `${formatCount(upgrade.teamEvalIterations)} a month`
          : "a monthly allowance instead of a daily cap"
      }, so evals can run smoothly on every PR instead of limiting your daily quality checks.`
    : showEnterprise
      ? "Enterprise adds negotiated usage and a custom LLM budget."
      : "";

  return (
    <PlanLimitDialogView
      title={`You're out of eval iterations ${windowLabel}`}
      description={`${`${planSentence}${resetSentence} ${upgradeSentence}`.trim()}${
        isFreePlan && !upgrade.canManageBilling
          ? " Only an owner can upgrade this organization."
          : ""
      }`}
      showUpgrade={showUpgrade}
      showEnterprise={showEnterprise}
      requestRecipients={requestRecipients}
      organizationName={upgrade.organizationName}
      origin="evals"
      limitKind={limit.kind}
      interval={upgrade.interval}
      onIntervalChange={upgrade.setInterval}
      annualPriceLabel={upgrade.annualPriceLabel}
      monthlyPriceLabel={upgrade.monthlyPriceLabel}
      annualDiscountPct={upgrade.annualDiscountPct}
      annualSupported={upgrade.annualSupported}
      monthlySupported={upgrade.monthlySupported}
      teamName={upgrade.teamName}
      isStarting={upgrade.isStarting}
      onUpgrade={() => void upgrade.start()}
      onRequestEnterprise={handleRequestEnterprise}
      onDismiss={handleDismiss}
    />
  );
}
