import {
  COMPARE_PLAN_MARKETING_SECTIONS,
  type ComparePlanSection,
} from "@/components/organization/compare-plan-marketing";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

/**
 * `cadence` is the whole suffix, not just the unit, because the two plans are
 * not the same shape of allowance: Free is an org-wide DAILY cap, Team is a
 * MONTHLY allowance enforced PER SEAT. Rendering the Team number as `N / mo`
 * dropped that qualifier, so a multi-seat org read its own entitlement as an
 * org-wide total — while the upgrade wall (`PlanLimitDialog`) sells the same
 * catalog number as "N per seat each month" and the credits row directly above
 * this one already renders `/ seat / mo`.
 */
function formatEvalLimit(
  value: number | null,
  cadence: "day" | "seat / mo",
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
              "seat / mo",
              true
            ),
          }
        : row
    ),
  }));
}
