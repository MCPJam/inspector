import type {
  BillingInterval,
  OrganizationPlan,
  PlanCatalog,
  PlanCatalogEntry,
} from "@/hooks/useOrganizationBilling";
export const PLAN_ORDER: OrganizationPlan[] = [
  "free",
  "pro",
  "team",
  "enterprise",
];
/** Pro is only present when the server offers the V2 catalog. */
export function isV2PlanCatalog(catalog: PlanCatalog): boolean {
  return catalog.plans.pro != null;
}

export function isLegacyTeamEntry(entry: PlanCatalogEntry): boolean {
  return (
    entry.plan === "team" &&
    (entry.catalogPlanId === "team_v1" || entry.billingModel === "per_seat")
  );
}
/** getPlanCatalog applies PRICING_V2_MODE and actor/org eligibility on the server. */
export function offeredPlans(catalog: PlanCatalog): OrganizationPlan[] {
  return PLAN_ORDER.filter((plan) => catalog.plans[plan] != null);
}
export function canCheckoutPlan(
  catalog: PlanCatalog | undefined,
  plan: "pro" | "team",
  interval: BillingInterval,
): boolean {
  return canCheckoutPlanEntry(catalog?.plans[plan], plan, interval);
}
export function canCheckoutPlanEntry(
  entry: PlanCatalogEntry | undefined,
  plan: "pro" | "team",
  interval: BillingInterval,
): boolean {
  return (
    !!entry?.isSelfServe &&
    entry.checkout?.plan === plan &&
    entry.checkout.supportedIntervals.includes(interval) &&
    entry.prices[interval] != null
  );
}
export function formatCatalogPrice(
  entry: PlanCatalogEntry,
  interval: BillingInterval,
  currency: string,
): string {
  const price = entry.prices[interval];
  if (price == null) return "Custom";
  const amount = price / 100 / (interval === "annual" ? 12 : 1);
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(amount);
  return `${money}${entry.billingModel === "per_seat" ? "/seat/mo" : "/mo"}`;
}
export function formatIncludedCredits(
  credits: PlanCatalogEntry["includedCredits"],
): string {
  if (!credits) return "—";
  const number = (n: number) => n.toLocaleString("en-US");
  if (credits.model === "daily_bucket")
    return `${number(credits.dailyCredits)} / day`;
  if ("flat" in credits) return `${number(credits.flat)} / mo`;
  if ("perSeat" in credits) return `${number(credits.perSeat)} / seat / mo`;
  return "Custom";
}
