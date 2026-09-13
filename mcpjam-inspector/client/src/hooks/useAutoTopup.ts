import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";
import type { AutoTopupConfiguration } from "@/components/billing/AutoTopupSettings";

/**
 * Convex function ids for auto-reload enrollment. The backend is not built
 * yet; these names are the contract it is expected to ship under. This app
 * has no generated Convex client, so nothing checks them at build time.
 *
 * Expected shapes:
 *   - GET  → `AutoTopupConfiguration | null` (null = not enrolled)
 *   - SET  → `{ organizationId, thresholdCredits, topupCredits,
 *              monthlySpendLimitCredits: number | null }`
 *   - CLEAR → `{ organizationId }`
 */
export const AUTO_TOPUP_GET_FN = "billing/autoTopup:getOrganizationAutoTopup";
export const AUTO_TOPUP_SET_FN = "billing/autoTopup:setOrganizationAutoTopup";
export const AUTO_TOPUP_CLEAR_FN =
  "billing/autoTopup:clearOrganizationAutoTopup";

const finiteInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

/**
 * `undefined` while loading; `null` when the org is confirmed not enrolled.
 * A malformed row reads as not enrolled rather than crashing the dialog.
 */
export function normalizeAutoTopup(
  raw: unknown,
): AutoTopupConfiguration | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const thresholdCredits = finiteInt(r.thresholdCredits);
  const topupCredits = finiteInt(r.topupCredits);
  if (thresholdCredits === undefined || topupCredits === undefined) return null;
  return {
    thresholdCredits,
    topupCredits,
    monthlySpendLimitCredits: finiteInt(r.monthlySpendLimitCredits) ?? null,
  };
}

/**
 * Auto-reload enrollment for one organization.
 *
 * **This hook can throw, and every call site MUST sit inside an
 * `ErrorBoundary`.** `useQuery` re-throws query errors during render, and the
 * ordinary case here is the backend function not being deployed yet: the two
 * repos release independently, and this one ships first.
 */
export function useAutoTopup(organizationId: string | null | undefined) {
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isMember && isUserReady && organizationId);
  // Resolved guest, not "still settling": see useIsMemberActor.
  const actorIsGuest = isMember === false;

  const raw = useQuery(
    AUTO_TOPUP_GET_FN as any,
    canQuery ? ({ organizationId } as any) : "skip",
  ) as unknown;
  const enrollment = normalizeAutoTopup(raw);

  const setMutation = useMutation(AUTO_TOPUP_SET_FN as any);
  const clearMutation = useMutation(AUTO_TOPUP_CLEAR_FN as any);
  const { error, isSaving, run } = useOrgScopedWrite(organizationId ?? null);

  const save = useCallback(
    async (configuration: AutoTopupConfiguration) => {
      if (!organizationId) return;
      await run(() =>
        setMutation({
          organizationId,
          thresholdCredits: configuration.thresholdCredits,
          topupCredits: configuration.topupCredits,
          monthlySpendLimitCredits:
            configuration.monthlySpendLimitCredits ?? null,
        } as any),
      );
    },
    [organizationId, run, setMutation],
  );

  const disable = useCallback(async () => {
    if (!organizationId) return;
    await run(() => clearMutation({ organizationId } as any));
  }, [organizationId, run, clearMutation]);

  return {
    enrollment,
    isLoading: !actorIsGuest && enrollment === undefined,
    querySkipped: actorIsGuest,
    error,
    isSaving,
    save,
    disable,
  };
}
