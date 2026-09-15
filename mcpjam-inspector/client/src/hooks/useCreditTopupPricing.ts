import { useQuery } from "convex/react";
import { useIsMemberActor } from "./use-is-member-actor";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type {
  OrganizationBillingStatus,
  PlanCatalog,
} from "./useOrganizationBilling";
import type { CreditTopupPreset } from "./useCreditTopup";
import { priceTopupPreset } from "@/lib/credit-topup-pricing";
export function useCreditTopupPricing(
  organizationId: string | null | undefined,
  enabled: boolean,
) {
  const member = useIsMemberActor();
  const ready = useDbUserReady();
  const args =
    enabled && member && ready && organizationId ? { organizationId } : "skip";
  const status = useQuery(
    "billing:getOrganizationBillingStatus" as any,
    args,
  ) as OrganizationBillingStatus | undefined;
  const catalog = useQuery("billing:getPlanCatalog" as any, args) as
    | PlanCatalog
    | undefined;
  return (preset: CreditTopupPreset) =>
    priceTopupPreset(
      preset,
      status,
      status ? catalog?.plans[status.effectivePlan] : undefined,
    );
}
