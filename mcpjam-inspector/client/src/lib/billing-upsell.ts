import type { OrganizationPlan, PlanCatalog } from "@/hooks/useOrganizationBilling";
import { formatPlanName } from "@/lib/billing-entitlements";

type BillingUpsellIntent = "members" | "sandboxes";

function formatCurrencyAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatLimitLabel(
  value: number | null | undefined,
  singular: string,
  plural: string,
): string {
  if (value == null) {
    return `unlimited ${plural}`;
  }

  return `${value} ${value === 1 ? singular : plural}`;
}

function formatSandboxesPerWorkspaceLabel(
  value: number | null | undefined,
): string {
  if (value == null) {
    return "unlimited sandboxes per workspace";
  }

  return `${value} ${value === 1 ? "sandbox" : "sandboxes"} per workspace`;
}

function formatPlanTeaserPrice(
  planCatalog: PlanCatalog,
  plan: OrganizationPlan,
): string | null {
  const entry = planCatalog.plans[plan];
  const monthlyPriceCents = entry?.prices.monthly;

  if (!entry || monthlyPriceCents == null) {
    return null;
  }

  if (entry.billingModel === "flat") {
    return `${formatCurrencyAmount(monthlyPriceCents / 100, planCatalog.currency)}/mo flat`;
  }

  if (entry.billingModel === "per_seat") {
    const seatMinimum = entry.seatMinimum ?? 1;
    const minimumMonthlyCents = monthlyPriceCents * seatMinimum;
    return `from ${formatCurrencyAmount(
      minimumMonthlyCents / 100,
      planCatalog.currency,
    )}/mo${seatMinimum > 1 ? ` (${seatMinimum}-seat minimum)` : ""}`;
  }

  return null;
}

export function getBillingUpsellTeaser(params: {
  planCatalog: PlanCatalog | undefined;
  upgradePlan: OrganizationPlan | null;
  intent: BillingUpsellIntent;
}): string | null {
  const { planCatalog, upgradePlan, intent } = params;
  if (!planCatalog || !upgradePlan) {
    return null;
  }

  const entry = planCatalog.plans[upgradePlan];
  if (!entry) {
    return null;
  }

  const baseCopy =
    intent === "members"
      ? `${formatPlanName(upgradePlan)} includes up to ${formatLimitLabel(
          entry.limits.maxMembers,
          "member",
          "members",
        )} and ${formatLimitLabel(
          entry.limits.maxWorkspaces,
          "workspace",
          "workspaces",
        )}`
      : `${formatPlanName(upgradePlan)} includes ${formatSandboxesPerWorkspaceLabel(
          entry.limits.maxSandboxesPerWorkspace,
        )} and ${formatLimitLabel(
          entry.limits.maxMembers,
          "member",
          "members",
        )}`;

  const teaserPrice = formatPlanTeaserPrice(planCatalog, upgradePlan);
  if (!teaserPrice) {
    return `${baseCopy}.`;
  }

  return entry.billingModel === "flat"
    ? `${baseCopy} for ${teaserPrice}.`
    : `${baseCopy}, ${teaserPrice}.`;
}

export function getBillingUpsellCtaLabel(
  upgradePlan: OrganizationPlan | null,
): string {
  return upgradePlan
    ? `Upgrade to ${formatPlanName(upgradePlan)}`
    : "View billing options";
}
