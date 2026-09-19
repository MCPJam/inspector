import { describe, expect, it } from "vitest";
import { COMPARE_PLAN_MARKETING_SECTIONS } from "@/components/organization/compare-plan-marketing";
import { buildComparePlanSectionsFromCatalog } from "@/components/organization/billing-compare-view-model";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

function createPlanCatalog(
  evalLimits: { free: number | null; team: number | null } = {
    free: 75,
    team: 15_000,
  },
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
  it("uses the Figma V2 comparison only for V2 offers and preserves catalog allowances", () => {
    const legacy = createPlanCatalog();
    const original = structuredClone(legacy);
    const v2 = {
      ...legacy,
      plans: {
        ...legacy.plans,
        enterprise: { ...legacy.plans.enterprise, features: { sso: true } },
        free: {
          ...legacy.plans.free,
          includedCredits: { model: "daily_bucket", dailyCredits: 200 },
        },
        pro: {
          ...legacy.plans.team,
          includedCredits: { model: "monthly_ledger", flat: 5000 },
        },
        team: {
          ...legacy.plans.team,
          includedCredits: { model: "monthly_ledger", flat: 50000 },
        },
      },
    } as PlanCatalog;
    const sections = buildComparePlanSectionsFromCatalog(v2);
    expect(sections.map(({ title }) => title)).toEqual([
      "Usage",
      "Features",
      "Security & Compliance",
      "Support",
    ]);
    const rows = sections.flatMap(({ rows }) => rows);
    expect(rows.some(({ label }) => label === "CI/CD Integration")).toBe(false);
    expect(
      rows.find(({ label }) => label === "Included credits"),
    ).toMatchObject({
      free: { kind: "text", text: "200 / day" },
      pro: { kind: "text", text: "5,000 / mo" },
      team: { kind: "text", text: "50,000 / mo" },
      tooltipKey: "V2 included credits",
    });
    expect(rows.find(({ label }) => label === "SSO / SAML")).toMatchObject({
      free: { kind: "x" },
      pro: { kind: "x" },
      team: { kind: "x" },
      enterprise: { kind: "check" },
    });
    expect(rows.find(({ label }) => label === "Eval history")).toMatchObject({
      free: { kind: "text", text: "30 days" },
      pro: { kind: "text", text: "Unlimited" },
    });
    expect(rows.find(({ label }) => label === "Support tier")).toMatchObject({
      pro: { kind: "text", text: "Basic" },
      team: { kind: "text", text: "Priority" },
    });
    v2.plans.pro!.includedCredits = { model: "monthly_ledger", flat: 7500 };
    expect(buildComparePlanSectionsFromCatalog(v2)[0].rows[0].pro).toEqual({
      kind: "text",
      text: "7,500 / mo",
    });
    expect(legacy).toEqual(original);
    expect(
      buildComparePlanSectionsFromCatalog(legacy)
        .flatMap(({ rows }) => rows)
        .find(({ label }) => label === "SSO / SAML")?.team,
    ).toEqual({ kind: "x" });
  });

  it("does not treat a versioned legacy catalog as V2", () => {
    const catalog = createPlanCatalog();
    catalog.plans.free.catalogPlanId = "free_v1";
    catalog.plans.team.catalogPlanId = "team_v1";
    catalog.plans.team.includedCredits = {
      model: "monthly_ledger",
      perSeat: 10000,
    };
    const sections = buildComparePlanSectionsFromCatalog(catalog);
    expect(sections[0].title).toBe("Plan details");
    expect(sections[0].rows[0].team).toEqual({
      kind: "text",
      text: "10,000 / seat / mo",
    });
    expect(
      sections
        .flatMap(({ rows }) => rows)
        .some(({ label }) => label === "Eval history"),
    ).toBe(false);
  });

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
      createPlanCatalog({ free: 100, team: 20_000 }),
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
      createPlanCatalog({ free: null, team: null }),
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
