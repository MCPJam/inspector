import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

export type OrganizationPlan = "free" | "starter" | "team" | "enterprise";
export type BillingInterval = "monthly" | "annual";
export type BillingModel = "flat" | "per_seat" | "contact";
export type BillingOfferKey =
  | "starter_public_monthly"
  | "starter_public_annual"
  | "starter_legacy_monthly"
  | "starter_legacy_annual"
  | "team_public_monthly"
  | "team_public_annual";
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

/** Mirrors backend premiumness gate keys exactly. */
export type PremiumnessGateKey =
  | "sandboxes"
  | "evals"
  | "cicd"
  | "auditLog"
  | "maxMembers"
  | "maxWorkspaces"
  | "maxServersPerWorkspace"
  | "maxSandboxesPerWorkspace"
  | "maxEvalRunsPerMonth";

export type BillingEnforcementState = "enabled" | "disabled";

export interface GateDecision {
  allowed: boolean;
  gateKey: PremiumnessGateKey;
  upgradePlan?: OrganizationPlan | null;
}

export interface PremiumnessState {
  organizationId?: string;
  workspaceId?: string;
  enforcementState: BillingEnforcementState;
  /** Effective plan for UX (trials, simulations). */
  effectivePlan: OrganizationPlan;
  /** Persisted commercial plan (Stripe/admin), may differ during trials. */
  plan?: OrganizationPlan;
  gates: Partial<Record<PremiumnessGateKey, GateDecision>>;
}

export interface OrganizationEntitlements {
  plan: OrganizationPlan;
  billingInterval: BillingInterval | null;
  source: "persisted" | "simulation";
  features: Record<BillingFeatureName, boolean>;
  limits: Record<BillingLimitName, number | null>;
}

export interface OrganizationBillingStatus {
  organizationId: string;
  organizationName: string;
  plan: OrganizationPlan;
  effectivePlan: OrganizationPlan;
  source: string;
  billingInterval: BillingInterval | null;
  billingConfigured: boolean;
  subscriptionStatus: string | null;
  canManageBilling: boolean;
  isOwner: boolean;
  hasCustomer: boolean;
  stripeCurrentPeriodEnd: number | null;
  stripePriceId: string | null;
  stripeSeatQuantity?: number | null;
  billingOfferKey?: BillingOfferKey | null;
  billingModel?: BillingModel | null;
  unitAmountCents?: number | null;
  includedSeats?: number | null;
  seatMinimum?: number | null;
  trialStatus: string;
  trialPlan: OrganizationPlan | null;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  decisionRequired: boolean;
  trialDecision: string | null;
}

export interface PlanCatalogEntry {
  plan: OrganizationPlan;
  displayName: string;
  billingModel?: BillingModel;
  isSelfServe: boolean;
  prices: Record<BillingInterval, number | null>;
  features: Record<BillingFeatureName, boolean>;
  limits: Record<BillingLimitName, number | null>;
  includedSeats?: number | null;
  seatMinimum?: number | null;
  checkout?: {
    ctaKind: "open_app" | "deep_link" | "contact";
    plan: "starter" | "team" | null;
    intervals: BillingInterval[];
  };
}

export interface PlanCatalog {
  catalogVersion: string;
  currency: string;
  appOrigin?: string;
  plans: Record<OrganizationPlan, PlanCatalogEntry>;
}

export function isPaidPlan(plan: OrganizationPlan): boolean {
  return plan !== "free";
}

export interface UseOrganizationBillingOptions {
  workspaceId?: string | null;
}

export function useOrganizationBillingStatus(
  organizationId: string | null,
): OrganizationBillingStatus | undefined {
  return useQuery(
    "billing:getOrganizationBillingStatus" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as OrganizationBillingStatus | undefined;
}

export function useOrganizationBilling(
  organizationId: string | null,
  options?: UseOrganizationBillingOptions,
) {
  const workspaceId = options?.workspaceId ?? null;

  const billingStatus = useOrganizationBillingStatus(organizationId);

  const entitlements = useQuery(
    "billing:getOrganizationEntitlements" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as OrganizationEntitlements | undefined;

  const organizationPremiumness = useQuery(
    "billing:getOrganizationPremiumness" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as PremiumnessState | undefined;

  const workspacePremiumness = useQuery(
    "billing:getWorkspacePremiumness" as any,
    organizationId && workspaceId
      ? ({ organizationId, workspaceId } as any)
      : "skip",
  ) as PremiumnessState | undefined;

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
  const selectFreeAfterTrialMutation = useMutation(
    "billing:selectOrganizationFreePlanAfterTrial" as any,
  );

  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [isSelectingFreeAfterTrial, setIsSelectingFreeAfterTrial] =
    useState(false);
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

  const selectFreeAfterTrial = useCallback(async () => {
    if (!organizationId) throw new Error("Organization is required");
    setIsSelectingFreeAfterTrial(true);
    setError(null);
    try {
      await selectFreeAfterTrialMutation({ organizationId } as any);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to choose free plan";
      setError(message);
      throw err;
    } finally {
      setIsSelectingFreeAfterTrial(false);
    }
  }, [organizationId, selectFreeAfterTrialMutation]);

  const isLoadingOrganizationPremiumness =
    !!organizationId && organizationPremiumness === undefined;
  const isLoadingWorkspacePremiumness =
    !!organizationId && !!workspaceId && workspacePremiumness === undefined;

  return {
    billingStatus,
    organizationPremiumness,
    workspacePremiumness,
    entitlements,
    planCatalog,
    isLoadingBilling: !!organizationId && billingStatus === undefined,
    isLoadingEntitlements: !!organizationId && entitlements === undefined,
    isLoadingOrganizationPremiumness,
    isLoadingWorkspacePremiumness,
    isLoadingPlanCatalog: !!organizationId && planCatalog === undefined,
    isStartingCheckout,
    isOpeningPortal,
    isSelectingFreeAfterTrial,
    error,
    startCheckout,
    openPortal,
    selectFreeAfterTrial,
  };
}
