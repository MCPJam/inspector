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
  it("allows upgrade from free to starter", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture(),
        "starter",
      ),
    ).toEqual({ proceed: true });
  });

  it("allows upgrade from free to team", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(billingStatusFixture(), "team"),
    ).toEqual({ proceed: true });
  });

  it("allows upgrade from starter to team", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "starter",
          source: "subscription",
        }),
        "team",
      ),
    ).toEqual({ proceed: true });
  });

  it("allows starter checkout during an active starter trial", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({ effectivePlan: "starter", source: "trial" }),
        "starter",
      ),
    ).toEqual({ proceed: true });
  });

  it("allows team checkout during an active starter trial", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({ effectivePlan: "starter", source: "trial" }),
        "team",
      ),
    ).toEqual({ proceed: true });
  });

  it("blocks when already on requested starter", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "starter",
          source: "subscription",
        }),
        "starter",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_on",
      currentPlan: "starter",
    });
  });

  it("blocks when already on requested team", () => {
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

  it("blocks starter link when on team", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "team",
          source: "subscription",
        }),
        "starter",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_higher",
      currentPlan: "team",
    });
  });

  it("blocks starter link when on enterprise", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "enterprise",
          source: "subscription",
        }),
        "starter",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_higher",
      currentPlan: "enterprise",
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
