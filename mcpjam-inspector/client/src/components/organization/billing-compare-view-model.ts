import {
  offeredPlans,
  formatIncludedCredits,
  isV2PlanCatalog,
} from "@/lib/pricing-catalog";
import { buildV2ComparePlanSections } from "./compare-plan-v2";
import type { ComparePlanRow, ComparePlanCell } from "./compare-plan-marketing";
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
  emphasize = false,
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
  planCatalog: PlanCatalog,
): ComparePlanSection[] {
  if (isV2PlanCatalog(planCatalog)) {
    return buildV2ComparePlanSections(planCatalog);
  }
  if (planCatalog.plans.free.catalogPlanId) {
    const plans = offeredPlans(planCatalog);
    const row = (
      label: string,
      value: (plan: (typeof plans)[number]) => ComparePlanCell,
    ): ComparePlanRow =>
      ({
        label,
        ...Object.fromEntries(plans.map((plan) => [plan, value(plan)])),
      }) as ComparePlanRow;
    const featureKeys = new Map<string, string>();
    for (const plan of plans)
      for (const feature of planCatalog.plans[plan]?.display?.features ?? [])
        featureKeys.set(feature.key, feature.label);
    return [
      {
        title: "Plan details",
        rows: [
          row("Included credits", (plan) => ({
            kind: "text",
            text: formatIncludedCredits(
              planCatalog.plans[plan]?.includedCredits,
            ),
          })),
          row("Seat limit", (plan) => ({
            kind: "text",
            text:
              planCatalog.plans[plan]?.limits.maxMembers == null
                ? "Unlimited"
                : String(planCatalog.plans[plan]?.limits.maxMembers),
          })),
          ...Array.from(featureKeys, ([key, label]) =>
            row(label, (plan) => {
              const feature = planCatalog.plans[plan]?.display?.features.find(
                (item) => item.key === key,
              );
              if (!feature) return { kind: "text", text: "—" };
              return feature.included
                ? feature.detail
                  ? { kind: "text", text: feature.detail }
                  : { kind: "check" }
                : { kind: "x" };
            }),
          ),
        ],
      },
    ];
  }
  return COMPARE_PLAN_MARKETING_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.map((row) =>
      row.label === "Eval iterations"
        ? {
            ...row,
            free: formatEvalLimit(
              planCatalog.plans.free.limits.maxEvalIterationsPerMonth,
              "day",
            ),
            team: formatEvalLimit(
              planCatalog.plans.team.limits.maxEvalIterationsPerMonth,
              "seat / mo",
              true,
            ),
          }
        : row,
    ),
  }));
}
