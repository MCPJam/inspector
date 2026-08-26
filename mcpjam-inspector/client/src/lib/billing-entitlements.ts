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
  _plan: OrganizationPlan,
  interval: BillingInterval,
  catalogEntry: PlanCatalogEntry
): number | null {
  return catalogEntry.prices[interval];
}

export function getAnnualDiscountPercent(
  planCatalog: PlanCatalog | undefined
): number {
  if (!planCatalog) {
    return 0;
  }
  const monthly = planCatalog.plans.team.prices.monthly;
  const annual = planCatalog.plans.team.prices.annual;
  if (monthly == null || annual == null || monthly <= 0) {
    return 0;
  }
  return Math.round(((monthly * 12 - annual) / (monthly * 12)) * 100);
}

export const BILLING_FEATURE_BY_TAB = {
  // Both Evaluate lenses (Suites and Runs) gate on `evals`: they are one tab
  // now, and this map is keyed by tab id. `cicd` still exists as a backend
  // feature — server-side ingest enforces it — it just no longer gates a
  // client route.
  evals: "evals",
  // Evaluate (New) is the same product behind a flag, so it gates on the same
  // feature — a preview must not be a way around the paywall.
  evaluate: "evals",
  scenarios: "scenarios",
  // The agent Swarm surface shares the human Scenario's billing feature.
  swarms: "scenarios",
} as const satisfies Record<string, BillingFeatureName>;

export function getRequiredBillingFeatureForTab(
  tab: string
): BillingFeatureName | null {
  return (
    BILLING_FEATURE_BY_TAB[tab as keyof typeof BILLING_FEATURE_BY_TAB] ?? null
  );
}

/** Maps inspector tabs to premiumness gate keys (feature gates only). */
export function getPremiumnessGateForTab(
  tab: string
): PremiumnessGateKey | null {
  const feature = getRequiredBillingFeatureForTab(tab);
  if (!feature) return null;
  return feature as PremiumnessGateKey;
}

export function isBillingEnforcementActive(
  premiumness: PremiumnessState | undefined
): boolean {
  return !!premiumness && premiumness.enforcementState !== "disabled";
}

export function isGateAccessDenied(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey
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
 * When a project exists, project premiumness governs shell tabs; otherwise
 * organization premiumness applies.
 */
export function isPremiumnessGateDeniedForShell(params: {
  billingUiEnabled: boolean;
  projectPremiumness: PremiumnessState | undefined;
  organizationPremiumness: PremiumnessState | undefined;
  hasProject: boolean;
  gateKey: PremiumnessGateKey | null;
}): boolean {
  const {
    billingUiEnabled,
    projectPremiumness,
    organizationPremiumness,
    hasProject,
    gateKey,
  } = params;
  if (!billingUiEnabled || !gateKey) {
    return false;
  }
  const premiumness =
    hasProject && projectPremiumness
      ? projectPremiumness
      : organizationPremiumness;
  return isGateAccessDenied(premiumness, gateKey);
}

export function getUpgradePlanForDeniedGate(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey | null
): OrganizationPlan | null {
  const decision = gateKey ? getGateDecision(premiumness, gateKey) : null;
  if (!decision || decision.canAccess !== false) {
    return null;
  }
  return decision.upgradePlan ?? null;
}

export function getGateDecision(
  premiumness: PremiumnessState | undefined,
  gateKey: PremiumnessGateKey
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
    case "scenarios":
      return "Swarms";
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
    case "scenarios":
    case "cicd":
    case "auditLog":
      return formatBillingFeatureName(gateKey as BillingFeatureName);
    case "maxMembers":
      return "Members";
    case "maxProjects":
      return "Projects";
    case "maxServersPerProject":
      return "Servers per project";
    case "maxScenariosPerProject":
      return "Swarms per project";
    case "maxEvalRunsPerMonth":
      return "Eval runs per month";
    case "maxEvalIterationsPerMonth":
      return "Eval iterations per month";
    case "insightsPerDay":
      return "Insights per day";
    case "journeyRunsPerDay":
      return "Journey launches per day";
    default:
      return gateKey;
  }
}

