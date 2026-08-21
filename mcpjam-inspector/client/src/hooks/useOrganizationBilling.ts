import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useRef, useState } from "react";
import { confirmSeatPaymentWithStripe } from "@/lib/seat-payment-stripe";

export type OrganizationPlan = "free" | "team" | "enterprise";
export type BillingInterval = "monthly" | "annual";
export type BillingModel = "free" | "flat" | "per_seat" | "contact";
export type BillingFeatureName =
  | "evals"
  | "scenarios"
  | "cicd"
  | "customDomains"
  | "auditLog"
  | "sso"
  | "prioritySupport";
export type BillingLimitName =
  | "maxMembers"
  | "maxProjects"
  | "maxServersPerProject"
  | "maxScenariosPerProject"
  | "maxEvalRunsPerMonth"
  | "maxEvalIterationsPerMonth"
  | "insightsPerDay"
  // Journey runs launched per UTC day per organization. Hand-mirrored from the
  // backend's `LIMIT_NAMES`, which `buildBillingCatalog` serializes wholesale
  // onto the UNAUTHENTICATED billing catalog — so a new backend limit becomes
  // visible here whether or not this file knows about it. Adding it is what
  // gives it a name and a message instead of a silent generic failure.
  | "journeyRunsPerDay"
  | "computerStartsPerDay";

/** Mirrors backend premiumness gate keys exactly. */
export type PremiumnessGateKey =
  | "scenarios"
  | "evals"
  | "cicd"
  | "auditLog"
  | "maxMembers"
  | "maxProjects"
  | "maxServersPerProject"
  | "maxScenariosPerProject"
  | "maxEvalRunsPerMonth"
  | "maxEvalIterationsPerMonth"
  | "insightsPerDay"
  // Paired with the backend's gate of the same name. A gate key with no entry
  // here still ARRIVES — `GateDecision.gateKey` is whatever the backend sent —
  // and falls through `formatPremiumnessGateKey` to be rendered verbatim, so
  // the user reads "journeyRunsPerDay is not included in the Free plan".
  | "journeyRunsPerDay";

export type BillingEnforcementState =
  | "active"
  | "disabled"
  | "decision_required";

export interface GateDecision {
  gateKey: PremiumnessGateKey;
  kind: "feature" | "limit";
  scope: "organization" | "project";
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
  paymentState?: "ok" | "past_due";
  paymentGraceEndsAt?: number | null;
  trialStatus: string;
  trialPlan: OrganizationPlan | null;
  trialStartedAt: number | null;
  trialEndsAt: number | null;
  deferredTrialBillingStartsAt?: number | null;
  trialDaysRemaining: number | null;
  decisionRequired: boolean;
  trialDecision: string | null;
}

export interface OrganizationSeatPaymentIntent {
  _id: string;
  organizationId: string;
  userId: string;
  email: string;
  role: "guest" | "member";
  source: string;
  status: "pending" | "requires_action";
  targetSeatQuantity: number | null;
  stripeInvoiceId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SeatPaymentResult =
  | { status: "paid"; seatQuantity: number; stripeInvoiceId?: string }
  | { status: "failed"; stripeInvoiceId?: string; reason?: string }
  | { status: "noop"; reason: string };

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
    plan: "team";
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
  stripeScheduledPlan?: "team" | null;
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
  projectId?: string | null;
  enabled?: boolean;
  includeSeatPaymentIntent?: boolean;
}

export interface UseOrganizationBillingStatusOptions {
  enabled?: boolean;
}

export interface StartOrganizationPlanChangeOptions {
  confirmPaidPlanChange?: boolean;
}

/**
 * One org-scoped billing query. The backend returns null for a denied org
 * read, so the value folds to `undefined` (what consumers already render
 * nothing for) while `isLoading` reads the RAW result — deriving it from the
 * fold would leave a denied surface stuck on its skeleton forever.
 */
function useBillingQuery<T>(
  name: string,
  args: Record<string, unknown> | "skip"
): { value: T | undefined; isLoading: boolean } {
  const raw = useQuery(name as any, args as any) as T | null | undefined;
  return {
    value: raw ?? undefined,
    isLoading: args !== "skip" && raw === undefined,
  };
}

export function useOrganizationBillingStatus(
  organizationId: string | null,
  options?: UseOrganizationBillingStatusOptions
): OrganizationBillingStatus | undefined {
  const enabled = options?.enabled ?? true;

  return useBillingQuery<OrganizationBillingStatus>(
    "billing:getOrganizationBillingStatus",
    enabled && organizationId ? { organizationId } : "skip"
  ).value;
}

