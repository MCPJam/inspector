import type {
  OrganizationBillingStatus,
  OrganizationPlan,
  SelfServePlan,
} from "@/hooks/useOrganizationBilling";

const PLAN_RANK: Record<OrganizationPlan, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
};

export type CheckoutPlanTier = SelfServePlan;

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
 * Trial orgs may still purchase Pro immediately.
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
