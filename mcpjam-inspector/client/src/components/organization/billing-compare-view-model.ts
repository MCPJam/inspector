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
            team: formatSeatLimit("team", getEntry(planCatalog, "team")),
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
            team: formatLimitValue(
              getEntry(planCatalog, "team").limits.maxProjects,
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
            team: formatLimitValue(
              getEntry(planCatalog, "team").limits.maxServersPerProject,
              true,
            ),
            enterprise: t("Unlimited", true),
          };
        default:
          return row;
      }
    }),
  }));
}
