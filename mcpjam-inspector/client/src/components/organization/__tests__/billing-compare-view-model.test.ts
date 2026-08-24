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
      // PER SEAT, like the credits row above it and like the upgrade wall's
      // "N per seat each month". `15,000 / mo` read as an org-wide total.
      text: "15,000 / seat / mo",
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
      text: "20,000 / seat / mo",
      emphasize: true,
    });
  });

  it("renders a null catalog limit as Unlimited on either plan", () => {
    // `null` is the catalog's "no cap", the same value Enterprise carries. It
    // must never reach the cadence template — "null / day" would read as a cap
    // of zero on the plan with no cap at all.
    const sections = buildComparePlanSectionsFromCatalog(
      createPlanCatalog({ free: null, team: null })
    );
    const evalIterations = sections
      .find((section) => section.title === "Evaluations")
      ?.rows.find((row) => row.label === "Eval iterations");

    expect(evalIterations?.free).toEqual({ kind: "text", text: "Unlimited" });
    expect(evalIterations?.team).toEqual({
      kind: "text",
      text: "Unlimited",
      emphasize: true,
    });
  });
});
