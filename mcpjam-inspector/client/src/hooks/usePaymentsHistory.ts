import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { useMemo } from "react";

export type PaymentHistoryStatus =
  | "succeeded"
  | "pending"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "disputed";

export type PaymentHistoryKind = "credit_topup" | "team_plan";

export interface PaymentHistoryEntry {
  id: string;
  sessionId: string;
  kind: PaymentHistoryKind;
  pricePaidCents: number;
  displayCredits: string;
  description: string;
  amountSubtitle?: string;
  /** Paid cents handed back when refunded/charged back. Reversed rows only. */
  reversedPaidCents?: number;
  status: PaymentHistoryStatus;
  occurredAt: number;
  receiptUrl?: string;
}

interface RawEntry {
  id?: unknown;
  sessionId?: unknown;
  kind?: unknown;
  pricePaidCents?: unknown;
  displayCredits?: unknown;
  description?: unknown;
  amountSubtitle?: unknown;
  reversedPaidCents?: unknown;
  status?: unknown;
  occurredAt?: unknown;
  receiptUrl?: unknown;
}

const VALID_STATUSES = new Set<PaymentHistoryStatus>([
  "succeeded",
  "pending",
  "failed",
  "refunded",
  "partially_refunded",
  "disputed",
]);

const isValidStatus = (value: unknown): value is PaymentHistoryStatus =>
  typeof value === "string" &&
  VALID_STATUSES.has(value as PaymentHistoryStatus);

const isValidKind = (value: unknown): value is PaymentHistoryKind =>
  value === "credit_topup" || value === "team_plan";

const normalize = (raw: unknown): PaymentHistoryEntry[] | undefined => {
  // Accept either a bare array or `{ items: [...] }`. Loose-shape parsing
  // matches the rest of the billing hooks so the backend can evolve without
  // forcing a coordinated inspector PR.
  let items: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "items" in raw) {
    items = (raw as { items?: unknown }).items;
  }
  if (!Array.isArray(items)) return undefined;

  const out: PaymentHistoryEntry[] = [];
  for (const item of items as RawEntry[]) {
    if (
      typeof item?.id !== "string" ||
      typeof item.sessionId !== "string" ||
      typeof item.pricePaidCents !== "number" ||
      typeof item.displayCredits !== "string" ||
      !isValidStatus(item.status) ||
      typeof item.occurredAt !== "number"
    ) {
      continue;
    }
    const kind = isValidKind(item.kind) ? item.kind : "credit_topup";
    const amountSubtitle =
      typeof item.amountSubtitle === "string" && item.amountSubtitle.length > 0
        ? item.amountSubtitle
        : undefined;
    out.push({
      id: item.id,
      sessionId: item.sessionId,
      kind,
      pricePaidCents: item.pricePaidCents,
      displayCredits: item.displayCredits,
      description:
        typeof item.description === "string" && item.description.length > 0
          ? item.description
          : kind === "team_plan"
            ? "Team plan included credits"
            : "Credit top-up",
      ...(amountSubtitle ? { amountSubtitle } : {}),
      status: item.status,
      occurredAt: item.occurredAt,
      ...(typeof item.reversedPaidCents === "number"
        ? { reversedPaidCents: item.reversedPaidCents }
        : {}),
      ...(typeof item.receiptUrl === "string" && item.receiptUrl.length > 0
        ? { receiptUrl: item.receiptUrl }
        : {}),
    });
  }
  return out;
};

export interface UsePaymentsHistoryResult {
  entries: PaymentHistoryEntry[] | undefined;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export function usePaymentsHistory(
  organizationId?: string | null
): UsePaymentsHistoryResult {
  const { isAuthenticated: hasConvexIdentity, isLoading: isConvexAuthLoading } =
    useConvexAuth();
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const hasWorkOsUser = !!user;
  const isAuthLoading = isConvexAuthLoading || isWorkOsLoading;
  const shouldFetch =
    !isAuthLoading && hasConvexIdentity && hasWorkOsUser && !!organizationId;

  const raw = useQuery(
    "billing/creditHistory:listTopupHistoryForOrganization" as any,
    shouldFetch ? ({ organizationId } as any) : "skip"
  ) as unknown | undefined;

  // Stable reference: Convex returns the same object when nothing has
  // changed, so memoizing on `raw` keeps the normalized array stable too.
  const entries = useMemo(() => normalize(raw), [raw]);

  const isLoading = isAuthLoading || (shouldFetch && raw === undefined);
  // Reflect the same gate the fetch uses (convex identity AND workos user)
  // so consumers don't see `isAuthenticated=true` while the query is
  // skipped because the workos side hasn't resolved.
  const isAuthenticated = hasConvexIdentity && hasWorkOsUser;

  return {
    entries,
    isLoading,
    isAuthenticated,
  };
}
