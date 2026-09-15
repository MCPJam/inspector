import { useQuery } from "convex/react";
import { useIsMemberActor } from "./use-is-member-actor";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type { CreditTopupPreset } from "./useCreditTopup";

interface OrganizationTopupQuote {
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

export function useCreditTopupPricing(
  organizationId: string | null | undefined,
  enabled: boolean,
) {
  const member = useIsMemberActor();
  const ready = useDbUserReady();
  const args =
    enabled && member && ready && organizationId ? { organizationId } : "skip";
  const quote = useQuery(
    "billing:getOrganizationCreditTopupPresets" as any,
    args,
  ) as OrganizationTopupQuote | undefined;
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
  });
}
