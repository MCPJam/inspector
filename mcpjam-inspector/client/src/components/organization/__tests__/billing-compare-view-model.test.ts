import { describe, expect, it } from "vitest";
import { buildComparePlanSectionsFromCatalog } from "@/components/organization/billing-compare-view-model";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

function createPlanCatalog(
  maxEvalRunsPerMonth: { free: number; team: number },
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
          maxMembers: 1,
          maxProjects: 1,
          maxServersPerProject: 3,
          maxEvalRunsPerMonth: maxEvalRunsPerMonth.free,
        },
      },
      team: {
        ...baseEntry,
        limits: {
          maxMembers: 10,
          maxProjects: 10,
          maxServersPerProject: 10,
          maxEvalRunsPerMonth: maxEvalRunsPerMonth.team,
        },
      },
      enterprise: {
        ...baseEntry,
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxEvalRunsPerMonth: null,
        },
      },
    },
  };
}

function findEvalIterationCapRow(
  sections: ReturnType<typeof buildComparePlanSectionsFromCatalog>,
) {
  for (const section of sections) {
    const row = section.rows.find((r) => r.label === "Eval iteration cap");
    if (row) return row;
  }
  throw new Error("Eval iteration cap row not found");
}

describe("buildComparePlanSectionsFromCatalog", () => {
  it("keeps static eval iteration cap copy instead of catalog limits", () => {
    const sections = buildComparePlanSectionsFromCatalog(
      createPlanCatalog({ free: 5, team: 5000 }),
    );
    const row = findEvalIterationCapRow(sections);

    expect(row.free).toEqual({ kind: "text", text: "100 iter. / mo" });
    expect(row.team).toEqual({
      kind: "text",
      text: "5,000 iter. / mo",
      emphasize: true,
    });
  });
});
