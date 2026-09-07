import { useCallback, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";

/**
 * The organization's spend budget — an admin-set ceiling on MCPJam-billed
 * spend per billing window.
 *
 * A Convex subscription rather than a fetch, so the meter moves as the org
 * spends: the counter is patched by the same transaction that debits the
 * ledger, and the row updates itself instead of waiting for a refresh.
 *
 * Function ids are strings because this app has no generated Convex client;
 * the type below is hand-mirrored from
 * `convex/billing/spendBudgetSettings.ts`. Keep them in sync by hand —
 * nothing checks this at build time.
 *
 * **This hook can throw, and every call site MUST sit inside an
 * `ErrorBoundary`.** `useQuery` re-throws query errors during render, and two
 * ordinary cases produce one: the backend function is not deployed yet (the
 * two repos release independently), or the caller is not a member of the org
 * they passed — the backend refuses there deliberately.
 */

export interface OrgSpendBudget {
  /** The ceiling in credits (1 credit = 1¢). `null` means uncapped. */
  capCredits: number | null;
  /** Whole percents of the cap that alert. 100 always alerts. */
  alertPercents: number[];
  consumedCredits: number;
  windowStartAt: number;
  windowEndsAt: number;
  /** Thresholds already announced this window. */
  alertedPercents: number[];
  capReachedAt: number | null;
  updatedAt: number | null;
  updatedByUserId: string | null;
  minCapCredits: number;
  maxCapCredits: number;
  maxAlertCount: number;
  /** False for a personal (guest-owned) org, which cannot have a budget. */
  supported: boolean;
}

export function useOrgSpendBudget(organizationId: string | null | undefined) {
  const isMember = useIsMemberActor();
  const isUserReady = useDbUserReady();
  const canQuery = Boolean(isMember && isUserReady && organizationId);

  const budget = useQuery(
    "billing/spendBudgetSettings:getOrganizationSpendBudget" as any,
    canQuery ? ({ organizationId } as any) : "skip",
  ) as OrgSpendBudget | undefined;

  const setBudgetMutation = useMutation(
    "billing/spendBudgetSettings:setOrganizationSpendBudget" as any,
  );
  const clearBudgetMutation = useMutation(
    "billing/spendBudgetSettings:clearOrganizationSpendBudget" as any,
  );

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const setBudget = useCallback(
    async (input: { capCredits: number; alertPercents?: number[] }) => {
      if (!organizationId) return;
      setError(null);
      setIsSaving(true);
      try {
        await setBudgetMutation({ organizationId, ...input } as any);
      } catch (caught) {
        // Surfaced inline rather than thrown: a rejected write is an answer
        // ("that cap is out of range"), not a broken screen.
        setError(
          caught instanceof Error
            ? caught.message
            : "Failed to save the budget",
        );
        throw caught;
      } finally {
        setIsSaving(false);
      }
    },
    [organizationId, setBudgetMutation],
  );

  const clearBudget = useCallback(async () => {
    if (!organizationId) return;
    setError(null);
    setIsSaving(true);
    try {
      await clearBudgetMutation({ organizationId } as any);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to clear the budget",
      );
      throw caught;
    } finally {
      setIsSaving(false);
    }
  }, [organizationId, clearBudgetMutation]);

  return {
    budget,
    isLoading: canQuery && budget === undefined,
    error,
    isSaving,
    setBudget,
    clearBudget,
  };
}

/** Credits (1¢ each) → a dollar string. */
export function creditsToUsdString(credits: number): string {
  return (credits / 100).toFixed(2);
}

/**
 * A dollar amount as typed → whole credits, or `null` when it is not a usable
 * number.
 *
 * `Number("")` is 0, which would read a cleared field as "cap this org at
 * zero" — so blank is rejected explicitly rather than coerced. Rounding is
 * to the nearest cent because the ledger debits whole credits; a cap of
 * $10.005 could never be exactly reached.
 */
export function usdStringToCredits(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}
