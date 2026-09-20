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
      )}. Upgrade to run more evaluations and Swarms, with credit top-ups when you need them.`
    : "Upgrade to Pro or Team for a larger monthly credit allowance and access to top-ups, so you can run more evaluations and Swarms.";
}
