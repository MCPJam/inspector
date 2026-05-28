import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useMemo } from "react";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

export interface CreditBalanceState {
  /** Shared paid top-up credits currently available to the organization. */
  paidCreditsRemaining: number;
  /**
   * Whether the user has ever topped up. Used to gate paid-bar
   * visibility. Boolean-only — we deliberately don't expose the
   * underlying dollar amount.
   */
  hasPurchaseHistory: boolean;
  /**
   * 0-100. Percent of today's free quota that's been consumed. Backend
   * computes from rate-limiter bucket state — no client-side dollar
   * denominator.
   */
  freeDailyPercentUsed: number;
  /** Epoch ms when the daily bucket resets. */
  freeDailyResetAt: number;
  /** Free daily credits still available today (1 credit = 1¢). */
  freeDailyCreditsRemaining: number;
  /** Total free daily credit allowance for the day (e.g. 300 signed-in, 20 guest). */
  freeDailyCreditsTotal: number;
  /** Whether org credit spending is paused for manual review. */
  walletLocked: boolean;
  /**
   * Which credit model the server is billing this org against. "daily" is the
   * free per-day bucket (free orgs + guests); "monthly_per_seat" is the team
   * monthly allowance. Absent/unknown is treated as "daily".
   */
  billingModel: "daily" | "monthly_per_seat";
  /** Team monthly allowance granted this period. Only set when monthly. */
  monthlyAllowanceTotal?: number;
  /** Team monthly allowance still available this period. Only set when monthly. */
  monthlyAllowanceRemaining?: number;
  /** Epoch ms when the monthly allowance resets. Only set when monthly. */
  monthlyResetAt?: number | null;
  /**
   * Seconds of voice transcription the user can still afford today.
   * Derived on the backend from remaining cents at Whisper-1 pricing so the
   * client never sees the dollar amount. 0 means the mic should be disabled.
   */
  voiceSecondsRemaining: number;
}

const clampPercent = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
};

const optionalNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

// Returns the number when present and finite, otherwise undefined. Used for
// the monthly fields so an absent value stays undefined (distinguishable from
// a real 0 allowance) and the renderer can skip cleanly.
const optionalNumberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeBalance = (raw: unknown): CreditBalanceState | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    paidCreditsRemaining: optionalNumber(r.paidCreditsRemaining),
    hasPurchaseHistory: r.hasPurchaseHistory === true,
    freeDailyPercentUsed: clampPercent(r.freeDailyPercentUsed),
    freeDailyResetAt: optionalNumber(r.freeDailyResetAt),
    freeDailyCreditsRemaining: optionalNumber(r.freeDailyCreditsRemaining),
    freeDailyCreditsTotal: optionalNumber(r.freeDailyCreditsTotal),
    walletLocked: r.walletLocked === true,
    // Discriminant: only the explicit "monthly_per_seat" opts into the monthly
    // view; anything else (including absent) falls back to daily.
    billingModel:
      r.billingModel === "monthly_per_seat" ? "monthly_per_seat" : "daily",
    monthlyAllowanceTotal: optionalNumberOrUndefined(r.monthlyAllowanceTotal),
    monthlyAllowanceRemaining: optionalNumberOrUndefined(
      r.monthlyAllowanceRemaining
    ),
    monthlyResetAt: optionalNumberOrUndefined(r.monthlyResetAt) ?? null,
    voiceSecondsRemaining: Math.max(0, optionalNumber(r.voiceSecondsRemaining)),
  };
};

interface UseCreditBalanceOptions {
  organizationId?: string | null;
  includeGuests?: boolean;
  enabled?: boolean;
}

