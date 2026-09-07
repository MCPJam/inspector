import { useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useOrgScopedWrite } from "@/hooks/useOrgScopedWrite";

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
  /**
   * The actor is RESOLVED and is not a member — a guest, whose organization is
   * personal and cannot carry a budget. The query will never run for them.
   *
   * `isMember === false` specifically, NOT `!isMember`. The hook returns
   * `undefined` while auth is still settling and while the current-user query
   * is in flight, which is an ordinary hosted cold load. Folding that into
   * "guest" would tell a real admin their organization is personal for the
   * moment it takes to find out otherwise — a confident wrong answer, which is
   * worse than the spinner it replaced.
   */
  const actorIsGuest = isMember === false;

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

  /**
   * The shared org-write wrapper, not a fourth hand-rolled copy.
   *
   * It does two things this hook needs and got wrong on its own: it retires a
   * write whose organization changed mid-flight, so a refusal cannot land on
   * a page about a different org; and it extracts the message from a
   * `ConvexError`'s structured payload. Convex redacts a plain thrown Error's
   * message to "Server Error" in production, so reading `.message` showed
   * every deliberate refusal — "that cap is out of range", "admins only" —
   * as a generic failure, which is the opposite of what an admin needs.
   *
   * It records the failure and then RE-THROWS, so a call site that fires and
   * forgets must still attach a rejection handler — the inline error is the
   * user-visible answer, and the throw is for a caller that needs to branch.
   */
  const { error, isSaving, run } = useOrgScopedWrite(organizationId ?? null);

  const setBudget = useCallback(
    async (input: { capCredits: number; alertPercents?: number[] }) => {
      if (!organizationId) return;
      await run(() => setBudgetMutation({ organizationId, ...input } as any));
    },
    [organizationId, run, setBudgetMutation],
  );

  const clearBudget = useCallback(async () => {
    if (!organizationId) return;
    await run(() => clearBudgetMutation({ organizationId } as any));
  }, [organizationId, run, clearBudgetMutation]);

  return {
    budget,
    /**
     * An answer is still coming.
     *
     * Covers BOTH "the actor is still settling" and "the query is in flight",
     * because from the caller's side those are the same state: wait. Only a
     * resolved guest is excluded, and `querySkipped` names that case.
     */
    isLoading: !actorIsGuest && budget === undefined,
    /**
     * Nobody asked, and nobody will: the actor is a guest. A caller that
     * renders a spinner on `budget === undefined` alone must check this first,
     * or it spins forever on the one audience with a real answer waiting.
     */
    querySkipped: actorIsGuest,
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
 *
 * WORKS ON THE DIGITS, not on a float. `Math.round(1.005 * 100)` is 100, not
 * 101, because binary float64 has no exact 1.005 — it holds
 * 1.00499999999999989, so the product lands just under the half-cent and
 * rounds down. The typed STRING is the only place the decimal the person
 * meant still exists, so the cents are read off it directly and the
 * half-cent is decided on the digit rather than on the float.
 */
export function usdStringToCredits(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // Reject anything that is not a plain decimal before touching the digits:
  // exponent forms have no fixed cent position to read.
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    // Not plain-decimal (a sign, an exponent, or junk). `Number` still
    // decides validity, and a negative or non-finite value is refused.
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed * 100);
  }
  const whole = match[1] === "" ? "0" : match[1];
  const fraction = match[2] ?? "";
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isFinite(cents)) return null;
  // The third decimal decides the half-cent, exactly as written.
  const roundUp = (fraction[2] ?? "0") >= "5";
  return cents + (roundUp ? 1 : 0);
}
