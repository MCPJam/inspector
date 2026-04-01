import { ConvexError } from "convex/values";
import type {
  BillingFeatureName,
  BillingInterval,
  BillingLimitName,
  GateDecision,
  OrganizationPlan,
  PlanCatalog,
  PlanCatalogEntry,
  PremiumnessGateKey,
  PremiumnessState,
} from "@/hooks/useOrganizationBilling";
export function getDisplayPriceCentsForPlan(
  plan: OrganizationPlan,
  interval: BillingInterval,
  catalogEntry: PlanCatalogEntry,
): number | null {
  return catalogEntry.prices[interval];
}

export function getAnnualDiscountPercent(
  planCatalog: PlanCatalog | undefined,
): number {
  if (!planCatalog) {
    return 0;
  }
  const monthly = planCatalog.plans.starter.prices.monthly;
  const annual = planCatalog.plans.starter.prices.annual;
  if (monthly == null || annual == null || monthly <= 0) {
    return 0;
  }
  return Math.round((((monthly * 12) - annual) / (monthly * 12)) * 100);
}

export const BILLING_FEATURE_BY_TAB = {
  evals: "evals",
  "ci-evals": "cicd",
  sandboxes: "sandboxes",
} as const satisfies Record<string, BillingFeatureName>;

export function getRequiredBillingFeatureForTab(
  tab: string,
): BillingFeatureName | null {
  return (
    BILLING_FEATURE_BY_TAB[tab as keyof typeof BILLING_FEATURE_BY_TAB] ?? null
  );
}

/** Maps inspector tabs to premiumness gate keys (feature gates only). */
export function getPremiumnessGateForTab(
  tab: string,
): PremiumnessGateKey | null {
  const feature = getRequiredBillingFeatureForTab(tab);
  if (!feature) return null;
  return feature as PremiumnessGateKey;
}

export function isBillingEnforcementActive(
  premiumness: PremiumnessState | undefined,
): boolean {
  return !!premiumness && premiumness.enforcementState !== "disabled";
}

export function isGateAccessDenied(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey,
): boolean {
  const decision = getGateDecision(premiumness, gateKey);
  if (!decision) {
    return false;
  }
  if (!isBillingEnforcementActive(premiumness)) {
    return false;
  }
  return decision.canAccess === false;
}

/**
 * When a workspace exists, workspace premiumness governs shell tabs; otherwise
 * organization premiumness applies.
 */
export function isPremiumnessGateDeniedForShell(params: {
  billingUiEnabled: boolean;
  workspacePremiumness: PremiumnessState | undefined;
  organizationPremiumness: PremiumnessState | undefined;
  hasWorkspace: boolean;
  gateKey: PremiumnessGateKey | null;
}): boolean {
  const {
    billingUiEnabled,
    workspacePremiumness,
    organizationPremiumness,
    hasWorkspace,
    gateKey,
  } = params;
  if (!billingUiEnabled || !gateKey) {
    return false;
  }
  const premiumness =
    hasWorkspace && workspacePremiumness
      ? workspacePremiumness
      : organizationPremiumness;
  return isGateAccessDenied(premiumness, gateKey);
}

export function getUpgradePlanForDeniedGate(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey | null,
): OrganizationPlan | null {
  const decision = gateKey ? getGateDecision(premiumness, gateKey) : null;
  if (!decision || decision.canAccess !== false) {
    return null;
  }
  return decision.upgradePlan ?? null;
}

export function getGateDecision(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey,
): GateDecision | null {
  if (!premiumness) {
    return null;
  }
  return (
    premiumness.gates.find((decision) => decision.gateKey === gateKey) ?? null
  );
}

export function formatBillingFeatureName(feature: BillingFeatureName): string {
  switch (feature) {
    case "evals":
      return "Generate Evals";
    case "cicd":
      return "Evals CI/CD";
    case "sandboxes":
      return "Sandboxes";
    case "auditLog":
      return "Audit Log";
    case "customDomains":
      return "Custom Domains";
    case "prioritySupport":
      return "Priority Support";
    case "sso":
      return "SSO";
    default:
      return feature;
  }
}

export function formatPremiumnessGateKey(gateKey: PremiumnessGateKey): string {
  switch (gateKey) {
    case "evals":
    case "sandboxes":
    case "cicd":
    case "auditLog":
      return formatBillingFeatureName(gateKey as BillingFeatureName);
    case "maxMembers":
      return "Members";
    case "maxWorkspaces":
      return "Workspaces";
    case "maxServersPerWorkspace":
      return "Servers per workspace";
    case "maxSandboxesPerWorkspace":
      return "Sandboxes per workspace";
    case "maxEvalRunsPerMonth":
      return "Eval runs per month";
    default:
      return gateKey;
  }
}

