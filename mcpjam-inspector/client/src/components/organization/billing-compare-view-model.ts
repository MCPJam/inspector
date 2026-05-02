import {
  COMPARE_PLAN_MARKETING_SECTIONS,
  type ComparePlanCell,
  type ComparePlanSection,
} from "@/components/organization/compare-plan-marketing";
import type {
  OrganizationPlan,
  PlanCatalog,
  PlanCatalogEntry,
} from "@/hooks/useOrganizationBilling";

const x: ComparePlanCell = { kind: "x" };

function t(text: string, emphasize?: boolean): ComparePlanCell {
  return { kind: "text", text, emphasize };
}

function getEntry(
  planCatalog: PlanCatalog,
  plan: OrganizationPlan,
): PlanCatalogEntry {
  return planCatalog.plans[plan];
}

function formatSeatLimit(
  plan: OrganizationPlan,
  entry: PlanCatalogEntry,
): ComparePlanCell {
  if (plan === "enterprise") {
    return t("Custom", true);
  }
  if (plan === "free") {
    return t("1 (just you)");
  }
  const value =
    plan === "starter"
      ? (entry.includedSeats ?? entry.limits.maxMembers)
      : entry.limits.maxMembers;
  if (value == null) {
    return t("Unlimited", plan === "team");
  }
  return t(`${value}`, plan === "team");
}

function formatLimitValue(
  value: number | null,
  emphasize?: boolean,
): ComparePlanCell {
  if (value == null) {
    return t("Unlimited", emphasize);
  }
  return t(value.toLocaleString(), emphasize);
}

function formatEvalRuns(
  plan: OrganizationPlan,
  entry: PlanCatalogEntry,
): ComparePlanCell {
  if (plan === "enterprise") {
    return t("Custom", true);
  }
  const value = entry.limits.maxEvalRunsPerMonth;
  if (value == null) {
    return t("Custom", plan === "team");
  }
  if (plan === "free") {
    return t(`${value.toLocaleString()} / mo`);
  }
  return t(`${value.toLocaleString()} included`, plan === "team");
}

function formatDeployments(
  plan: OrganizationPlan,
  entry: PlanCatalogEntry,
): ComparePlanCell {
  if (plan === "enterprise") {
    return t("Custom", true);
  }
  const value = entry.limits.maxChatboxesPerWorkspace;
  if (value == null) {
    return t("Unlimited", plan === "team");
  }
  if (value <= 0) {
    return x;
  }
  return t(value.toLocaleString(), plan === "team");
}

export function buildComparePlanSectionsFromCatalog(
  planCatalog: PlanCatalog,
): ComparePlanSection[] {
  return COMPARE_PLAN_MARKETING_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.map((row) => {
      switch (row.label) {
        case "Seat limit":
          return {
            ...row,
            free: formatSeatLimit("free", getEntry(planCatalog, "free")),
            starter: formatSeatLimit(
              "starter",
              getEntry(planCatalog, "starter"),
            ),
            team: formatSeatLimit("team", getEntry(planCatalog, "team")),
            enterprise: formatSeatLimit(
              "enterprise",
              getEntry(planCatalog, "enterprise"),
            ),
          };
        case "Workspaces":
          return {
            ...row,
            free: formatLimitValue(
              getEntry(planCatalog, "free").limits.maxWorkspaces,
            ),
            starter: formatLimitValue(
              getEntry(planCatalog, "starter").limits.maxWorkspaces,
            ),
            team: formatLimitValue(
              getEntry(planCatalog, "team").limits.maxWorkspaces,
              true,
            ),
            enterprise: t("Custom", true),
          };
        case "Servers per workspace":
          return {
            ...row,
            free: formatLimitValue(
              getEntry(planCatalog, "free").limits.maxServersPerWorkspace,
            ),
            starter: formatLimitValue(
              getEntry(planCatalog, "starter").limits.maxServersPerWorkspace,
            ),
            team: formatLimitValue(
              getEntry(planCatalog, "team").limits.maxServersPerWorkspace,
              true,
            ),
            enterprise: t("Unlimited", true),
          };
        case "Evals CI/CD runs":
          return {
            ...row,
            free: formatEvalRuns("free", getEntry(planCatalog, "free")),
            starter: formatEvalRuns(
              "starter",
              getEntry(planCatalog, "starter"),
            ),
            team: formatEvalRuns("team", getEntry(planCatalog, "team")),
            enterprise: t("Custom", true),
          };
        case "Deployments":
          return {
            ...row,
            free: formatDeployments("free", getEntry(planCatalog, "free")),
            starter: formatDeployments(
              "starter",
              getEntry(planCatalog, "starter"),
            ),
            team: formatDeployments("team", getEntry(planCatalog, "team")),
            enterprise: t("Custom", true),
          };
        default:
          return row;
      }
    }),
  }));
}
