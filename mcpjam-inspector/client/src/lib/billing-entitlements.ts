import { ConvexError } from "convex/values";
import type {
  BillingFeatureName,
  BillingInterval,
  OrganizationPlan,
  PlanCatalogEntry,
  PremiumnessGateKey,
  PremiumnessState,
} from "@/hooks/useOrganizationBilling";

/**
 * Canonical USD cents for Starter/Team shown in-app (matches marketing pricing).
 * Starter is single-seat: monthly = monthly charge in cents; annual = full year billed in cents
 * (effective monthly shown as annual ÷ 12, e.g. $49/mo).
 * Team is per-seat: same shape; display uses effective monthly per seat for annual.
 */
export const MARKETING_PLAN_PRICE_CENTS_USD: Record<
  "starter" | "team",
  Record<BillingInterval, number>
> = {
  starter: {
    monthly: 6100,
    annual: 58800,
  },
  team: {
    monthly: 7400,
    annual: 70800,
  },
};

/** Use marketing prices for self-serve tiers so UI matches the website even if catalog drifts. */
export function getDisplayPriceCentsForPlan(
  plan: OrganizationPlan,
  interval: BillingInterval,
  catalogEntry: PlanCatalogEntry,
): number | null {
  if (plan === "starter" || plan === "team") {
    return MARKETING_PLAN_PRICE_CENTS_USD[plan][interval];
  }
  return catalogEntry.prices[interval];
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

export function isGateAccessDenied(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey,
): boolean {
  if (!premiumness) {
    return false;
  }
  if (premiumness.enforcementState === "disabled") {
    return false;
  }
  const decision = premiumness.gates[gateKey];
  if (!decision) {
    return false;
  }
  return decision.allowed === false;
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
  if (!premiumness || !gateKey) {
    return null;
  }
  const decision = premiumness.gates[gateKey];
  if (!decision || decision.allowed !== false) {
    return null;
  }
  return decision.upgradePlan ?? null;
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
    const planName = formatPlanName(payload.upgradePlan ?? payload.plan);
    if (featureName) {
      return canManageBilling
        ? `${featureName} is not included in the ${planName} plan. Upgrade the organization to continue.`
        : `${featureName} is not included in the ${planName} plan. Ask an organization owner to upgrade.`;
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

    if (
      limitName === "maxEvalRunsPerMonth" &&
      typeof allowedValue === "number"
    ) {
      return canManage
        ? `This organization has reached its monthly eval run limit (${allowedValue}). Upgrade to continue.`
        : `This organization has reached its monthly eval run limit (${allowedValue}). Ask an organization owner to upgrade.`;
    }
    if (
      limitName === "maxSandboxesPerWorkspace" &&
      typeof allowedValue === "number"
    ) {
      return canManage
        ? `This workspace has reached its sandbox limit (${allowedValue}). Upgrade to continue.`
        : `This workspace has reached its sandbox limit (${allowedValue}). Ask an organization owner to upgrade.`;
    }
    if (limitName === "maxMembers" && typeof allowedValue === "number") {
      return canManage
        ? `This organization has reached its member limit (${allowedValue}). Upgrade to add more members.`
        : `This organization has reached its member limit (${allowedValue}). Ask an organization owner to upgrade.`;
    }
    if (limitName === "maxWorkspaces" && typeof allowedValue === "number") {
      return canManage
        ? `This organization has reached its workspace limit (${allowedValue}). Upgrade to create more workspaces.`
        : `This organization has reached its workspace limit (${allowedValue}). Ask an organization owner to upgrade.`;
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