export function useCreditBalance({
  organizationId,
  includeGuests = false,
  enabled = true,
}: UseCreditBalanceOptions = {}) {
  const { isAuthenticated: hasConvexIdentity, isLoading: isConvexAuthLoading } =
    useConvexAuth();
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const hasWorkOsUser = !!user;
  const isAuthLoading = isConvexAuthLoading || isWorkOsLoading;
  const shouldFetchBalance =
    enabled &&
    !isAuthLoading &&
    hasConvexIdentity &&
    (hasWorkOsUser ? !!organizationId : includeGuests);
  const queryArgs = organizationId ? { organizationId } : {};
  const raw = useQuery(
    "billing:getCreditBalance" as any,
    shouldFetchBalance ? (queryArgs as any) : "skip"
  ) as unknown | undefined;
  // Memoize on the raw query reference. Convex returns a stable reference
  // when the underlying data is unchanged, so the normalized object stays
  // referentially stable across renders. Keeps downstream effects/memos
  // that depend on `balance` from re-running when nothing actually changed.
  const balance = useMemo(() => normalizeBalance(raw), [raw]);
  // Treat the bootstrap window as loading so the card shows a skeleton
  // instead of flashing an empty zero state before the query resolves.
  const isLoading =
    enabled && (isAuthLoading || (shouldFetchBalance && raw === undefined));
  return {
    balance,
    isLoading,
    isAuthenticated: hasConvexIdentity,
    hasWorkOsUser,
  };
}

/**
 * True when the org (or guest) has no spendable MCPJam credits left — the
 * state that makes MCPJam-provided ("free") models unusable. Mirrors the
 * sidebar's daily-vs-monthly split: monthly teams spend their monthly
 * allowance then shared paid top-ups; everyone else spends the free daily
 * bucket then paid top-ups. Wallet-lock (spending paused for review) is
 * deliberately NOT folded in here — that's a separate state with its own
 * backend handling.
 */
export function isOutOfCredits(
  balance: CreditBalanceState | undefined
): boolean {
  if (!balance) return false;
  const paidRemaining = balance.paidCreditsRemaining;
  if (balance.billingModel === "monthly_per_seat") {
    return (balance.monthlyAllowanceRemaining ?? 0) <= 0 && paidRemaining <= 0;
  }
  return balance.freeDailyCreditsRemaining <= 0 && paidRemaining <= 0;
}

/**
 * Convenience hook over useCreditBalance that returns just the "out of
 * credits" boolean for the active organization — used to gray out
 * MCPJam-provided models in the picker once the org/guest can no longer
 * spend. Resolves the org from the caller-provided id, falling back to the
 * stored active organization (the same source the limit dialog uses).
 * Also honors the local limit-hit latch set by failed sends so the picker
 * locks immediately instead of waiting for the balance query to catch up.
 */
export function useOutOfCredits(organizationId?: string | null): boolean {
  const { user } = useAuth();
  const resolvedOrganizationId =
    organizationId ?? (user ? readStoredActiveOrganizationId(user.id) : null);
  const { balance } = useCreditBalance({
    organizationId: resolvedOrganizationId,
    includeGuests: true,
  });
  const balanceOutOfCredits = isOutOfCredits(balance);
  const outOfCreditsHit = useMCPJamLimitDialogStore(
    (state) => state.outOfCreditsHit
  );
  const locallyLimited = useMCPJamLimitDialogStore((state) => {
    if (!state.outOfCreditsHit) return false;
    if (!state.outOfCreditsOrganizationId) return true;
    if (!resolvedOrganizationId) return true;
    return state.outOfCreditsOrganizationId === resolvedOrganizationId;
  });
  const clearOutOfCreditsHit = useMCPJamLimitDialogStore(
    (state) => state.clearOutOfCreditsHit
  );

  useEffect(() => {
    if (!outOfCreditsHit || !balanceOutOfCredits) return;
    clearOutOfCreditsHit(resolvedOrganizationId ?? null);
  }, [
    balanceOutOfCredits,
    clearOutOfCreditsHit,
    outOfCreditsHit,
    resolvedOrganizationId,
  ]);

  return balanceOutOfCredits || locallyLimited;
}
