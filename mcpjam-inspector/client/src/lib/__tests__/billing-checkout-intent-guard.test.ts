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
  it("allows upgrade from free to pro", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(billingStatusFixture(), "pro"),
    ).toEqual({ proceed: true });
  });

  it("allows pro checkout during an active pro trial", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({ effectivePlan: "free", source: "trial" }),
        "pro",
      ),
    ).toEqual({ proceed: true });
  });

  it("blocks when already on pro", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "pro",
          source: "subscription",
        }),
        "pro",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_on",
      currentPlan: "pro",
    });
  });

  it("blocks pro link when on enterprise", () => {
    expect(
      guardCheckoutIntentAgainstBillingStatus(
        billingStatusFixture({
          effectivePlan: "enterprise",
          source: "subscription",
        }),
        "pro",
      ),
    ).toEqual({
      proceed: false,
      reason: "already_higher",
      currentPlan: "enterprise",
    });
  });
});
