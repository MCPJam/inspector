import type { OrganizationPlan } from "@/hooks/useOrganizationBilling";

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

/**
 * Compares the org's effective plan to a deep-link checkout tier.
 * Blocks checkout when the user is already on that tier or on a higher self-serve tier.
 */
export function guardCheckoutIntentAgainstEffectivePlan(
  effectivePlan: OrganizationPlan,
  requestedTier: CheckoutPlanTier,
): CheckoutIntentGuardResult {
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
