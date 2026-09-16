import { useCallback } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";

export interface AutoTopupConfiguration {
  thresholdCredits: number;
  topupCredits: number;
  monthlySpendLimitCents: number | null;
}
export interface AutoTopupView {
  preferences:
    | (AutoTopupConfiguration & { updatedByUserId: string; updatedAt: number })
    | null;
  revision: number;
  consentVersion: "auto-topup-v1";
  currency: "usd";
  refillPriceCents: number | null;
  eligible: boolean;
  activationAllowed: boolean;
  status:
    | "not_configured"
    | "not_active"
    | "awaiting_card"
    | "enrolled"
    | "paused"
    | "payment_pending"
    | "needs_attention";
  paymentIssue: string | null;
  card: { brand: string; last4: string } | null;
  monthlySpend: { month: string; chargedCents: number; reservedCents: number };
}
export interface AutoTopupSetup {
  setupIntentId: string;
  clientSecret: string;
}

/** Query errors must be contained by the billing dialog's ErrorBoundary. */
export function useAutoTopup(organizationId: string | null | undefined) {
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isMember && isUserReady && organizationId);
  const view = useQuery(
    "billing/autoTopupPreferences:get" as any,
    canQuery ? { organizationId } : "skip",
  ) as AutoTopupView | undefined;
  const set = useMutation("billing/autoTopupPreferences:set" as any);
  const clearPreferences = useMutation(
    "billing/autoTopupPreferences:clear" as any,
  );
  const turnOff = useMutation("billing/autoTopupActivation:disable" as any);
  const beginAction = useAction("billing/autoTopupActivationNode:begin" as any);
  const finishAction = useAction(
    "billing/autoTopupActivationNode:finish" as any,
  );
  const { error, isSaving, run } = useOrgScopedWrite(organizationId ?? null);
  const requireOrganization = () => {
    if (!canQuery || !organizationId)
      throw new Error("Sign in and select an organization first.");
    return organizationId;
  };
  const save = useCallback(
    async (configuration: AutoTopupConfiguration) => {
      if (!canQuery || !organizationId)
        throw new Error("Select an organization first.");
      await run(() => set({ organizationId, ...configuration }));
    },
    [canQuery, organizationId, run, set],
  );
  const disable = useCallback(async () => {
    if (!canQuery || !organizationId)
      throw new Error("Select an organization first.");
    await run(() => turnOff({ organizationId }));
  }, [canQuery, organizationId, run, turnOff]);
  const clear = useCallback(async () => {
    if (!canQuery || !organizationId)
      throw new Error("Select an organization first.");
    await run(() => clearPreferences({ organizationId }));
  }, [canQuery, organizationId, run, clearPreferences]);
  const begin = async (): Promise<AutoTopupSetup> => {
    const id = requireOrganization();
    if (
      !view?.activationAllowed ||
      !view.eligible ||
      !view.preferences ||
      view.refillPriceCents == null
    ) {
      throw new Error(
        "Automatic refills are unavailable. Save settings and review the current quote first.",
      );
    }
    return await beginAction({
      organizationId: id,
      consent: true,
      consentVersion: view.consentVersion,
      expectedRevision: view.revision,
      expectedPriceCents: view.refillPriceCents,
    });
  };
  const finish = async (setupIntentId: string): Promise<void> => {
    await finishAction({
      organizationId: requireOrganization(),
      setupIntentId,
    });
  };
  return {
    view,
    isLoading: isMember !== false && view === undefined,
    querySkipped: isMember === false,
    error,
    isSaving,
    save,
    disable,
    clear,
    begin,
    finish,
  };
}
