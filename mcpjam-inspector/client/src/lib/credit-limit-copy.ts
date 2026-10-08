import type { PlanCatalogEntry } from "@/hooks/useOrganizationBilling";

/** Only advertise amounts supplied by the billing catalog. */
export function creditAllowanceLabel(
  credits: PlanCatalogEntry["includedCredits"],
): string | null {
  if (!credits || credits.model !== "monthly_ledger") return null;
  const amount =
    "flat" in credits
      ? credits.flat
      : "perSeat" in credits
      ? credits.perSeat
      : null;
  if (amount === null || !Number.isFinite(amount) || amount <= 0) return null;
  return `${amount.toLocaleString()} credits${
    "perSeat" in credits ? " per seat" : ""
  } each month`;
}

export function creditUpgradeBenefit(plans: PlanCatalogEntry[] = []): string {
  const offers = plans.flatMap((plan) => {
    const allowance = creditAllowanceLabel(plan.includedCredits);
    return allowance ? [`${plan.displayName} includes ${allowance}`] : [];
  });
  return offers.length
    ? `${offers.join(
        "; ",
      )}. Run more evaluations and Swarms, with top-ups available.`
    : "Get more monthly credits and top-ups with Pro or Team.";
}
