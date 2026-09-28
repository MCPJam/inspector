import { expect, it } from "vitest";
import { estimateCredits } from "../pricing-estimate";
it("rounds each model call up before adding catalog platform fees", () => {
  const card = {
    id: "v2",
    creditsPerProviderDollar: 100,
    platformFees: { eval_step: 3 },
  };
  expect(estimateCredits(card, 0.001, 10, { eval_step: 10 })).toBe(40);
  expect(estimateCredits(card, 0, 10, { eval_step: 10 })).toBe(30);
  expect(estimateCredits(card, -1, 10, {})).toBeNull();
  expect(estimateCredits(card, 1, 1, { unknown: 1 })).toBeNull();
});
