import { expect, it } from "vitest";
import { priceTopupPreset } from "../credit-topup-pricing";
const preset = {
  packageId: "credits_1000",
  displayCredits: "1,000 credits",
  priceCents: 1000,
  displayPrice: "$10",
};
it("uses matching server catalog terms for the Team discount and preserves legacy prices", () => {
  expect(
    priceTopupPreset(
      preset,
      { catalogPlanId: "team" },
      { catalogPlanId: "team", topUp: { centsPerCredit: 0.9 } },
    ),
  ).toMatchObject({ priceCents: 900, displayPrice: "$9.00" });
  expect(
    priceTopupPreset(
      preset,
      { catalogPlanId: "pro" },
      { catalogPlanId: "pro", topUp: { centsPerCredit: 1 } },
    ),
  ).toMatchObject({ priceCents: 1000 });
  expect(priceTopupPreset(preset, {}, {})).toEqual(preset);
});
it("does not quote an offered bundle's price for a different purchased bundle", () => {
  expect(
    priceTopupPreset(
      preset,
      { catalogPlanId: "team_v1" },
      { catalogPlanId: "team", topUp: { centsPerCredit: 0.9 } },
    ),
  ).toBeNull();
  expect(priceTopupPreset(preset, undefined, undefined)).toBeNull();
});

it("does not quote a locked wallet or an ineligible catalog", () => {
  expect(
    priceTopupPreset(
      preset,
      { catalogPlanId: "team", topUpEligible: false },
      { catalogPlanId: "team", topUp: { centsPerCredit: 0.9, eligible: true } },
    ),
  ).toBeNull();
  expect(
    priceTopupPreset(
      preset,
      { catalogPlanId: "team", topUpEligible: true },
      {
        catalogPlanId: "team",
        topUp: { centsPerCredit: 0.9, eligible: false },
      },
    ),
  ).toBeNull();
});
