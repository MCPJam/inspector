import {
  COMPARE_PLAN_MARKETING_SECTIONS,
  type ComparePlanSection,
} from "@/components/organization/compare-plan-marketing";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

function formatEvalLimit(
  value: number | null,
  cadence: "day" | "mo",
  emphasize = false
) {
  return {
    kind: "text" as const,
    text:
      value == null
        ? "Unlimited"
        : `${new Intl.NumberFormat("en-US").format(value)} / ${cadence}`,
    ...(emphasize ? { emphasize: true } : {}),
  };
}

export function buildComparePlanSectionsFromCatalog(
  planCatalog: PlanCatalog
): ComparePlanSection[] {
  return COMPARE_PLAN_MARKETING_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.map((row) =>
      row.label === "Eval iterations"
        ? {
            ...row,
            free: formatEvalLimit(
              planCatalog.plans.free.limits.maxEvalIterationsPerMonth,
              "day"
            ),
            team: formatEvalLimit(
              planCatalog.plans.team.limits.maxEvalIterationsPerMonth,
              "mo",
              true
            ),
          }
        : row
    ),
  }));
}
