import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "@/components/organization/compare-plan-marketing";
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
          maxEvalRunsPerMonth: null,
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
          maxEvalRunsPerMonth: null,
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

describe("buildComparePlanSectionsFromCatalog", () => {
  it("returns the static marketing compare sections", () => {
    const sections = buildComparePlanSectionsFromCatalog(createPlanCatalog());

    expect(sections).toBe(COMPARE_PLAN_MARKETING_SECTIONS);
    expect(sections.map((section) => section.title)).toEqual([
      "Credits & seats",
      "Evaluations",
      "Security & Compliance",
      "Support",
      "Standard features",
    ]);
  });
});
