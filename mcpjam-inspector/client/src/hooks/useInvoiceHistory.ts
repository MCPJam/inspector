import { useAction, useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { useEffect, useState } from "react";

export interface InvoiceLine {
  description: string;
  amountCents: number;
  quantity?: number;
}

export interface InvoiceHistoryEntry {
  id: string;
  number?: string;
  createdAt: number;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  hostedInvoiceUrl?: string;
  invoicePdfUrl?: string;
  lines: InvoiceLine[];
}

const normalizeEntry = (raw: unknown): InvoiceHistoryEntry | null => {
  const it = raw as Record<string, unknown> | null;
  if (!it || typeof it.id !== "string" || typeof it.createdAt !== "number") {
    return null;
  }
  const rawLines = Array.isArray(it.lines) ? it.lines : [];
  return {
    id: it.id,
    number: typeof it.number === "string" ? it.number : undefined,
    createdAt: it.createdAt,
    status: typeof it.status === "string" ? it.status : "open",
    amountDueCents:
      typeof it.amountDueCents === "number" ? it.amountDueCents : 0,
    amountPaidCents:
      typeof it.amountPaidCents === "number" ? it.amountPaidCents : 0,
    currency: typeof it.currency === "string" ? it.currency : "usd",
    hostedInvoiceUrl:
      typeof it.hostedInvoiceUrl === "string" ? it.hostedInvoiceUrl : undefined,
    invoicePdfUrl:
      typeof it.invoicePdfUrl === "string" ? it.invoicePdfUrl : undefined,
    lines: (rawLines as Record<string, unknown>[]).map((l) => ({
      description: typeof l?.description === "string" ? l.description : "",
      amountCents: typeof l?.amountCents === "number" ? l.amountCents : 0,
      quantity: typeof l?.quantity === "number" ? l.quantity : undefined,
    })),
  };
};

// Accept `{ invoices: [...] }` or a bare array — loose parsing mirrors the
// other billing hooks so the backend shape can evolve independently.
const normalizeList = (raw: unknown): InvoiceHistoryEntry[] => {
  let items: unknown = raw;
  if (
    raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "invoices" in raw
  ) {
    items = (raw as { invoices?: unknown }).invoices;
  }
  if (!Array.isArray(items)) return [];
  const out: InvoiceHistoryEntry[] = [];
  for (const it of items) {
    const entry = normalizeEntry(it);
    if (entry) out.push(entry);
  }
  return out;
};

const normalizeUpcoming = (raw: unknown): InvoiceHistoryEntry | null => {
  if (raw && typeof raw === "object" && "upcoming" in raw) {
    return normalizeEntry((raw as { upcoming?: unknown }).upcoming);
  }
  return null;
};

export interface UseInvoiceHistoryResult {
  entries: InvoiceHistoryEntry[] | undefined;
  /** Projected next invoice (pending seat prorations), null when none. */
  upcoming: InvoiceHistoryEntry | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches recent Stripe invoices + the upcoming-invoice preview on demand (not
 * reactive — invoices live in Stripe, so this is an action call when the billing
 * page mounts). Pass a null organizationId to skip (e.g. when the viewer can't
 * manage billing).
 */
export function useInvoiceHistory(
  organizationId?: string | null,
): UseInvoiceHistoryResult {
  const { isAuthenticated, isLoading: isConvexAuthLoading } = useConvexAuth();
  const { user, isLoading: isWorkOsLoading } = useAuth();
  const listInvoices = useAction("billing:listOrganizationInvoices" as any);

  const [entries, setEntries] = useState<InvoiceHistoryEntry[] | undefined>(
    undefined,
  );
  const [upcoming, setUpcoming] = useState<InvoiceHistoryEntry | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shouldFetch =
    !isConvexAuthLoading &&
    !isWorkOsLoading &&
    isAuthenticated &&
    !!user &&
    !!organizationId;

  useEffect(() => {
    if (!shouldFetch || !organizationId) {
      setEntries(undefined);
      setUpcoming(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    listInvoices({ organizationId })
      .then((res: unknown) => {
        if (cancelled) return;
        setEntries(normalizeList(res));
        setUpcoming(normalizeUpcoming(res));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setEntries([]);
        setUpcoming(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shouldFetch, organizationId, listInvoices]);

  return { entries, upcoming, isLoading, error };
}
