import type {
  OrganizationBillingStatus,
  OrganizationPlan,
} from "@/hooks/useOrganizationBilling";

const PLAN_RANK: Record<OrganizationPlan, number> = {
  free: 0,
  starter: 1,
  team: 2,
  enterprise: 3,
};

export type CheckoutPlanTier = "starter" | "team";

export type CheckoutIntentGuardResult =
  | { proceed: true }
  | {
      proceed: false;
      reason: "already_on" | "already_higher";
      currentPlan: OrganizationPlan;
    };

type BillingStatusForCheckoutGuard = Pick<
  OrganizationBillingStatus,
  "effectivePlan" | "source"
>;

/**
 * Compares billing status to a deep-link checkout tier.
 * Trial orgs may still purchase Starter or Team immediately.
 */
export function guardCheckoutIntentAgainstBillingStatus(
  billingStatus: BillingStatusForCheckoutGuard,
  requestedTier: CheckoutPlanTier,
): CheckoutIntentGuardResult {
  if (billingStatus.source === "trial") {
    return { proceed: true };
  }

  const { effectivePlan } = billingStatus;
  if (effectivePlan === requestedTier) {
    return {
      proceed: false,
      reason: "already_on",
      currentPlan: effectivePlan,
    };
  }
  if (PLAN_RANK[effectivePlan] > PLAN_RANK[requestedTier]) {
    return {
      proceed: false,
      reason: "already_higher",
      currentPlan: effectivePlan,
    };
  }
  return { proceed: true };
}