export function useOrganizationBilling(
  organizationId: string | null,
  options?: UseOrganizationBillingOptions
) {
  const projectId = options?.projectId ?? null;
  const enabled = options?.enabled ?? true;
  const shouldQueryOrganization = enabled && !!organizationId;
  const shouldQueryProject = shouldQueryOrganization && !!projectId;
  const shouldQuerySeatPaymentIntent =
    shouldQueryOrganization && options?.includeSeatPaymentIntent === true;

  const { value: billingStatus, isLoading: isLoadingBilling } =
    useBillingQuery<OrganizationBillingStatus>(
      "billing:getOrganizationBillingStatus",
      shouldQueryOrganization ? { organizationId } : "skip"
    );

  const { value: entitlements, isLoading: isLoadingEntitlements } =
    useBillingQuery<OrganizationEntitlements>(
      "billing:getOrganizationEntitlements",
      shouldQueryOrganization ? { organizationId } : "skip"
    );

  const {
    value: organizationPremiumness,
    isLoading: isLoadingOrganizationPremiumness,
  } = useBillingQuery<PremiumnessState>(
    "billing:getOrganizationPremiumness",
    shouldQueryOrganization ? { organizationId } : "skip"
  );

  const { value: projectPremiumness, isLoading: isLoadingProjectPremiumness } =
    useBillingQuery<PremiumnessState>(
      "billing:getProjectPremiumness",
      shouldQueryProject ? { organizationId, projectId } : "skip"
    );

  const { value: planCatalog, isLoading: isLoadingPlanCatalog } =
    useBillingQuery<PlanCatalog>(
      "billing:getPlanCatalog",
      shouldQueryOrganization ? { organizationId } : "skip"
    );

  // Not folded: null is already this query's "no active intent" answer, and a
  // denial lands on the same null to the same effect.
  const activeSeatPaymentIntent = useQuery(
    "billing:getActiveOrganizationSeatPaymentIntent" as any,
    shouldQuerySeatPaymentIntent ? ({ organizationId } as any) : "skip"
  ) as OrganizationSeatPaymentIntent | null | undefined;

  const startPlanChangeAction = useAction(
    "billing:startOrganizationPlanChange" as any
  );
  const createPortal = useAction(
    "billing:createOrganizationBillingPortalSession" as any
  );
  const createCancellationPortal = useAction(
    "billing:createOrganizationBillingPortalCancellationSession" as any
  );
  const createIntervalChangePortal = useAction(
    "billing:createOrganizationBillingPortalIntervalChangeSession" as any
  );
  const cancelScheduledBillingChangeAction = useAction(
    "billing:cancelOrganizationScheduledBillingChange" as any
  );
  const selectFreeAfterTrialMutation = useMutation(
    "billing:selectOrganizationFreePlanAfterTrial" as any
  );
  const startSeatPaymentAction = useAction("billing:startSeatPayment" as any);
  const completeSeatPaymentAction = useAction(
    "billing:completeSeatPayment" as any
  );
  const cancelSeatPaymentAction = useAction("billing:cancelSeatPayment" as any);

  const [isStartingPlanChange, setIsStartingPlanChange] = useState(false);
  const [pendingPlanChangeTarget, setPendingPlanChangeTarget] = useState<
    "team" | null
  >(null);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [
    isCancelingScheduledBillingChange,
    setIsCancelingScheduledBillingChange,
  ] = useState(false);
  const [isSelectingFreeAfterTrial, setIsSelectingFreeAfterTrial] =
    useState(false);
  const [isFinishingSeatPayment, setIsFinishingSeatPayment] = useState(false);
  const [isCompletingSeatPayment, setIsCompletingSeatPayment] = useState(false);
  const [isCancelingSeatPayment, setIsCancelingSeatPayment] = useState(false);
  const seatPaymentCancelVersionRef = useRef(0);
  const seatPaymentCompletionInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const startPlanChange = useCallback(
    async (
      returnUrl: string,
      tier: "team" = "team",
      billingInterval: BillingInterval = "monthly",
      options: StartOrganizationPlanChangeOptions = {}
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
    [organizationId, startPlanChangeAction]
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
    [createPortal, organizationId]
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
    [createIntervalChangePortal, organizationId]
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
    [createCancellationPortal, organizationId]
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

  const finishSeatPayment = useCallback(
    async (seatPaymentIntentId?: string): Promise<SeatPaymentResult> => {
      if (!organizationId) throw new Error("Organization is required");
      const activeSeatPaymentIntentId =
        seatPaymentIntentId ?? activeSeatPaymentIntent?._id;
      if (!activeSeatPaymentIntentId) {
        return { status: "noop", reason: "no_pending_seat_payment" };
      }

      setIsFinishingSeatPayment(true);
      setError(null);
      const cancelVersionAtStart = seatPaymentCancelVersionRef.current;
      try {
        const startResult = await startSeatPaymentAction({
          organizationId,
          seatPaymentIntentId: activeSeatPaymentIntentId,
        } as any);

        if (seatPaymentCancelVersionRef.current !== cancelVersionAtStart) {
          return { status: "noop", reason: "seat_payment_canceled" };
        }

        if (startResult.status === "requires_action") {
          if (!startResult.clientSecret) {
            throw new Error("Payment confirmation is unavailable");
          }

          try {
            await confirmSeatPaymentWithStripe({
              publishableKey: startResult.publishableKey,
              clientSecret: startResult.clientSecret,
            });
          } catch (confirmError) {
            try {
              await cancelSeatPaymentAction({
                organizationId,
                seatPaymentIntentId: activeSeatPaymentIntentId,
                stripeInvoiceId: startResult.stripeInvoiceId,
              } as any);
            } catch (cancelError) {
              console.warn(
                "[billing] Failed to cancel incomplete seat payment",
                cancelError
              );
            }
            throw confirmError;
          }

          if (seatPaymentCancelVersionRef.current !== cancelVersionAtStart) {
            return { status: "noop", reason: "seat_payment_canceled" };
          }

          seatPaymentCompletionInFlightRef.current = true;
          setIsCompletingSeatPayment(true);
          try {
            const completeResult = (await completeSeatPaymentAction({
              seatPaymentIntentId: activeSeatPaymentIntentId,
              stripeInvoiceId: startResult.stripeInvoiceId,
            } as any)) as SeatPaymentResult;
            if (seatPaymentCancelVersionRef.current !== cancelVersionAtStart) {
              return { status: "noop", reason: "seat_payment_canceled" };
            }
            if (completeResult.status !== "paid") {
              throw new Error("Payment was not completed");
            }
            return completeResult;
          } finally {
            seatPaymentCompletionInFlightRef.current = false;
            setIsCompletingSeatPayment(false);
          }
        }

        if (startResult.status === "failed") {
          if (startResult.reason === "missing_payment_method") {
            throw new Error(
              "Stripe has no default payment method for this subscription. Add or select a card in Billing, then click Finish payment again."
            );
          }
          throw new Error("Payment failed. The member was not added.");
        }

        return startResult as SeatPaymentResult;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to finish seat payment";
        setError(message);
        throw err;
      } finally {
        setIsFinishingSeatPayment(false);
      }
    },
    [
      activeSeatPaymentIntent?._id,
      cancelSeatPaymentAction,
      completeSeatPaymentAction,
      organizationId,
      startSeatPaymentAction,
    ]
  );

  const cancelSeatPayment = useCallback(
    async (seatPaymentIntentId?: string): Promise<void> => {
      if (!organizationId) throw new Error("Organization is required");
      const activeSeatPaymentIntentId =
        seatPaymentIntentId ?? activeSeatPaymentIntent?._id;
      if (!activeSeatPaymentIntentId) {
        return;
      }
      if (seatPaymentCompletionInFlightRef.current) {
        return;
      }

      setIsCancelingSeatPayment(true);
      seatPaymentCancelVersionRef.current += 1;
      setError(null);
      try {
        await cancelSeatPaymentAction({
          organizationId,
          seatPaymentIntentId: activeSeatPaymentIntentId,
          stripeInvoiceId:
            activeSeatPaymentIntent?.stripeInvoiceId ?? undefined,
        } as any);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to cancel seat payment";
        setError(message);
        throw err;
      } finally {
        setIsCancelingSeatPayment(false);
      }
    },
    [
      activeSeatPaymentIntent?._id,
      activeSeatPaymentIntent?.stripeInvoiceId,
      cancelSeatPaymentAction,
      organizationId,
    ]
  );

  return {
    billingStatus,
    organizationPremiumness,
    projectPremiumness,
    entitlements,
    activeSeatPaymentIntent,
    planCatalog,
    isLoadingBilling,
    isLoadingEntitlements,
    isLoadingOrganizationPremiumness,
    isLoadingProjectPremiumness,
    isLoadingPlanCatalog,
    isStartingPlanChange,
    pendingPlanChangeTarget,
    isOpeningPortal,
    isCancelingScheduledBillingChange,
    isSelectingFreeAfterTrial,
    isFinishingSeatPayment,
    isCompletingSeatPayment,
    isCancelingSeatPayment,
    isHandlingSeatPayment:
      isFinishingSeatPayment ||
      isCompletingSeatPayment ||
      isCancelingSeatPayment,
    error,
    startPlanChange,
    openPortal,
    openCancellationPortal,
    openIntervalChangePortal,
    cancelScheduledBillingChange,
    selectFreeAfterTrial,
    finishSeatPayment,
    cancelSeatPayment,
  };
}
