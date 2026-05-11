import { describe, expect, it } from "vitest";
import { guardCheckoutIntentAgainstBillingStatus } from "../billing-checkout-intent-guard";

type BillingStatusGuardFixture = Parameters<
  typeof guardCheckoutIntentAgainstBillingStatus
>[0];

function billingStatusFixture(
  overrides: Partial<BillingStatusGuardFixture> = {},
): BillingStatusGuardFixture {
  return {
    effectivePlan: "free",
    source: "free",
    ...overrides,
  };
}

describe("guardCheckoutIntentAgainstBillingStatus", () => {
  it("allows upgrade from free to team", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(billingStatusFixture(), "team"),
    ).toEqual({ proceed: true });
  });

  it("allows team checkout during an active team trial", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({ effectivePlan: "team", source: "trial" }),
        "team",
      ),
    ).toEqual({ proceed: true });
  });

  it("blocks when already on team", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "team",
          source: "subscription",
        }),
        "team",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_on",
      currentPlan: "team",
    });
  });

  it("blocks team link when on enterprise", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "enterprise",
          source: "subscription",
        }),
        "team",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_higher",
      currentPlan: "enterprise",
    });
  });
});
