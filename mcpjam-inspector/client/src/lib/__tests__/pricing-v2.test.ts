import { describe, expect, it } from "vitest";
import {
  readCheckoutIntentFromSearch,
  persistCheckoutIntent,
  readPersistedCheckoutIntent,
} from "../billing-deep-link";
import { guardCheckoutIntentAgainstBillingStatus } from "../billing-checkout-intent-guard";
import { formatPlanName } from "../billing-entitlements";
import {
  offeredPlans,
  canCheckoutPlan,
  formatCatalogPrice,
  formatIncludedCredits,
} from "../pricing-catalog";
import type {
  PlanCatalog,
  PlanCatalogEntry,
} from "@/hooks/useOrganizationBilling";
const entry = (plan: string, model = "flat") =>
  ({
    plan,
    displayName: plan,
    billingModel: model,
    prices: { monthly: 2900, annual: 28800 },
    isSelfServe: true,
    checkout: { plan, supportedIntervals: ["monthly", "annual"] },
  } as PlanCatalogEntry);
describe("pricing v2 eligibility and checkout", () => {
  it("only offers Pro when the backend catalog includes it", () => {
    const legacy = {
      plans: {
        free: entry("free"),
        team: entry("team", "per_seat"),
        enterprise: entry("enterprise"),
      },
    } as PlanCatalog;
    expect(offeredPlans(legacy)).toEqual(["free", "team", "enterprise"]);
    expect(canCheckoutPlan(legacy, "pro", "annual")).toBe(false);
    const v2 = { ...legacy, plans: { ...legacy.plans, pro: entry("pro") } };
    expect(offeredPlans(v2)).toEqual(["free", "pro", "team", "enterprise"]);
    expect(canCheckoutPlan(v2, "pro", "annual")).toBe(true);
    v2.plans.pro.checkout!.supportedIntervals = ["monthly"];
    expect(canCheckoutPlan(v2, "pro", "annual")).toBe(false);
  });
  it("preserves Pro annual intent without allowing a downgrade through auto checkout", () => {
    const intent = readCheckoutIntentFromSearch("?plan=pro&interval=annual");
    expect(intent).toEqual({ plan: "pro", interval: "annual" });
    persistCheckoutIntent(intent!);
    expect(readPersistedCheckoutIntent()).toEqual(intent);
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        { effectivePlan: "team", source: "subscription" },
        "pro",
      ),
    ).toMatchObject({ proceed: false, reason: "already_higher" });
    expect(formatPlanName("pro")).toBe("Pro");
  });
  it("labels flat prices and catalog allowances without per-seat legacy claims", () => {
    expect(formatCatalogPrice(entry("pro"), "annual", "usd")).toBe("$24/mo");
    expect(
      formatCatalogPrice(entry("team", "per_seat"), "monthly", "usd"),
    ).toBe("$29/seat/mo");
    expect(formatIncludedCredits({ model: "monthly_ledger", flat: 3000 })).toBe(
      "3,000 / mo",
    );
    expect(
      formatIncludedCredits({ model: "daily_bucket", dailyCredits: 100 }),
    ).toBe("100 / day");
  });
});
