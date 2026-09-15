import { expect, it } from "vitest";
import { normalizeBalance, isOutOfCredits } from "@/hooks/useCreditBalance";
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
