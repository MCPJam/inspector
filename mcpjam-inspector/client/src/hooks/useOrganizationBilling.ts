import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useState } from "react";

export type OrganizationPlan = "free" | "starter" | "team" | "enterprise";
export type BillingInterval = "monthly" | "annual";
export type BillingModel = "free" | "flat" | "per_seat" | "contact";
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

export type BillingEnforcementState =
  | "active"
  | "disabled"
  | "decision_required";

export interface GateDecision {
  gateKey: PremiumnessGateKey;
  kind: "feature" | "limit";
  scope: "organization" | "workspace";
  canAccess: boolean;
  shouldShowUpsell: boolean;
  upgradePlan: OrganizationPlan | null;
  reason: string;
  currentValue?: number;
  allowedValue?: number | null;
}

export interface PremiumnessState {
  plan: OrganizationPlan;
  enforcementState: BillingEnforcementState;
  /** Effective plan for UX (trials, simulations). */
  effectivePlan: OrganizationPlan;
  billingInterval: BillingInterval | null;
  source: "free" | "subscription" | "trial" | "simulation";
  decisionRequired: boolean;
  gates: GateDecision[];
}

export interface OrganizationEntitlements {
  plan: OrganizationPlan;
  billingInterval: BillingInterval | null;
  source: OrganizationBillingStatus["source"];
  features: Record<BillingFeatureName, boolean>;
  limits: Record<BillingLimitName, number | null>;
}

export interface OrganizationBillingStatus {
  organizationId: string;
  organizationName: string;
  plan: OrganizationPlan;
  effectivePlan: OrganizationPlan;
  source: "free" | "subscription" | "trial" | "simulation";
  billingInterval: BillingInterval | null;
  billingConfigured: boolean;
  subscriptionStatus: string | null;
  canManageBilling: boolean;
  canCancelScheduledBillingChange: boolean;
  isOwner: boolean;
  hasCustomer: boolean;
  stripeScheduledPlan: OrganizationPlan | null;
  stripeScheduledBillingInterval: BillingInterval | null;
  stripeScheduledPriceId: string | null;
  stripeScheduledEffectiveAt: number | null;
  stripeCancelAtPeriodEnd: boolean;
  stripeCancelAt: number | null;
  stripeCanceledAt: number | null;
  stripeCurrentPeriodEnd: number | null;
  stripePriceId: string | null;
  stripeSeatQuantity?: number | null;
  trialStatus: string;
  trialPlan: OrganizationPlan | null;
  trialStartedAt: number | null;
  trialEndsAt: number | null;
  trialDaysRemaining: number | null;
  decisionRequired: boolean;
  trialDecision: string | null;
}

export interface PlanCatalogEntry {
  plan: OrganizationPlan;
  displayName: string;
  billingModel: BillingModel;
  isSelfServe: boolean;
  prices: Record<BillingInterval, number | null>;
  features: Record<BillingFeatureName, boolean>;
  limits: Record<BillingLimitName, number | null>;
  includedSeats: number | null;
  seatMinimum: number | null;
  checkout: {
    plan: "starter" | "team";
    supportedIntervals: BillingInterval[];
  } | null;
}

export interface PlanCatalog {
  catalogVersion: string;
  currency: string;
  appOrigin?: string;
  plans: Record<OrganizationPlan, PlanCatalogEntry>;
}

export interface OrganizationPlanChangeSnapshot {
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeSubscriptionStatus?: string;
  stripeSubscriptionItemId?: string;
  stripePriceId?: string;
  stripeSeatQuantity?: number;
  stripeScheduledPlan?: "starter" | "team" | null;
  stripeScheduledBillingInterval?: BillingInterval | null;
  stripeScheduledPriceId?: string | null;
  stripeScheduledEffectiveAt?: number | null;
  stripeCanCancelScheduledBillingChange?: boolean;
  stripeCancelAtPeriodEnd?: boolean;
  stripeCancelAt?: number | null;
  stripeCanceledAt?: number | null;
  stripeCurrentPeriodEnd?: number;
  plan?: OrganizationPlan;
  billingInterval?: BillingInterval;
}

export type OrganizationPlanChangeResult =
  | {
      kind: "checkout";
      checkoutUrl: string;
    }
  | {
      kind: "portal";
      portalUrl: string;
    }
  | {
      kind: "updated";
      subscription: OrganizationPlanChangeSnapshot;
    }
  | {
      kind: "scheduled";
      subscription: OrganizationPlanChangeSnapshot;
    };

export function isPaidPlan(plan: OrganizationPlan): boolean {
  return plan !== "free";
}

export interface UseOrganizationBillingOptions {
  workspaceId?: string | null;
  enabled?: boolean;
}

export interface UseOrganizationBillingStatusOptions {
  enabled?: boolean;
}

export interface StartOrganizationPlanChangeOptions {
  confirmPaidPlanChange?: boolean;
}

export function useOrganizationBillingStatus(
  organizationId: string | null,
  options?: UseOrganizationBillingStatusOptions,
): OrganizationBillingStatus | undefined {
  const enabled = options?.enabled ?? true;

  return useQuery(
    "billing:getOrganizationBillingStatus" as any,
    enabled && organizationId ? ({ organizationId } as any) : "skip",
  ) as OrganizationBillingStatus | undefined;
}

