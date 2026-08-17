import { useCallback, useEffect, useRef, useState } from "react";
import { useOrganizationBilling } from "@/hooks/useOrganizationBilling";
import {
  consumeUpgradeReturnToken,
  UPGRADE_RETURN_ORG_PARAM,
  UPGRADE_RETURN_ORIGIN_PARAM,
  UPGRADE_RETURN_PARAM,
  useUpgradeCheckout,
  type UpgradeOrigin,
} from "@/hooks/use-upgrade-checkout";
import { ErrorBoundary } from "@/components/ui/error-boundary";
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

/** Pure: reading the URL is safe to repeat. Claiming the return is not, and
 * happens once in an effect below. */
function readUpgradeReturnParams(): UpgradeReturn | null {
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
      window.location.hash
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
function UpgradeReturnFlow({
  upgradeReturn,
}: {
  upgradeReturn: UpgradeReturn;
}) {
  const [settlementGraceElapsed, setSettlementGraceElapsed] = useState(false);
  const settledRef = useRef(false);
  const waitReportedRef = useRef(false);
  const { billingStatus, planCatalog, isLoadingBilling } =
    useOrganizationBilling(upgradeReturn.organizationId);

  useEffect(() => {
    if (
      settledRef.current ||
      isLoadingBilling ||
      billingStatus?.plan !== "free"
    ) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSettlementGraceElapsed(true);
    }, UPGRADE_RETURN_SETTLEMENT_GRACE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [billingStatus?.plan, isLoadingBilling]);

  useEffect(() => {
    if (settledRef.current) return;
    if (isLoadingBilling || !billingStatus) return;

    const upgraded = billingStatus.plan !== "free";
    if (!upgraded && !settlementGraceElapsed) return;
    // A webhook slower than the grace window is still a real purchase. Report
    // the wait once, then keep watching: the plan flip that lands late still
    // owes the user a confirmation, and freezing the record at "abandoned"
    // would misreport a customer who paid.
    if (!upgraded && waitReportedRef.current) return;

    const settlement = upgraded
      ? waitReportedRef.current
        ? "late"
        : "immediate"
      : "pending";
    if (upgraded) {
      settledRef.current = true;
    } else {
      waitReportedRef.current = true;
    }

    if (upgraded) {
      const teamName = planCatalog?.plans.team.displayName ?? "Team";
      toast.success(
        upgradeReturn.origin === "credits"
          ? `You're on the ${teamName} plan. Your credits are available now.`
          : `You're on the ${teamName} plan. Run your suite again to pick up where you left off.`
      );
    }

    track("plan_limit_upgrade_returned", {
      location: "plan_limit_dialog",
      organization_id: upgradeReturn.organizationId,
      origin: upgradeReturn.origin,
      upgraded,
      // "pending" is a checkout we couldn't see settle in time, not a bail.
      // Count conversions on "immediate" + "late".
      settlement,
      plan: billingStatus.plan,
      current_plan: billingStatus.plan,
      effective_plan: billingStatus.effectivePlan ?? billingStatus.plan,
      billing_interval: billingStatus.billingInterval,
      can_manage_billing: billingStatus.canManageBilling ?? false,
    });
  }, [
    billingStatus,
    isLoadingBilling,
    planCatalog,
    settlementGraceElapsed,
    upgradeReturn,
  ]);

  return null;
}

function UpgradeReturnFlowBoundary() {
  const [pendingReturn] = useState<UpgradeReturn | null>(() =>
    readUpgradeReturnParams()
  );
  const [upgradeReturn, setUpgradeReturn] = useState<UpgradeReturn | null>(
    null
  );
  const claimedRef = useRef(false);

  // Claiming is a side effect — it burns the one-shot token and rewrites the
  // URL — so it runs in an effect, guarded to once. The app mounts under
  // StrictMode, which double-invokes render-phase work and remounts effects in
  // dev; a marker claimed twice is a confirmation lost.
  useEffect(() => {
    if (!pendingReturn || claimedRef.current) return;
    claimedRef.current = true;
    // Strip regardless of the outcome: these params must not survive into a
    // reload, a bookmark, or a link pasted to someone else.
    stripUpgradeReturnParams();
    // Only the tab that started checkout can settle a return. Without this the
    // marker is just a URL: anyone loading it in an org already on a paid plan
    // gets a purchase confirmation, and the funnel gets a conversion, for a
    // checkout that never happened.
    if (consumeUpgradeReturnToken(pendingReturn.organizationId)) {
      setUpgradeReturn(pendingReturn);
    }
  }, [pendingReturn]);

  if (!upgradeReturn) return null;

  // The org id rides in from a URL, so the billing query can reject it — a
  // deleted org, or membership revoked between checkout and return. Convex
  // rethrows that from `useQuery` during render, and this is mounted app-wide,
  // so without a boundary one bad marker replaces the entire app.
  return (
    <ErrorBoundary name="upgrade-return-flow" fallback={null}>
      <UpgradeReturnFlow upgradeReturn={upgradeReturn} />
    </ErrorBoundary>
  );
}

/**
 * The free-plan wall for eval iterations. Replaces a dead-end `toast.error`
 * with a decision surface, and starts checkout directly rather than routing
 * through the billing page.
 */
export function PlanLimitDialog() {
  return (
    <>
      <UpgradeReturnFlowBoundary />
      <PlanLimitWall />
    </>
  );
}

function PlanLimitWall() {
  const isOpen = usePlanLimitDialogStore((s) => s.isOpen);
  const limit = usePlanLimitDialogStore((s) => s.limit);
  const close = usePlanLimitDialogStore((s) => s.close);
  const impressionTrackedRef = useRef(false);

  const organizationId = limit?.organizationId ?? null;
  const upgrade = useUpgradeCheckout({
    organizationId,
    origin: "evals",
    limitKind: limit?.kind ?? "evalIterations",
  });
  const {
    recipients: requestRecipients,
    isLoading: isLoadingRequestRecipients,
  } = useUpgradeRequestRecipients(organizationId);

  // Derived once, for both the impression event and the render. Two copies of
  // this rule drift, and then the funnel reports a variant nobody saw.
  //
  // Nothing plan-specific renders until billing resolves: the hook defaults to
  // free/can't-manage, which would flash the member wall at an owner (whose
  // "email your owner" draft is addressed to themself) and the Free pitch at a
  // paid org.
  const isBillingReady = !upgrade.isLoadingBilling;
  const isFreePlan = upgrade.effectivePlan === "free";
  const isEnterprisePlan = upgrade.effectivePlan === "enterprise";
  const showUpgrade = isBillingReady && isFreePlan && upgrade.canManageBilling;
  // A paid org at its own ceiling has no self-serve step left, so it gets the
  // sales path instead of a checkout button.
  const showEnterprise = isBillingReady && !isFreePlan && !isEnterprisePlan;
  // Enterprise is excluded deliberately: asking an owner to "upgrade to Team"
  // is a downgrade pitch, and there is nothing above Enterprise to ask for.
  const showRequest =
    isBillingReady && !showUpgrade && !showEnterprise && !isEnterprisePlan;

  useEffect(() => {
    if (!isOpen || !limit) {
      impressionTrackedRef.current = false;
      return;
    }
    if (upgrade.isLoadingBilling || impressionTrackedRef.current) return;
    if (showRequest && isLoadingRequestRecipients) return;

    impressionTrackedRef.current = true;
    track("plan_limit_dialog_shown", {
      location: "plan_limit_dialog",
      wall_kind: "eval_iterations",
      organization_id: organizationId,
      limit_kind: limit.kind,
      origin: limit.origin,
      used: limit.used,
      allowed: limit.allowed,
      window_kind: limit.windowKind,
      current_plan: upgrade.currentPlan,
      effective_plan: upgrade.effectivePlan,
      can_manage_billing: upgrade.canManageBilling,
      audience: upgrade.canManageBilling ? "billing_manager" : "member",
      primary_action: showUpgrade
        ? "upgrade"
        : showEnterprise
        ? "enterprise"
        : requestRecipients.length > 0
        ? "request_owner"
        : "none",
      request_recipient_count: requestRecipients.length,
      billing_interval: upgrade.interval,
      annual_supported: upgrade.annualSupported,
      monthly_supported: upgrade.monthlySupported,
    });
  }, [
    isOpen,
    isLoadingRequestRecipients,
    limit,
    organizationId,
    requestRecipients.length,
    showEnterprise,
    showRequest,
    showUpgrade,
    upgrade.annualSupported,
    upgrade.canManageBilling,
    upgrade.currentPlan,
    upgrade.effectivePlan,
    upgrade.interval,
    upgrade.isLoadingBilling,
    upgrade.monthlySupported,
  ]);

  // New tab, not a same-tab navigation or a mailto. The user is mid-task with a
  // blocked eval run; sending them away from the app (or into a mail client
  // that may not be configured) loses their place for no reason.
  const handleRequestEnterprise = useCallback(() => {
    window.open(ENTERPRISE_CONTACT_URL, "_blank", "noopener,noreferrer");
    close();
    track("plan_limit_enterprise_cta_clicked", {
      location: "plan_limit_dialog",
      organization_id: organizationId,
      limit_kind: limit?.kind ?? "evalIterations",
      origin: limit?.origin,
      plan: upgrade.effectivePlan,
      current_plan: upgrade.currentPlan,
      effective_plan: upgrade.effectivePlan,
      can_manage_billing: upgrade.canManageBilling,
    });
  }, [
    close,
    limit,
    organizationId,
    upgrade.canManageBilling,
    upgrade.currentPlan,
    upgrade.effectivePlan,
  ]);

  const handleDismiss = useCallback(() => {
    close();
    if (limit) {
      track("plan_limit_dialog_dismissed", {
        location: "plan_limit_dialog",
        wall_kind: "eval_iterations",
        organization_id: organizationId,
        limit_kind: limit.kind,
        origin: limit.origin,
        current_plan: upgrade.currentPlan,
        effective_plan: upgrade.effectivePlan,
        audience: upgrade.canManageBilling ? "billing_manager" : "member",
      });
    }
  }, [
    close,
    limit,
    organizationId,
    upgrade.canManageBilling,
    upgrade.currentPlan,
    upgrade.effectivePlan,
  ]);

  const handleUpgrade = useCallback(async () => {
    const result = await upgrade.start();
    if (result?.shouldDismiss) close();
  }, [close, upgrade]);

  if (!isOpen || !limit || limit.kind !== "evalIterations") return null;

  const windowLabel = limit.windowKind === "day" ? "today" : "this month";
  const perWindow = limit.windowKind === "day" ? "a day" : "a month";

  // An org already on a paid plan can hit its own ceiling. Naming "Free" there
  // would be wrong, and so would pitching the plan they're already on. While
  // billing loads we don't know which, so the neutral name stands in.
  const planName = isBillingReady && isFreePlan ? "Free" : "Your plan";
  const allowanceClause =
    limit.allowed != null
      ? `${planName} includes ${formatCount(limit.allowed)} ${perWindow}`
      : "";
  const resetDistance = limit.resetsAt
    ? formatResetDistance(limit.resetsAt)
    : null;
  const resetClause = limit.resetsAt
    ? `${allowanceClause ? "yours reset" : "Yours reset"} at ${formatResetClock(
        limit.resetsAt
      )}${resetDistance ? `, ${resetDistance} from now` : ""}`
    : "";
  // The conjunction belongs to the pair, not to the allowance. Baking ", and"
  // into the allowance clause left the copy dangling on it whenever the limit
  // carries no `resetsAt`.
  const planSentence = [allowanceClause, resetClause]
    .filter(Boolean)
    .join(", and ");

  // The eval figure comes from the plan catalog, never a hardcoded string, so
  // it tracks whatever billing actually enforces. Credits deliberately have no
  // figure: they aren't in the catalog, so the only source would be the
  // hardcoded marketing table, which is exactly what goes stale.
  const upgradeSentence = !isBillingReady
    ? ""
    : isFreePlan
    ? `Our ${upgrade.teamName} plan includes ${
        upgrade.teamEvalIterations
          ? `${formatCount(upgrade.teamEvalIterations)} per seat each month`
          : "a monthly allowance instead of a daily cap"
      }, so evals can run smoothly on every PR instead of limiting your daily quality checks.`
    : showEnterprise
    ? "Enterprise adds negotiated usage and a custom LLM budget."
    : "";

  return (
    <PlanLimitDialogView
      title={`You're out of eval iterations ${windowLabel}`}
      description={`${`${
        planSentence ? `${planSentence}.` : ""
      } ${upgradeSentence}`.trim()}${
        isBillingReady && isFreePlan && !upgrade.canManageBilling
          ? " Only an owner can upgrade this organization."
          : ""
      }`}
      showUpgrade={showUpgrade}
      showEnterprise={showEnterprise}
      showRequest={showRequest}
      requestRecipients={requestRecipients}
      organizationId={organizationId}
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
      isLoadingPrices={upgrade.isLoadingPrices}
      onUpgrade={() => void handleUpgrade()}
      onRequestEnterprise={handleRequestEnterprise}
      onDismiss={handleDismiss}
    />
  );
}
