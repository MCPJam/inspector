import { useConvexAuth } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import {
  useOrganizationBilling,
  type BillingFeatureName,
  type GateDecision,
  type OrganizationBillingStatus,
  type OrganizationPlan,
  type PremiumnessGateKey,
  type PremiumnessState,
} from "@/hooks/useOrganizationBilling";
import {
  formatBillingLimitReachedMessage,
  getGateDecision,
  getUpgradePlanForDeniedGate,
  isBillingEnforcementActive,
} from "@/lib/billing-entitlements";

export interface BillingGateDefinition {
  gateKey: PremiumnessGateKey;
  feature: BillingFeatureName | null;
}

export const BILLING_GATES = {
  chatboxes: {
    gateKey: "chatboxes",
    feature: "chatboxes",
  },
  chatboxCreation: {
    gateKey: "maxChatboxesPerWorkspace",
    feature: null,
  },
  memberInvites: {
    gateKey: "maxMembers",
    feature: null,
  },
  workspaceCreation: {
    gateKey: "maxWorkspaces",
    feature: null,
  },
  serverCreation: {
    gateKey: "maxServersPerWorkspace",
    feature: null,
  },
} as const satisfies Record<string, BillingGateDefinition>;

export interface ResolvedBillingGate {
  organizationId: string | null;
  gate: BillingGateDefinition;
  decision: GateDecision | null;
  currentPlan: OrganizationPlan;
  upgradePlan: OrganizationPlan | null;
  canManageBilling: boolean;
  isLoading: boolean;
  isDenied: boolean;
  denialMessage: string | null;
}

interface ResolveBillingGateStateParams {
  billingUiEnabled: boolean;
  organizationId: string | null;
  billingStatus?: OrganizationBillingStatus;
  premiumness?: PremiumnessState;
  gate: BillingGateDefinition;
  isLoading?: boolean;
}

export function resolveBillingGateState(
  params: ResolveBillingGateStateParams,
): ResolvedBillingGate {
  const {
    billingUiEnabled,
    organizationId,
    billingStatus,
    premiumness,
    gate,
    isLoading = false,
  } = params;
  const decision = getGateDecision(premiumness, gate.gateKey);
  const currentPlan =
    billingStatus?.effectivePlan ??
    billingStatus?.plan ??
    premiumness?.effectivePlan ??
    "free";
  const canManageBilling = billingStatus?.canManageBilling ?? false;
  const isDenied =
    billingUiEnabled &&
    isBillingEnforcementActive(premiumness) &&
    decision?.canAccess === false;
  const denialMessage =
    isDenied && decision?.kind === "limit"
      ? formatBillingLimitReachedMessage(
          gate.gateKey,
          decision.allowedValue ?? null,
          canManageBilling,
        )
      : null;

  return {
    organizationId,
    gate,
    decision,
    currentPlan,
    upgradePlan: getUpgradePlanForDeniedGate(premiumness, gate.gateKey),
    canManageBilling,
    isLoading,
    isDenied,
    denialMessage,
  };
}

interface UseWorkspaceBillingGateParams {
  workspaceId: string | null;
  organizationId: string | null;
  gate: BillingGateDefinition;
}

export function useWorkspaceBillingGate({
  workspaceId,
  organizationId,
  gate,
}: UseWorkspaceBillingGateParams): ResolvedBillingGate {
  const { isAuthenticated } = useConvexAuth();
  const billingUiFlag = useFeatureFlagEnabled("billing-entitlements-ui");
  const billingUiEnabled = billingUiFlag === true;
  const shouldResolve =
    isAuthenticated &&
    billingUiFlag !== false &&
    !!workspaceId &&
    !!organizationId;
  const resolvedOrganizationId = shouldResolve ? organizationId : null;
  const {
    billingStatus,
    organizationPremiumness,
    workspacePremiumness,
    isLoadingBilling,
    isLoadingOrganizationPremiumness,
    isLoadingWorkspacePremiumness,
  } = useOrganizationBilling(resolvedOrganizationId, {
    workspaceId: shouldResolve ? workspaceId : null,
  });
  const premiumness =
    shouldResolve && workspacePremiumness
      ? workspacePremiumness
      : organizationPremiumness;
  const isLoadingGate =
    shouldResolve &&
    (billingUiFlag === undefined ||
      isLoadingBilling ||
      isLoadingWorkspacePremiumness ||
      isLoadingOrganizationPremiumness);

  return resolveBillingGateState({
    billingUiEnabled,
    organizationId: resolvedOrganizationId,
    billingStatus,
    premiumness,
    gate,
    isLoading: isLoadingGate,
  });
}
