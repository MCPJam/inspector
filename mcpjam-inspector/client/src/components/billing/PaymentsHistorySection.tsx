import { useEffect, useMemo, useRef } from "react";
import {
  CheckCircle2,
  Clock,
  CircleAlert,
  ExternalLink,
  Undo2,
} from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { Badge } from "@mcpjam/design-system/badge";
import { Card, CardContent } from "@mcpjam/design-system/card";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import {
  usePaymentsHistory,
  type PaymentHistoryEntry,
} from "@/hooks/usePaymentsHistory";
import {
  useInvoiceHistory,
  type InvoiceHistoryEntry,
  type InvoiceLine,
} from "@/hooks/useInvoiceHistory";

const formatUsd = (cents: number, currency = "usd"): string => {
  const sign = cents < 0 ? "-" : "";
  const absoluteCents = Math.abs(cents);
  if (currency.toLowerCase() === "usd") {
    const dollars = absoluteCents / 100;
    const formatted = Number.isInteger(dollars)
      ? `$${dollars}`
      : `$${dollars.toFixed(2)}`;
    return `${sign}${formatted}`;
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${sign}$${(absoluteCents / 100).toFixed(2)}`;
  }
};

const formatDate = (epochMs: number): string => {
  try {
    return new Date(epochMs).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
};

function bucketEntryCount(count: number): string {
  if (count <= 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 20) return "6-20";
  return "20+";
}

const formatTeamSeatDelta = (delta: number): string => {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const seats = Math.abs(delta);
  return `${sign}${seats.toLocaleString()} Team ${
    seats === 1 ? "seat" : "seats"
  }`;
};

const extractTeamSeatQuantity = (line: InvoiceLine): number | null => {
  if (typeof line.quantity === "number" && Number.isFinite(line.quantity)) {
    return line.quantity;
  }
  const explicit = line.description.match(/(\d+)\s*[×x]\s*MCPJam Team/i);
  if (explicit) return Number(explicit[1]);
  return /MCPJam Team/i.test(line.description) ? 1 : null;
};

const isStripeProrationLine = (line: InvoiceLine): boolean =>
  /remaining time|unused time/i.test(line.description);

const isVisibleInvoice = (invoice: InvoiceHistoryEntry): boolean =>
  invoice.status !== "void";

const invoiceProratedSeatDelta = (
  invoice: InvoiceHistoryEntry
): number | null => {
  const prorationLines = invoice.lines.filter(isStripeProrationLine);
  if (prorationLines.length === 0) return null;

  const remaining = prorationLines.find((line) =>
    /remaining time/i.test(line.description)
  );
  const unused = prorationLines.find((line) =>
    /unused time/i.test(line.description)
  );
  const toSeats = remaining ? extractTeamSeatQuantity(remaining) : null;
  const fromSeats = unused ? extractTeamSeatQuantity(unused) : null;

  return toSeats !== null && fromSeats !== null ? toSeats - fromSeats : null;
};

function summarizeProratedInvoice(invoice: InvoiceHistoryEntry): string | null {
  if (invoice.status === "upcoming") {
    const line = invoice.lines[0];
    if (/prorated/i.test(line?.description ?? "")) {
      return line.description;
    }
  }

  if (!invoice.lines.some(isStripeProrationLine)) return null;

  const seatDelta = invoiceProratedSeatDelta(invoice);
  if (seatDelta !== null && seatDelta !== 0) {
    return `${formatTeamSeatDelta(seatDelta)} · prorated`;
  }

  return "Team seat change · prorated";
}

// One unified history row: either a credit top-up (from our ledger) or a Stripe
// invoice (subscription charge + mid-cycle seat prorations). Top-ups and
// invoices are distinct Stripe objects, so there's no double-counting.
type BillingRow =
  | { kind: "topup"; date: number; topup: PaymentHistoryEntry }
  | { kind: "invoice"; date: number; invoice: InvoiceHistoryEntry };

export function PaymentsHistorySection({
  organizationId,
  canViewHistory = false,
  canViewInvoices = false,
}: {
  organizationId?: string | null;
  /** Credit top-ups (reactive query). Gated on credit-manage rights. */
  canViewHistory?: boolean;
  /** Stripe invoices (on-demand action). Gated on billing-manage (owner). */
  canViewInvoices?: boolean;
}) {
  const { entries: topups, isLoading: topupsLoading } = usePaymentsHistory(
    canViewHistory ? organizationId : null
  );
  const {
    entries: invoices,
    upcoming,
    isLoading: invoicesLoading,
  } = useInvoiceHistory(canViewInvoices ? organizationId : null);
  const posthog = usePostHog();
  const viewedRef = useRef(false);

  const rows = useMemo<BillingRow[]>(() => {
    const merged: BillingRow[] = [
      ...(topups ?? []).map(
        (e): BillingRow => ({ kind: "topup", date: e.occurredAt, topup: e })
      ),
      ...(invoices ?? []).filter(isVisibleInvoice).map(
        (inv): BillingRow => ({
          kind: "invoice",
          date: inv.createdAt,
          invoice: inv,
        })
      ),
    ];
    merged.sort((a, b) => b.date - a.date);
    // Pin the projected next invoice to the very top.
    if (upcoming) {
      merged.unshift({
        kind: "invoice",
        date: upcoming.createdAt,
        invoice: upcoming,
      });
    }
    return merged;
  }, [topups, invoices, upcoming]);

  const isLoading =
    (canViewHistory && topupsLoading) || (canViewInvoices && invoicesLoading);

  // Fire the (top-up) view event once per mount when rows first load and aren't
  // empty. Ref guard defeats StrictMode double-mount and the auth-resolve
  // re-render that flips isLoading false.
  useEffect(() => {
    if (viewedRef.current) return;
    if (isLoading) return;
    if (rows.length === 0) return;
    viewedRef.current = true;
    const topupList = topups ?? [];
    posthog?.capture("credit_topup_history_viewed", {
      entry_count_bucket: bucketEntryCount(topupList.length),
      has_failed: topupList.some((e) => e.status === "failed"),
      has_pending: topupList.some((e) => e.status === "pending"),
    });
  }, [isLoading, posthog, rows, topups]);

  if (!canViewHistory && !canViewInvoices) return null;

  return (
    <Card className="border-border/60 py-6 shadow-sm">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Payment history</h2>
        </div>
        {isLoading ? (
          <LoadingRows />
        ) : rows.length === 0 ? (
          <EmptyState />
        ) : (
          <PaymentsTable rows={rows} />
        )}
      </CardContent>
    </Card>
  );
}

function PaymentsTable({ rows }: { rows: BillingRow[] }) {
  return (
    <div data-testid="payments-history-table">
      {/* Desktop: real table at sm+. Cap visible height; older rows scroll
       * inside the card so the section never balloons. */}
      <div className="hidden sm:block max-h-[280px] overflow-y-auto rounded-md border border-border/40">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Credits</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Receipt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) =>
              row.kind === "topup" ? (
                <TopupTableRow
                  key={`t_${row.topup.sessionId}`}
                  entry={row.topup}
                />
              ) : (
                <InvoiceTableRow
                  key={`i_${row.invoice.id}`}
                  invoice={row.invoice}
                />
              )
            )}
          </TableBody>
        </Table>
      </div>
      {/* Mobile: stacked rows. Same height cap as desktop. */}
      <div className="flex flex-col gap-3 sm:hidden max-h-[400px] overflow-y-auto">
        {rows.map((row) =>
          row.kind === "topup" ? (
            <TopupMobileRow
              key={`tm_${row.topup.sessionId}`}
              entry={row.topup}
            />
          ) : (
            <InvoiceMobileRow
              key={`im_${row.invoice.id}`}
              invoice={row.invoice}
            />
          )
        )}
      </div>
    </div>
  );
}

function TopupTableRow({ entry }: { entry: PaymentHistoryEntry }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-sm">
        {formatDate(entry.occurredAt)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm tabular-nums">
        {formatUsd(entry.pricePaidCents)}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        {entry.displayCredits}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {entry.details}
      </TableCell>
      <TableCell>
        <StatusBadge entry={entry} />
      </TableCell>
      <TableCell className="text-right">
        <ReceiptCell entry={entry} />
      </TableCell>
    </TableRow>
  );
}

function invoiceAmountCents(invoice: InvoiceHistoryEntry): number {
  return typeof invoice.totalCents === "number"
    ? invoice.totalCents
    : invoice.amountPaidCents || invoice.amountDueCents;
}

function InvoiceTableRow({ invoice }: { invoice: InvoiceHistoryEntry }) {
  const amount = invoiceAmountCents(invoice);
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap align-top text-sm">
        {formatDate(invoice.createdAt)}
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm tabular-nums">
        {formatUsd(amount, invoice.currency)}
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm text-muted-foreground">
        —
      </TableCell>
      <TableCell className="align-top text-sm">
        <InvoiceLines invoice={invoice} />
      </TableCell>
      <TableCell className="align-top">
        <InvoiceStatusBadge status={invoice.status} />
      </TableCell>
      <TableCell className="text-right align-top">
        <InvoiceReceiptCell invoice={invoice} />
      </TableCell>
    </TableRow>
  );
}

// Stripe writes plan lines verbosely, e.g. "1 × MCPJam Team (at $360.00 / year)".
// Keep the quantity, drop the "(at $X / interval)" parenthetical, and surface
// the cadence as a clean word.
function cleanLineDescription(desc: string): string {
  const cadence = /\/\s*year/i.test(desc)
    ? " · Annual"
    : /\/\s*month/i.test(desc)
    ? " · Monthly"
    : "";
  // Keep the "N × " quantity prefix (it shows how many seats are billed); only
  // drop the verbose "(at $X / interval)" pricing parenthetical.
  const name = desc.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return `${name}${cadence}`;
}

function InvoiceLines({ invoice }: { invoice: InvoiceHistoryEntry }) {
  const summary = summarizeProratedInvoice(invoice);
  if (summary) {
    return <span>{summary}</span>;
  }
  if (invoice.lines.length === 0) {
    return <span className="text-muted-foreground">Subscription</span>;
  }
  // Single line (just the plan charge): the Amount column already shows the
  // total, so don't repeat it. Break amounts out only for multi-line invoices
  // (plan + seat prorations), where the split is the useful part.
  const showLineAmounts = invoice.lines.length > 1;
  return (
    <div className="flex flex-col gap-0.5">
      {invoice.lines.map((line, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className="truncate text-foreground">
            {cleanLineDescription(line.description)}
          </span>
          {showLineAmounts ? (
            <span className="tabular-nums text-muted-foreground">
              {formatUsd(line.amountCents, invoice.currency)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function TopupMobileRow({ entry }: { entry: PaymentHistoryEntry }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between text-sm">
        <span>{formatDate(entry.occurredAt)}</span>
        <span className="tabular-nums font-medium">
          {formatUsd(entry.pricePaidCents)}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {entry.displayCredits}
      </div>
      <div className="text-xs text-muted-foreground">{entry.details}</div>
      <div className="flex items-center justify-between">
        <StatusBadge entry={entry} />
        <ReceiptCell entry={entry} />
      </div>
    </div>
  );
}

function InvoiceMobileRow({ invoice }: { invoice: InvoiceHistoryEntry }) {
  const amount = invoiceAmountCents(invoice);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between text-sm">
        <span>{formatDate(invoice.createdAt)}</span>
        <span className="tabular-nums font-medium">
          {formatUsd(amount, invoice.currency)}
        </span>
      </div>
      <InvoiceLines invoice={invoice} />
      <div className="flex items-center justify-between">
        <InvoiceStatusBadge status={invoice.status} />
        <InvoiceReceiptCell invoice={invoice} />
      </div>
    </div>
  );
}

function InvoiceStatusBadge({ status }: { status: string }) {
  if (status === "upcoming") {
    return (
      <Badge
        variant="outline"
        className="border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900/50 dark:bg-sky-950/40 dark:text-sky-100"
      >
        <Clock aria-hidden="true" />
        Upcoming
      </Badge>
    );
  }
  if (status === "paid") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100"
      >
        <CheckCircle2 aria-hidden="true" />
        Paid
      </Badge>
    );
  }
  if (status === "open" || status === "draft") {
    return (
      <Badge
        variant="outline"
        className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <Clock aria-hidden="true" />
        <span className="capitalize">{status}</span>
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <CircleAlert aria-hidden="true" />
      <span className="capitalize">{status}</span>
    </Badge>
  );
}

function InvoiceReceiptCell({ invoice }: { invoice: InvoiceHistoryEntry }) {
  const url = invoice.hostedInvoiceUrl ?? invoice.invoicePdfUrl;
  if (!url) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
      data-ph-no-capture
      className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
    >
      View invoice
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

function StatusBadge({ entry }: { entry: PaymentHistoryEntry }) {
  const { status } = entry;
  if (status === "succeeded") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100"
      >
        <CheckCircle2 aria-hidden="true" />
        Paid
      </Badge>
    );
  }
  if (status === "pending") {
    return (
      <Badge
        variant="outline"
        className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <Clock aria-hidden="true" />
        Pending
      </Badge>
    );
  }
  if (status === "pending_refund") {
    return (
      <Badge
        variant="outline"
        className="border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <Clock aria-hidden="true" />
        Refund pending
      </Badge>
    );
  }
  if (status === "credited" || status === "refunded_and_credited") {
    return (
      <Badge
        variant="outline"
        className="border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-200"
      >
        <Undo2 aria-hidden="true" />
        {status === "credited" ? "Credited" : "Refunded + credited"}
      </Badge>
    );
  }
  if (status === "refunded" || status === "partially_refunded") {
    const isPartial = status === "partially_refunded";
    // Hover detail like "$3 of $5 refunded" when we know the reversed amount.
    const detail =
      entry.pricePaidCents > 0 && typeof entry.reversedPaidCents === "number"
        ? `${formatUsd(entry.reversedPaidCents)} of ${formatUsd(
            entry.pricePaidCents
          )} refunded`
        : undefined;
    return (
      <Badge
        variant="outline"
        className="border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-200"
      >
        <Undo2 aria-hidden="true" />
        <span title={detail}>
          {isPartial ? "Partially refunded" : "Refunded"}
        </span>
      </Badge>
    );
  }
  if (status === "disputed") {
    return (
      <Badge variant="destructive">
        <CircleAlert aria-hidden="true" />
        Disputed
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <CircleAlert aria-hidden="true" />
      Failed
    </Badge>
  );
}

function ReceiptCell({ entry }: { entry: PaymentHistoryEntry }) {
  const posthog = usePostHog();

  if (entry.receiptUrl) {
    const ageDays = Math.max(
      0,
      Math.round((Date.now() - entry.occurredAt) / (24 * 60 * 60 * 1000))
    );
    return (
      <a
        href={entry.receiptUrl}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        data-ph-no-capture
        aria-label={`View receipt for ${formatDate(
          entry.occurredAt
        )} payment (opens in new tab)`}
        className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
        onClick={() => {
          posthog?.capture("credit_topup_receipt_opened", {
            entry_age_days: ageDays,
          });
        }}
      >
        View receipt
        <ExternalLink aria-hidden="true" className="size-3.5" />
        <span className="sr-only">(opens in new tab)</span>
      </a>
    );
  }

  // No URL: distinguish the three cases so a succeeded-without-URL row
  // doesn't read the same as a failed row (which legitimately has no receipt).
  const muted = "text-sm text-muted-foreground";
  if (entry.status === "succeeded") {
    return <span className={muted}>Not available</span>;
  }
  if (entry.status === "pending") {
    return <span className={muted}>Processing</span>;
  }
  return <span className={muted}>—</span>;
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center rounded-md border border-dashed border-border/60 py-8 text-center"
      data-testid="payments-history-empty"
    >
      <p className="text-sm text-muted-foreground">No payments yet.</p>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2" data-testid="payments-history-loading">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