export function formatPlanName(
  plan: OrganizationPlan | null | undefined,
): string {
  switch (plan) {
    case "free":
      return "Free";
    case "starter":
      return "Starter";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    default:
      return "current";
  }
}

type BillingErrorPayload = {
  code?: string;
  message?: string;
  feature?: BillingFeatureName;
  gateKey?: PremiumnessGateKey;
  upgradePlan?: OrganizationPlan;
  enforcementState?: string;
  plan?: OrganizationPlan;
  canManageBilling?: boolean;
  limit?: string;
  limitName?: string;
  allowedValue?: number | null;
  currentValue?: number | null;
  current?: number | null;
};

function tryParseJsonPayload(value: string): BillingErrorPayload | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as BillingErrorPayload;
    }
  } catch {
    // ignore
  }

  const jsonMatch = value.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed && typeof parsed === "object") {
      return parsed as BillingErrorPayload;
    }
  } catch {
    return null;
  }

  return null;
}

function extractBillingErrorPayload(
  error: unknown,
): BillingErrorPayload | null {
  if (error instanceof ConvexError) {
    if (error.data && typeof error.data === "object") {
      return error.data as BillingErrorPayload;
    }
    if (typeof error.data === "string") {
      return tryParseJsonPayload(error.data) ?? { message: error.data };
    }
  }

  if (error instanceof Error) {
    return tryParseJsonPayload(error.message) ?? { message: error.message };
  }

  if (typeof error === "string") {
    return tryParseJsonPayload(error) ?? { message: error };
  }

  return null;
}

function resolveFeatureLabel(payload: BillingErrorPayload): string | null {
  if (payload.feature) {
    return formatBillingFeatureName(payload.feature);
  }
  if (payload.gateKey) {
    return formatPremiumnessGateKey(payload.gateKey);
  }
  return null;
}

export function formatBillingLimitReachedMessage(
  limitName: BillingLimitName | string | undefined,
  allowedValue: number | null | undefined,
  canManageBilling = true,
): string | null {
  if (typeof allowedValue !== "number") {
    return null;
  }

  if (limitName === "maxEvalRunsPerMonth") {
    return canManageBilling
      ? `This organization has reached its monthly eval run limit (${allowedValue}). Upgrade to continue.`
      : `This organization has reached its monthly eval run limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxSandboxesPerWorkspace") {
    return canManageBilling
      ? `This workspace has reached its sandbox limit (${allowedValue}). Upgrade to continue.`
      : `This workspace has reached its sandbox limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxMembers") {
    return canManageBilling
      ? `This organization has reached its member limit (${allowedValue}). Upgrade to add more members.`
      : `This organization has reached its member limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxWorkspaces") {
    return canManageBilling
      ? `This organization has reached its workspace limit (${allowedValue}). Upgrade to create more workspaces.`
      : `This organization has reached its workspace limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }

  return null;
}

export function getBillingErrorMessage(
  error: unknown,
  fallback: string,
  canManageBilling = true,
): string {
  const payload = extractBillingErrorPayload(error);
  if (!payload) {
    return error instanceof Error ? error.message : fallback;
  }

  if (payload.code === "billing_feature_not_included") {
    const featureName = resolveFeatureLabel(payload);
    const currentPlanName = formatPlanName(payload.plan);
    const upgradePlanName = payload.upgradePlan
      ? formatPlanName(payload.upgradePlan)
      : null;
    if (featureName) {
      return canManageBilling
        ? upgradePlanName
          ? `${featureName} is not included in the ${currentPlanName} plan. Upgrade to ${upgradePlanName} to continue.`
          : `${featureName} is not included in the ${currentPlanName} plan. Upgrade the organization to continue.`
        : upgradePlanName
          ? `${featureName} is not included in the ${currentPlanName} plan. Ask an organization owner to upgrade to ${upgradePlanName}.`
          : `${featureName} is not included in the ${currentPlanName} plan. Ask an organization owner to upgrade.`;
    }
  }

  if (payload.code === "billing_limit_reached") {
    const limitName = payload.limitName ?? payload.limit;
    const allowedValue =
      typeof payload.allowedValue === "number"
        ? payload.allowedValue
        : typeof payload.current === "number"
          ? payload.current
          : null;
    const canManage = payload.canManageBilling ?? canManageBilling;
    const message = formatBillingLimitReachedMessage(
      limitName,
      allowedValue,
      canManage,
    );
    if (message) {
      return message;
    }
  }

  if (payload.code === "billing_organization_context_required") {
    return (
      payload.message ??
      "This resource must be linked to an organization before billing enforcement can apply."
    );
  }

  if (payload.message) {
    return payload.message;
  }

  return error instanceof Error ? error.message : fallback;
}