export function useOrganizationBilling(
  organizationId: string | null,
  options?: UseOrganizationBillingOptions,
) {
  const workspaceId = options?.workspaceId ?? null;
  const enabled = options?.enabled ?? true;
  const shouldQueryOrganization = enabled && !!organizationId;
  const shouldQueryWorkspace = shouldQueryOrganization && !!workspaceId;

  const billingStatus = useOrganizationBillingStatus(organizationId, {
    enabled,
  });

  const entitlements = useQuery(
    "billing:getOrganizationEntitlements" as any,
    shouldQueryOrganization ? ({ organizationId } as any) : "skip",
  ) as OrganizationEntitlements | undefined;

  const organizationPremiumness = useQuery(
    "billing:getOrganizationPremiumness" as any,
    shouldQueryOrganization ? ({ organizationId } as any) : "skip",
  ) as PremiumnessState | undefined;

  const workspacePremiumness = useQuery(
    "billing:getWorkspacePremiumness" as any,
    shouldQueryWorkspace ? ({ organizationId, workspaceId } as any) : "skip",
  ) as PremiumnessState | undefined;

  const planCatalog = useQuery(
    "billing:getPlanCatalog" as any,
    shouldQueryOrganization ? ({ organizationId } as any) : "skip",
  ) as PlanCatalog | undefined;

  const startPlanChangeAction = useAction(
    "billing:startOrganizationPlanChange" as any,
  );
  const createPortal = useAction(
    "billing:createOrganizationBillingPortalSession" as any,
  );
  const createCancellationPortal = useAction(
    "billing:createOrganizationBillingPortalCancellationSession" as any,
  );
  const createIntervalChangePortal = useAction(
    "billing:createOrganizationBillingPortalIntervalChangeSession" as any,
  );
  const cancelScheduledBillingChangeAction = useAction(
    "billing:cancelOrganizationScheduledBillingChange" as any,
  );
  const selectFreeAfterTrialMutation = useMutation(
    "billing:selectOrganizationFreePlanAfterTrial" as any,
  );

  const [isStartingPlanChange, setIsStartingPlanChange] = useState(false);
  const [pendingPlanChangeTarget, setPendingPlanChangeTarget] = useState<
    "starter" | "team" | null
  >(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [isCancelingScheduledBillingChange, setIsCancelingScheduledBillingChange] =
    useState(false);
  const [isSelectingFreeAfterTrial, setIsSelectingFreeAfterTrial] =
    useState(false);
  const [error, setError] = useState<string | null>(null);

  const startPlanChange = useCallback(
    async (
      returnUrl: string,
      tier: "starter" | "team" = "starter",
      billingInterval: BillingInterval = "monthly",
      options: StartOrganizationPlanChangeOptions = {},
    ): Promise<OrganizationPlanChangeResult> => {
      if (!organizationId) throw new Error("Organization is required");
      setIsStartingPlanChange(true);
      setPendingPlanChangeTarget(tier);
      setError(null);
      try {
        const result = await startPlanChangeAction({
          organizationId,
          returnUrl,
          tier,
          billingInterval,
          confirmPaidPlanChange: options.confirmPaidPlanChange,
        });
        return result as OrganizationPlanChangeResult;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to change plan";
        setError(message);
        throw err;
      } finally {
        setIsStartingPlanChange(false);
        setPendingPlanChangeTarget(null);
      }
    },
    [organizationId, startPlanChangeAction],
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

  const openIntervalChangePortal = useCallback(
    async (returnUrl: string, targetBillingInterval: BillingInterval) => {
      if (!organizationId) throw new Error("Organization is required");
      setIsOpeningPortal(true);
      setError(null);
      try {
        const result = await createIntervalChangePortal({
          organizationId,
          returnUrl,
          targetBillingInterval,
        });
        return result.portalUrl as string;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to open billing interval change";
        setError(message);
        throw err;
      } finally {
        setIsOpeningPortal(false);
      }
    },
    [createIntervalChangePortal, organizationId],
  );

  const openCancellationPortal = useCallback(
    async (returnUrl: string) => {
      if (!organizationId) throw new Error("Organization is required");
      setIsOpeningPortal(true);
      setError(null);
      try {
        const result = await createCancellationPortal({
          organizationId,
          returnUrl,
        });
        return result.portalUrl as string;
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to open cancellation flow";
        setError(message);
        throw err;
      } finally {
        setIsOpeningPortal(false);
      }
    },
    [createCancellationPortal, organizationId],
  );

  const cancelScheduledBillingChange = useCallback(async () => {
    if (!organizationId) throw new Error("Organization is required");
    setIsCancelingScheduledBillingChange(true);
    setError(null);
    try {
      const result = await cancelScheduledBillingChangeAction({
        organizationId,
      });
      return result.subscription as OrganizationPlanChangeSnapshot;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to cancel scheduled billing change";
      setError(message);
      throw err;
    } finally {
      setIsCancelingScheduledBillingChange(false);
    }
  }, [cancelScheduledBillingChangeAction, organizationId]);

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
    shouldQueryOrganization && organizationPremiumness === undefined;
  const isLoadingWorkspacePremiumness =
    shouldQueryWorkspace && workspacePremiumness === undefined;

  return {
    billingStatus,
    organizationPremiumness,
    workspacePremiumness,
    entitlements,
    planCatalog,
    isLoadingBilling: shouldQueryOrganization && billingStatus === undefined,
    isLoadingEntitlements: shouldQueryOrganization && entitlements === undefined,
    isLoadingOrganizationPremiumness,
    isLoadingWorkspacePremiumness,
    isLoadingPlanCatalog: shouldQueryOrganization && planCatalog === undefined,
    isStartingPlanChange,
    pendingPlanChangeTarget,
    isOpeningPortal,
    isCancelingScheduledBillingChange,
    isSelectingFreeAfterTrial,
    error,
    startPlanChange,
    openPortal,
    openCancellationPortal,
    openIntervalChangePortal,
    cancelScheduledBillingChange,
    selectFreeAfterTrial,
  };
}
