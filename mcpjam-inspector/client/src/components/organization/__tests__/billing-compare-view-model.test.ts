import { describe, expect, it } from "vitest";
import { buildComparePlanSectionsFromCatalog } from "@/components/organization/billing-compare-view-model";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

function createPlanCatalog(): PlanCatalog {
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
          maxChatboxesPerProject: null,
          maxEvalRunsPerMonth: 500,
          insightsPerDay: null,
        },
      },
      team: {
        ...baseEntry,
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxChatboxesPerProject: null,
          maxEvalRunsPerMonth: 10000,
          insightsPerDay: null,
        },
      },
      enterprise: {
        ...baseEntry,
        limits: {
          maxMembers: null,
          maxProjects: null,
          maxServersPerProject: null,
          maxChatboxesPerProject: null,
          maxEvalRunsPerMonth: null,
          insightsPerDay: null,
        },
      },
    },
  };
}

function findRow(
  sections: ReturnType<typeof buildComparePlanSectionsFromCatalog>,
  label: string,
) {
  for (const section of sections) {
    const row = section.rows.find((r) => r.label === label);
    if (row) return row;
  }
  throw new Error(`${label} row not found`);
}

describe("buildComparePlanSectionsFromCatalog", () => {
  it("renders uncapped Free and Team org/project limits from the catalog", () => {
    const sections = buildComparePlanSectionsFromCatalog(createPlanCatalog());
    const seatLimit = findRow(sections, "Seat limit");
    const projects = findRow(sections, "Projects");

    expect(seatLimit.free).toMatchObject({
      kind: "text",
      text: "Unlimited",
    });
    expect(seatLimit.team).toEqual({
      kind: "text",
      text: "Unlimited",
      emphasize: true,
    });
    expect(projects.free).toMatchObject({
      kind: "text",
      text: "Unlimited",
    });
    expect(projects.team).toEqual({
      kind: "text",
      text: "Unlimited",
      emphasize: true,
    });
  });
});
