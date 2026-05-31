import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";

export type PendingCreditTopupStatus = "pending" | "failed";

export interface PendingCreditTopup {
  id: string;
  stripeSessionId: string;
  amountCents: number;
  status: PendingCreditTopupStatus;
  createdAt: number;
  updatedAt: number;
}

interface RawPendingTopup {
  id?: unknown;
  stripeSessionId?: unknown;
  amountCents?: unknown;
  status?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

const isValidStatus = (value: unknown): value is PendingCreditTopupStatus =>
  value === "pending" || value === "failed";

const normalizePending = (
  raw: unknown,
): PendingCreditTopup[] | undefined => {
  // Accept either a bare array or `{ items: [...] }`. Matches the loose-shape
  // convention used by useCreditTopup / useCreditBalance so the backend can
  // evolve without forcing a coordinated inspector PR.
  let items: unknown = raw;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "items" in raw
  ) {
    items = (raw as { items?: unknown }).items;
  }
  if (!Array.isArray(items)) return undefined;

  const out: PendingCreditTopup[] = [];
  for (const item of items as RawPendingTopup[]) {
    if (
      typeof item?.id !== "string" ||
      typeof item.stripeSessionId !== "string" ||
      typeof item.amountCents !== "number" ||
      !isValidStatus(item.status) ||
      typeof item.createdAt !== "number" ||
      typeof item.updatedAt !== "number"
    ) {
      continue;
    }
    out.push({
      id: item.id,
      stripeSessionId: item.stripeSessionId,
      amountCents: item.amountCents,
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  return out;
};

export interface UsePendingCreditTopupsResult {
  /** All pending + failed top-ups for the current user, newest first. */
  topups: PendingCreditTopup[] | undefined;
  /** Convenience subsets — undefined while loading, else possibly empty. */
  pending: PendingCreditTopup[] | undefined;
  failed: PendingCreditTopup[] | undefined;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function usePendingCreditTopups(): UsePendingCreditTopupsResult {
  const {
    isAuthenticated: hasConvexIdentity,
    isLoading: isConvexAuthLoading,
  } = useConvexAuth();
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const hasWorkOsUser = !!user;
  const isAuthLoading = isConvexAuthLoading || isWorkOsLoading;
  const shouldFetch =
    !isAuthLoading && hasConvexIdentity && hasWorkOsUser;

  const raw = useQuery(
    "billing/pendingCreditTopups:listForCurrentUser" as any,
    shouldFetch ? ({} as any) : "skip",
  ) as unknown | undefined;

  // Stable reference: Convex returns the same object when nothing has
  // changed, so memoizing on `raw` keeps the normalized array stable too.
  const topups = useMemo(() => normalizePending(raw), [raw]);

  const pending = useMemo(
    () => topups?.filter((t) => t.status === "pending"),
    [topups],
  );
  const failed = useMemo(
    () => topups?.filter((t) => t.status === "failed"),
    [topups],
  );

  const isLoading = isAuthLoading || (shouldFetch && raw === undefined);

  return {
    topups,
    pending,
    failed,
    isLoading,
    isAuthenticated: hasConvexIdentity,
  };
}
