import { useAction, useQuery } from "convex/react";
import { useCallback, useState } from "react";

export type OrganizationPlan = "free" | "starter" | "team" | "enterprise";
export type BillingInterval = "monthly" | "annual";
export type BillingFeatureName =
  | "evals"
  | "sandboxes"
  | "cicd"
  | "customDomains"
  | "auditLog"
  | "sso"
  | "prioritySupport";
export type BillingLimitName =
  | "maxMembers"
  | "maxWorkspaces"
  | "maxServersPerWorkspace"
  | "maxSandboxesPerWorkspace"
  | "maxEvalRunsPerMonth";

export interface OrganizationEntitlements {
  plan: OrganizationPlan;
  billingInterval: BillingInterval | null;
  source: "persisted" | "simulation";
  features: Record<BillingFeatureName, boolean>;
  limits: Record<BillingLimitName, number | null>;
}

export interface BillingRolloutState {
  enforcementConfigured: boolean;
  gracePeriodEndsAt: string | null;
  enforcementActive: boolean;
}

export interface OrganizationBillingStatus {
  organizationId: string;
  organizationName: string;
  plan: OrganizationPlan;
  billingInterval: BillingInterval | null;
  billingConfigured: boolean;
  subscriptionStatus: string | null;
  canManageBilling: boolean;
  isOwner: boolean;
  hasCustomer: boolean;
  stripeCurrentPeriodEnd: number | null;
  stripePriceId: string | null;
}

export interface PlanCatalogEntry {
  plan: OrganizationPlan;
  displayName: string;
  isSelfServe: boolean;
  prices: Record<BillingInterval, number | null>;
  features: Record<BillingFeatureName, boolean>;
  limits: Record<BillingLimitName, number | null>;
}

export interface PlanCatalog {
  catalogVersion: string;
  currency: string;
  plans: Record<OrganizationPlan, PlanCatalogEntry>;
}

export function isPaidPlan(plan: OrganizationPlan): boolean {
  return plan !== "free";
}

export function useOrganizationBilling(organizationId: string | null) {
  const billingStatus = useQuery(
    "billing:getOrganizationBillingStatus" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as OrganizationBillingStatus | undefined;
  const entitlements = useQuery(
    "billing:getOrganizationEntitlements" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as OrganizationEntitlements | undefined;
  const rolloutState = useQuery(
    "billing:getBillingRolloutState" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as BillingRolloutState | undefined;
  const planCatalog = useQuery(
    "billing:getPlanCatalog" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as PlanCatalog | undefined;

  const createCheckout = useAction(
    "billing:createOrganizationCheckoutSession" as any,
  );
  const createPortal = useAction(
    "billing:createOrganizationBillingPortalSession" as any,
  );

  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = useCallback(
    async (
      returnUrl: string,
      tier: "starter" | "team" = "starter",
      billingInterval: BillingInterval = "monthly",
    ) => {
      if (!organizationId) throw new Error("Organization is required");
      setIsStartingCheckout(true);
      setError(null);
      try {
        const result = await createCheckout({
          organizationId,
          returnUrl,
          tier,
          billingInterval,
        });
        return result.checkoutUrl as string;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create checkout";
        setError(message);
        throw err;
      } finally {
        setIsStartingCheckout(false);
      }
    },
    [createCheckout, organizationId],
  );

  const openPortal = useCallback(
    async (returnUrl: string) => {
      if (!organizationId) throw new Error("Organization is required");
      setIsOpeningPortal(true);
      setError(null);
      try {
        const result = await createPortal({
          organizationId,
          returnUrl,
        });
        return result.portalUrl as string;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to open billing portal";
        setError(message);
        throw err;
      } finally {
        setIsOpeningPortal(false);
      }
    },
    [createPortal, organizationId],
  );

  return {
    billingStatus,
    entitlements,
    rolloutState,
    planCatalog,
    isLoadingBilling: !!organizationId && billingStatus === undefined,
    isLoadingEntitlements: !!organizationId && entitlements === undefined,
    isLoadingRollout: !!organizationId && rolloutState === undefined,
    isLoadingPlanCatalog: !!organizationId && planCatalog === undefined,
    isStartingCheckout,
    isOpeningPortal,
    error,
    startCheckout,
    openPortal,
  };
}
