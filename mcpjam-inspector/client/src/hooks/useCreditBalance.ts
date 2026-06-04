import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";

export interface CreditBalanceState {
  /** Shared credits currently available to the organization. */
  availableCredits: number;
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
   * Paid top-up credits still available, kept separate from the monthly
   * allowance (the allowance is spent first). Only set when monthly.
   */
  paidCreditsRemaining?: number;
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
    availableCredits: optionalNumber(r.availableCredits),
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
      r.monthlyAllowanceRemaining,
    ),
    monthlyResetAt: optionalNumberOrUndefined(r.monthlyResetAt) ?? null,
    paidCreditsRemaining: optionalNumberOrUndefined(r.paidCreditsRemaining),
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
