import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";
import { HOSTED_MODE } from "@/lib/config";

export interface CreditBalanceState {
  /**
   * 0-100. Percent of the user's credited pool still remaining. The bar
   * renders `100 - paidPercentRemaining` as "% used". Backend computes
   * the percent so the inspector never sees the dollar denominator.
   */
  paidPercentRemaining: number | null;
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
}

const clampPercent = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
};

const optionalPercent = (value: unknown): number | null => {
  if (value == null) return null;
  return clampPercent(value);
};

const optionalNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeBalance = (raw: unknown): CreditBalanceState | undefined => {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  // Accept either an explicit `hasPurchaseHistory: boolean` (preferred, new
  // backend shape) or fall back to the legacy `lifetimePurchasedCents > 0`
  // signal. Either is enough to know the user has topped up at least once.
  // We DO NOT store the dollar value, so the inspector can't accidentally
  // surface it.
  const hasPurchaseHistory =
    r.hasPurchaseHistory === true ||
    (typeof r.lifetimePurchasedCents === "number" &&
      Number.isFinite(r.lifetimePurchasedCents) &&
      r.lifetimePurchasedCents > 0);
  return {
    paidPercentRemaining: optionalPercent(r.paidPercentRemaining),
    hasPurchaseHistory,
    freeDailyPercentUsed: clampPercent(r.freeDailyPercentUsed),
    freeDailyResetAt: optionalNumber(r.freeDailyResetAt),
  };
};

interface UseCreditBalanceOptions {
  includeGuests?: boolean;
}

export function useCreditBalance({
  includeGuests = false,
}: UseCreditBalanceOptions = {}) {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const shouldFetchBalance =
    !isAuthLoading && (isAuthenticated || includeGuests || HOSTED_MODE);
  const raw = useQuery(
    "billing:getCreditBalance" as any,
    shouldFetchBalance ? ({} as any) : "skip"
  ) as unknown | undefined;
  // Memoize on the raw query reference. Convex returns a stable reference
  // when the underlying data is unchanged, so the normalized object stays
  // referentially stable across renders. Keeps downstream effects/memos
  // that depend on `balance` from re-running when nothing actually changed.
  const balance = useMemo(() => normalizeBalance(raw), [raw]);
  // Treat the bootstrap window as loading so the card shows a skeleton
  // instead of flashing an empty zero state before the query resolves.
  const isLoading = isAuthLoading || (shouldFetchBalance && raw === undefined);
  return { balance, isLoading, isAuthenticated };
}
