import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useMemo } from "react";
import { useIsMemberActor } from "./use-is-member-actor";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type { CreditTopupPreset } from "./useCreditTopup";

interface OrganizationTopupQuote {
  catalogPlanId: string;
  currency: "usd";
  topUpEligible: boolean;
  canPurchase: boolean;
  presets: Array<{
    packageId: string;
    credits: number;
    priceCents: number;
    displayCredits: string;
  }>;
}

const topupPricingQuery = makeFunctionReference<
  "query",
  { organizationId: string },
  OrganizationTopupQuote
>("billing:getOrganizationCreditTopupPresets");

export function useCreditTopupPricing(
  organizationId: string | null | undefined,
  enabled: boolean,
) {
  const member = useIsMemberActor();
  const ready = useDbUserReady();
  // Unlike useQuery, useQueries returns server errors instead of throwing
  // during render, so a billing outage stays inside the purchase dialog.
  // Convex keys its subscription callbacks by this object's identity.
  // Keep both the active and skipped requests stable across renders.
  const queries = useMemo<Parameters<typeof useQueries>[0]>(
    (): Parameters<typeof useQueries>[0] =>
      enabled && member && ready && organizationId
        ? { quote: { query: topupPricingQuery, args: { organizationId } } }
        : {},
    [enabled, member, ready, organizationId],
  );
  const result = useQueries(queries).quote as
    OrganizationTopupQuote | Error | undefined;
  const error = result instanceof Error ? result : null;
  const quote = result instanceof Error ? undefined : result;
  const quotePreset = (preset: CreditTopupPreset): CreditTopupPreset | null => {
    if (!quote?.topUpEligible) return null;
    const match = quote.presets.find(
      (item) => item.packageId === preset.packageId,
    );
    if (!match) return null;
    return {
      packageId: match.packageId,
      priceCents: match.priceCents,
      displayCredits: match.displayCredits,
      displayPrice: new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(match.priceCents / 100),
    };
  };
  return Object.assign(quotePreset, {
    canPurchase: quote?.canPurchase === true,
    isLoading: enabled && result === undefined,
    requiresUpgrade:
      quote?.catalogPlanId === "free" || quote?.catalogPlanId === "free_v1",
    error,
  });
}