export function formatPlanName(
  plan: OrganizationPlan | null | undefined
): string {
  switch (plan) {
    case "free":
      return "Free";
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
  resetsAt?: number | null;
  windowKind?: "day" | "month";
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
  error: unknown
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

/**
 * "Resets Aug 16, 12:00 AM" — the same sentence every daily cap needs.
 *
 * Extracted because four limits now want it and each inline copy was a chance
 * to format the date slightly differently. The instant comes from the
 * backend's `resetsAt` (epoch ms of the UTC day roll) and is rendered in the
 * VIEWER's locale and zone: the cap is a UTC boundary, but "when can I try
 * again" is a question about the reader's clock.
 */
function resetsSentence(resetsAt: number): string | null {
  // `Number.isFinite` is not enough. `Number.MAX_VALUE` is finite and outside
  // the range `Date` can represent, so `new Date(it)` is an Invalid Date and
  // `Intl.DateTimeFormat.format` THROWS on it — turning a malformed field in
  // an error payload into a second, worse error while the caller was already
  // trying to explain the first one.
  if (!Number.isFinite(resetsAt)) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const resetTime = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `Resets ${resetTime}.`;
}

/**
 * `resetsSentence` for a value that may be absent or malformed.
 *
 * The four daily/monthly caps all had to answer the same question — "is this
 * `resetsAt` worth rendering?" — and each answered it with its own inline
 * guard. One of them used a weaker guard than the others, which is exactly the
 * kind of divergence a shared helper exists to prevent.
 */
function resolveResetsSentence(
  resetsAt: number | null | undefined
): string | null {
  return typeof resetsAt === "number" ? resetsSentence(resetsAt) : null;
}

export function formatBillingLimitReachedMessage(
  limitName: BillingLimitName | string | undefined,
  allowedValue: number | null | undefined,
  canManageBilling = true,
  options?: {
    resetsAt?: number | null;
    windowKind?: "day" | "month";
  }
): string | null {
  if (typeof allowedValue !== "number") {
    return null;
  }

  if (limitName === "maxEvalRunsPerMonth") {
    return canManageBilling
      ? `This organization has reached its monthly eval run limit (${allowedValue}). Upgrade to continue.`
      : `This organization has reached its monthly eval run limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxEvalIterationsPerMonth") {
    const resets = resolveResetsSentence(options?.resetsAt);
    if (resets) {
      return `This organization has reached its eval iteration limit (${allowedValue}). ${resets}`;
    }
    return canManageBilling
      ? `This organization has reached its eval iteration limit (${allowedValue}). Upgrade to continue.`
      : `This organization has reached its eval iteration limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxScenariosPerProject") {
    return canManageBilling
      ? `This project has reached its swarm limit (${allowedValue}). Upgrade to continue.`
      : `This project has reached its swarm limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "insightsPerDay") {
    const resets = resolveResetsSentence(options?.resetsAt);
    if (resets) {
      return `This organization has reached its daily insights limit (${allowedValue}). ${resets}`;
    }
    return canManageBilling
      ? `This organization has reached its daily insights limit (${allowedValue}). Upgrade to continue.`
      : `This organization has reached its daily insights limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "journeyRunsPerDay") {
    // A DAILY cap, so "Upgrade to continue" is the wrong lead: the limit lifts
    // by itself at the UTC roll, and sending someone to a pricing page for a
    // wait would be the same mistake as reporting a 429 as a 402. The upgrade
    // line stays as the fallback for a payload that carried no reset.
    const resets = resolveResetsSentence(options?.resetsAt);
    if (resets) {
      return `This organization has reached its daily journey launch limit (${allowedValue}). ${resets}`;
    }
    return canManageBilling
      ? `This organization has reached its daily journey launch limit (${allowedValue}). Upgrade to launch more.`
      : `This organization has reached its daily journey launch limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxMembers") {
    return canManageBilling
      ? `This organization has reached its member limit (${allowedValue}). Upgrade to add more members.`
      : `This organization has reached its member limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "maxProjects") {
    return canManageBilling
      ? `This organization has reached its project limit (${allowedValue}). Upgrade to create more projects.`
      : `This organization has reached its project limit (${allowedValue}). Ask an organization owner to upgrade.`;
  }
  if (limitName === "computerStartsPerDay") {
    const resets = resolveResetsSentence(options?.resetsAt);
    if (resets) {
      return `Daily computer limit reached (${allowedValue}). ${resets}`;
    }
    return `Daily computer limit reached (${allowedValue}).`;
  }

  return null;
}

/**
 * The guest daily computer-start cap (`computerStartsPerDay`). Detected
 * separately so the computer surface can route it to the MCPJam limit dialog
 * (sign-in CTA for guests) instead of a plain toast.
 */
export function isComputerStartLimitError(error: unknown): boolean {
  const payload = extractBillingErrorPayload(error);
  if (!payload || payload.code !== "billing_limit_reached") {
    return false;
  }
  return (payload.limitName ?? payload.limit) === "computerStartsPerDay";
}

export interface EvalIterationLimitError {
  allowed: number | null;
  used: number;
  resetsAt: number | null;
  windowKind: "day" | "month";
}

/**
 * The server is the authority on the eval-iteration cap. The client's quota
 * query can be stale — a teammate spending the last iterations while this user
 * sits on the Run button — so a run can clear the pre-check and still be
 * rejected. Detected here so that rejection can reach the same upgrade wall as
 * the pre-check instead of the dead-end toast the wall replaced.
 */
export function getEvalIterationLimitFromError(
  error: unknown
): EvalIterationLimitError | null {
  const payload = extractBillingErrorPayload(error);
  if (!payload || payload.code !== "billing_limit_reached") {
    return null;
  }
  if ((payload.limitName ?? payload.limit) !== "maxEvalIterationsPerMonth") {
    return null;
  }

  const allowed =
    typeof payload.allowedValue === "number" ? payload.allowedValue : null;
  const used =
    typeof payload.currentValue === "number"
      ? payload.currentValue
      : typeof payload.current === "number"
      ? payload.current
      : allowed ?? 0;

  return {
    allowed,
    used,
    resetsAt: typeof payload.resetsAt === "number" ? payload.resetsAt : null,
    // One limit NAME, two windows: the backend enforces `maxEvalIterationsPerMonth`
    // as a DAILY cap on Free and a MONTHLY per-seat allowance on Team, and says
    // which through `windowKind`. The wall renders that word literally ("out of
    // eval iterations today" vs "this month"), so a payload that omits the field
    // must not be answered with a constant: hardcoding "month" would tell a Free
    // user a cap that lifts at the next UTC roll is a month-long block — a wait
    // sold as an upgrade — and hardcoding "day" mislabels the Team allowance.
    // The plan is the field the window is derived FROM, so fall back to it; it
    // also survives payload paths that drop `windowKind` (the v1 route's
    // `billingDetails` allowlist keeps `plan` and not `windowKind`). Unknown plan
    // stays "day", the narrower claim: it never overstates how long the block lasts.
    windowKind:
      payload.windowKind === "month" || payload.windowKind === "day"
        ? payload.windowKind
        : payload.plan === "team" || payload.plan === "enterprise"
        ? "month"
        : "day",
  };
}

export function getBillingErrorMessage(
  error: unknown,
  fallback: string,
  canManageBilling = true
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
      {
        resetsAt: payload.resetsAt,
        windowKind: payload.windowKind,
      }
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
