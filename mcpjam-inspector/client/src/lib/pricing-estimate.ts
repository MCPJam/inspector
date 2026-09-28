import type { PlanCatalogEntry } from "@/hooks/useOrganizationBilling";
/** Scenario estimate: per-call rounding matches the catalog's metered credit rule. */
export function estimateCredits(
  card: NonNullable<PlanCatalogEntry["rateCard"]>,
  providerDollarsPerCall: number,
  calls: number,
  units: Record<string, number>,
): number | null {
  if (
    !Number.isFinite(providerDollarsPerCall) ||
    providerDollarsPerCall < 0 ||
    !Number.isSafeInteger(calls) ||
    calls < 0 ||
    !Number.isFinite(card.creditsPerProviderDollar) ||
    card.creditsPerProviderDollar < 0
  )
    return null;
  let total =
    calls * Math.ceil(providerDollarsPerCall * card.creditsPerProviderDollar);
  for (const [unit, count] of Object.entries(units)) {
    const fee = card.platformFees[unit];
    if (
      !Number.isFinite(fee) ||
      fee < 0 ||
      !Number.isFinite(count) ||
      count < 0
    )
      return null;
    total += fee * count;
  }
  return Number.isSafeInteger(Math.ceil(total)) ? Math.ceil(total) : null;
}
