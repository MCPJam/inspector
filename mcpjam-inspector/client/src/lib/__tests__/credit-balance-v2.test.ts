import { expect, it } from "vitest";
import {
  normalizeBalance,
  isFreeTierOnly,
  isOutOfCredits,
} from "@/hooks/useCreditBalance";
it("recognizes flat monthly credits and does not declare a funded Pro wallet empty", () => {
  const balance = normalizeBalance({
    billingModel: "monthly_flat",
    monthlyAllowanceRemaining: 500,
    monthlyAllowanceTotal: 3000,
    rolloverCapCredits: 6000,
    topUpEligible: true,
  });
  expect(balance?.billingModel).toBe("monthly_flat");
  expect(isOutOfCredits(balance)).toBe(false);
  expect(balance?.rolloverCapCredits).toBe(6000);
  expect(normalizeBalance({ billingModel: "future" })?.billingModel).toBe(
    "daily",
  );
});

it("preserves debt and carried credits without treating missing values as balances", () => {
  expect(
    normalizeBalance({
      outstandingDeficitCredits: 125,
      rolloverCreditsRemaining: 700,
    }),
  ).toMatchObject({
    outstandingDeficitCredits: 125,
    rolloverCreditsRemaining: 700,
  });
  for (const value of [undefined, null, "15", NaN, Infinity]) {
    const balance = normalizeBalance({
      outstandingDeficitCredits: value,
      rolloverCreditsRemaining: value,
    });
    expect(balance?.outstandingDeficitCredits).toBeUndefined();
    expect(balance?.rolloverCreditsRemaining).toBeUndefined();
  }
  expect(
    normalizeBalance({
      outstandingDeficitCredits: 0,
      rolloverCreditsRemaining: 0,
    }),
  ).toMatchObject({
    outstandingDeficitCredits: 0,
    rolloverCreditsRemaining: 0,
  });
});

it("reads free-tier-only as a guest on the daily allowance with no purchased credits", () => {
  const signedIn = false;
  expect(isFreeTierOnly(undefined, signedIn)).toBe(false);
  expect(
    isFreeTierOnly(normalizeBalance({ paidCreditsRemaining: 0 }), signedIn),
  ).toBe(true);
  expect(
    isFreeTierOnly(normalizeBalance({ paidCreditsRemaining: 50 }), signedIn),
  ).toBe(false);
  expect(
    isFreeTierOnly(
      normalizeBalance({
        billingModel: "monthly_per_seat",
        paidCreditsRemaining: 0,
      }),
      signedIn,
    ),
  ).toBe(false);
});

it("never marks a signed-in user free-tier-only, even with no purchased credits", () => {
  expect(
    isFreeTierOnly(normalizeBalance({ paidCreditsRemaining: 0 }), true),
  ).toBe(false);
});
