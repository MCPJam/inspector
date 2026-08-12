import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "@/components/organization/compare-plan-marketing";
import { buildComparePlanSectionsFromCatalog } from "@/components/organization/billing-compare-view-model";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

function createPlanCatalog(
  evalLimits: { free: number | null; team: number | null } = {
    free: 75,
    team: 15_000,
  }
): PlanCatalog {
  const baseEntry = {
    prices: {
      monthly: { amountCents: 0, stripePriceId: null },
      annual: { amountCents: 0, stripePriceId: null },
    },
    billingModel: "flat" as const,
    features: {},
  };

  return {
    currency: "USD",
    plans: {
      free: {
        ...baseEntry,
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxScenariosPerProject: null,
          maxEvalRunsPerMonth: null,
          maxEvalIterationsPerMonth: evalLimits.free,
          insightsPerDay: null,
        },
      },
      team: {
        ...baseEntry,
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxScenariosPerProject: null,
          maxEvalRunsPerMonth: null,
          maxEvalIterationsPerMonth: evalLimits.team,
          insightsPerDay: null,
        },
      },
      enterprise: {
        ...baseEntry,
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxScenariosPerProject: null,
          maxEvalRunsPerMonth: null,
          maxEvalIterationsPerMonth: null,
          insightsPerDay: null,
        },
      },
    },
  };
}

describe("buildComparePlanSectionsFromCatalog", () => {
  it("uses backend catalog values for eval iteration allowances", () => {
    const sections = buildComparePlanSectionsFromCatalog(createPlanCatalog());

    expect(sections).not.toBe(COMPARE_PLAN_MARKETING_SECTIONS);
    expect(sections.map((section) => section.title)).toEqual([
      "Credits & seats",
      "Evaluations",
      "Security & Compliance",
      "Support",
      "Standard features",
    ]);
    const evalIterations = sections
      .find((section) => section.title === "Evaluations")
      ?.rows.find((row) => row.label === "Eval iterations");
    expect(evalIterations?.free).toEqual({
      kind: "text",
      text: "75 / day",
    });
    expect(evalIterations?.team).toEqual({
      kind: "text",
      text: "15,000 / mo",
      emphasize: true,
    });
  });

  it("updates when the backend catalog changes", () => {
    const sections = buildComparePlanSectionsFromCatalog(
      createPlanCatalog({ free: 100, team: 20_000 })
    );
    const evalIterations = sections
      .find((section) => section.title === "Evaluations")
      ?.rows.find((row) => row.label === "Eval iterations");

    expect(evalIterations?.free).toEqual({
      kind: "text",
      text: "100 / day",
    });
    expect(evalIterations?.team).toEqual({
      kind: "text",
      text: "20,000 / mo",
      emphasize: true,
    });
  });
});
