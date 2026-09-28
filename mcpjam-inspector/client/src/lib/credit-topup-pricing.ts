import type { CreditTopupPreset } from "@/hooks/useCreditTopup";
/** The public package list is legacy-priced. Only a matching purchased bundle can reprice it. */
export function priceTopupPreset(
  preset: CreditTopupPreset,
  status: { catalogPlanId?: string; topUpEligible?: boolean } | undefined,
  entry:
    | {
        catalogPlanId?: string;
        topUp?: { centsPerCredit: number; eligible?: boolean };
      }
    | undefined,
): CreditTopupPreset | null {
  if (
    !status ||
    !entry ||
    status.topUpEligible === false ||
    entry.topUp?.eligible === false
  )
    return null;
  if (!status.catalogPlanId && !entry.catalogPlanId) return preset;
  if (status.catalogPlanId !== entry.catalogPlanId || !entry.topUp) return null;
  const credits = Number(
    preset.displayCredits.replace(/\s*credits\s*$/i, "").replaceAll(",", ""),
  );
  const rate = entry.topUp.centsPerCredit;
  if (
    !Number.isSafeInteger(credits) ||
    credits <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0
  )
    return null;
  const priceCents = Math.round(credits * rate);
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) return null;
  return {
    ...preset,
    priceCents,
    displayPrice: new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(priceCents / 100),
  };
}
