import { ConvexError } from "convex/values";
import type {
  BillingFeatureName,
  BillingRolloutState,
  OrganizationEntitlements,
  OrganizationPlan,
} from "@/hooks/useOrganizationBilling";

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

export function isBillingGracePeriodActive(
  rolloutState: BillingRolloutState | null | undefined,
): boolean {
  return (
    !!rolloutState?.enforcementConfigured && !rolloutState.enforcementActive
  );
}

export function isBillingFeatureLocked(params: {
  billingUiEnabled: boolean;
  entitlements: OrganizationEntitlements | null | undefined;
  rolloutState: BillingRolloutState | null | undefined;
  feature: BillingFeatureName | null;
}): boolean {
  const { billingUiEnabled, entitlements, rolloutState, feature } = params;
  if (!billingUiEnabled || !feature || !rolloutState?.enforcementActive) {
    return false;
  }
  if (!entitlements) {
    return false;
  }
  return entitlements.features[feature] === false;
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

export function formatGracePeriodEndsAt(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

type BillingErrorPayload = {
  code?: string;
  message?: string;
  feature?: BillingFeatureName;
  plan?: OrganizationPlan;
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

export function getBillingErrorMessage(
  error: unknown,
  fallback: string,
  canManageBilling = true,
): string {
  const payload = extractBillingErrorPayload(error);
  if (!payload) {
    return error instanceof Error ? error.message : fallback;
  }

  if (payload.code === "billing_feature_not_included" && payload.feature) {
    const featureName = formatBillingFeatureName(payload.feature);
    const planName = formatPlanName(payload.plan);
    return canManageBilling
      ? `${featureName} is not included in the ${planName} plan. Upgrade the organization to continue.`
      : `${featureName} is not included in the ${planName} plan. Ask an organization owner to upgrade.`;
  }

  if (payload.code === "billing_limit_reached") {
    const limitName = payload.limitName ?? payload.limit;
    const allowedValue =
      typeof payload.allowedValue === "number"
        ? payload.allowedValue
        : typeof payload.current === "number"
          ? payload.current
          : null;

    if (
      limitName === "maxEvalRunsPerMonth" &&
      typeof allowedValue === "number"
    ) {
      return `This organization has reached its monthly eval run limit (${allowedValue}). Upgrade to continue.`;
    }
    if (
      limitName === "maxSandboxesPerWorkspace" &&
      typeof allowedValue === "number"
    ) {
      return `This workspace has reached its sandbox limit (${allowedValue}). Upgrade to continue.`;
    }
  }

  if (payload.code === "billing_organization_context_required") {
    return (
      payload.message ??
      "This resource must be linked to an organization before billing enforcement can apply."
    );
  }

  return payload.message ?? fallback;
}
