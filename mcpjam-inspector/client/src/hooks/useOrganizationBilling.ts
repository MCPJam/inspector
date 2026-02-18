import { useAction, useQuery } from "convex/react";
import { useCallback, useState } from "react";

export interface OrganizationBillingStatus {
  organizationId: string;
  organizationName: string;
  plan: "oss" | "pro";
  subscriptionStatus: string | null;
  canManageBilling: boolean;
  isOwner: boolean;
  hasCustomer: boolean;
  stripeCurrentPeriodEnd: number | null;
  stripePriceId: string | null;
}

export function useOrganizationBilling(organizationId: string | null) {
  const billingStatus = useQuery(
    "billing:getOrganizationBillingStatus" as any,
    organizationId ? ({ organizationId } as any) : "skip",
  ) as OrganizationBillingStatus | undefined;

  const createCheckout = useAction(
    "billing:createOrganizationProCheckoutSession" as any,
  );
  const createPortal = useAction(
    "billing:createOrganizationBillingPortalSession" as any,
  );

  const [isStartingCheckout, setIsStartingCheckout] = useState(false);
  const [isOpeningPortal, setIsOpeningPortal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = useCallback(
    async (returnUrl: string) => {
      if (!organizationId) throw new Error("Organization is required");
      setIsStartingCheckout(true);
      setError(null);
      try {
        const result = await createCheckout({
          organizationId,
          returnUrl,
        });
        return result.checkoutUrl as string;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to create checkout";
        setError(message);
        throw err;
      } finally {
        setIsStartingCheckout(false);
      }
    },
    [createCheckout, organizationId],
  );

  const openPortal = useCallback(
    async (returnUrl: string) => {
      if (!organizationId) throw new Error("Organization is required");
      setIsOpeningPortal(true);
      setError(null);
      try {
        const result = await createPortal({
          organizationId,
          returnUrl,
        });
        return result.portalUrl as string;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to open billing portal";
        setError(message);
        throw err;
      } finally {
        setIsOpeningPortal(false);
      }
    },
    [createPortal, organizationId],
  );

  return {
    billingStatus,
    isLoadingBilling: !!organizationId && billingStatus === undefined,
    isStartingCheckout,
    isOpeningPortal,
    error,
    startCheckout,
    openPortal,
  };
}
