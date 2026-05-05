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
  const value = entry.limits.maxMembers;
  if (value == null) {
    return t("Unlimited", plan === "pro");
  }
  return t(`${value}`, plan === "pro");
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
    return t("Custom", plan === "pro");
  }
  if (plan === "free") {
    return t(`${value.toLocaleString()} / mo`);
  }
  return t(`${value.toLocaleString()} included`, plan === "pro");
}

function formatDeployments(
  plan: OrganizationPlan,
  entry: PlanCatalogEntry,
): ComparePlanCell {
  if (plan === "enterprise") {
    return t("Custom", true);
  }
  const value = entry.limits.maxChatboxesPerProject;
  if (value == null) {
    return t("Unlimited", plan === "pro");
  }
  if (value <= 0) {
    return x;
  }
  return t(value.toLocaleString(), plan === "pro");
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
            pro: formatSeatLimit("pro", getEntry(planCatalog, "pro")),
            enterprise: formatSeatLimit(
              "enterprise",
              getEntry(planCatalog, "enterprise"),
            ),
          };
        case "Projects":
          return {
            ...row,
            free: formatLimitValue(
              getEntry(planCatalog, "free").limits.maxProjects,
            ),
            pro: formatLimitValue(
              getEntry(planCatalog, "pro").limits.maxProjects,
              true,
            ),
            enterprise: t("Custom", true),
          };
        case "Servers per project":
          return {
            ...row,
            free: formatLimitValue(
              getEntry(planCatalog, "free").limits.maxServersPerProject,
            ),
            pro: formatLimitValue(
              getEntry(planCatalog, "pro").limits.maxServersPerProject,
              true,
            ),
            enterprise: t("Unlimited", true),
          };
        case "Evals CI/CD runs":
          return {
            ...row,
            free: formatEvalRuns("free", getEntry(planCatalog, "free")),
            pro: formatEvalRuns("pro", getEntry(planCatalog, "pro")),
            enterprise: t("Custom", true),
          };
        case "Deployments":
          return {
            ...row,
            free: formatDeployments("free", getEntry(planCatalog, "free")),
            pro: formatDeployments("pro", getEntry(planCatalog, "pro")),
            enterprise: t("Custom", true),
          };
        default:
          return row;
      }
    }),
  }));
}
