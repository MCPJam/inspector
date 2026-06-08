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
import {
  useCreditActivity,
  type CreditActivityEntry,
} from "@/hooks/useCreditActivity";

const formatUsd = (cents: number, currency = "usd"): string => {
  if (currency.toLowerCase() === "usd") {
    const sign = cents < 0 ? "-" : "";
    const dollars = Math.abs(cents) / 100;
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
    return `$${(cents / 100).toFixed(2)}`;
  }
};

const formatCreditAmount = (credits: number): string => {
  const sign = credits > 0 ? "+" : credits < 0 ? "-" : "";
  return `${sign}${Math.abs(credits).toLocaleString()}`;
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

const CREDIT_GRANT_INVOICE_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

const isVisibleInvoice = (invoice: InvoiceHistoryEntry): boolean =>
  invoice.status !== "void";

const invoiceAmountCents = (invoice: InvoiceHistoryEntry): number => {
  if (typeof invoice.totalCents === "number") return invoice.totalCents;
  return invoice.amountPaidCents || invoice.amountDueCents;
};

const formatInvoiceAmount = (amountCents: number, currency = "usd"): string => {
  if (amountCents < 0) {
    return `${formatUsd(Math.abs(amountCents), currency)} credit`;
  }
  return formatUsd(amountCents, currency);
};

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

  const prorationLines = invoice.lines.filter(isStripeProrationLine);
  if (prorationLines.length === 0) return null;

  const seatDelta = invoiceProratedSeatDelta(invoice);
  if (seatDelta !== null && seatDelta !== 0) {
    return `${formatTeamSeatDelta(seatDelta)} · prorated`;
  }

  const amount = invoiceAmountCents(invoice);
  if (amount > 0) return "Team seat change · prorated";
  if (amount < 0) return "Team seat credit · prorated";
  return "Team seat change · prorated";
}

const creditActivityDetail = (entry: CreditActivityEntry): string => {
  if (typeof entry.seatDelta === "number") {
    const prorated = /prorated/i.test(entry.label) ? " · prorated" : "";
    return `${formatTeamSeatDelta(entry.seatDelta)}${prorated}`;
  }
  return entry.label || "Credit activity";
};

type BillingRow =
  | { kind: "topup"; date: number; topup: PaymentHistoryEntry }
  | {
      kind: "invoice";
      date: number;
      invoice: InvoiceHistoryEntry;
      creditActivity: CreditActivityEntry[];
    }
  | { kind: "credit"; date: number; credit: CreditActivityEntry };

type InvoiceBillingRow = Extract<BillingRow, { kind: "invoice" }>;

const sumCredits = (entries: CreditActivityEntry[]): number | null => {
  const total = entries.reduce((sum, entry) => sum + entry.amountCredits, 0);
  return total === 0 ? null : total;
};

const topupCreditAmount = (entry: PaymentHistoryEntry): number | null => {
  const match = entry.displayCredits.replace(/,/g, "").match(/\d+/);
  if (!match) return null;
  return Number(match[0]);
};

const shouldAttachCreditActivityToInvoice = (
  entry: CreditActivityEntry,
  row: InvoiceBillingRow
): boolean => {
  if (row.invoice.status !== "paid") return false;

  const distance = Math.abs(row.invoice.createdAt - entry.createdAt);
  if (distance > CREDIT_GRANT_INVOICE_MATCH_WINDOW_MS) return false;

  const invoiceSeatDelta = invoiceProratedSeatDelta(row.invoice);
  if (typeof entry.seatDelta === "number") {
    return invoiceSeatDelta === entry.seatDelta;
  }

  return true;
};

const findMatchingInvoiceRow = (
  entry: CreditActivityEntry,
  invoiceRows: InvoiceBillingRow[],
  matchedInvoiceIds: Set<string>
): InvoiceBillingRow | null => {
  let best: InvoiceBillingRow | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of invoiceRows) {
    if (matchedInvoiceIds.has(row.invoice.id)) continue;
    if (!shouldAttachCreditActivityToInvoice(entry, row)) continue;
    const distance = Math.abs(row.invoice.createdAt - entry.createdAt);
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
};

export function PaymentsHistorySection({
  organizationId,
  canViewHistory = false,
  canViewInvoices = false,
  canViewCreditActivity = false,
}: {
  organizationId?: string | null;
  /** Credit top-ups (reactive query). Gated on credit-manage rights. */
  canViewHistory?: boolean;
  /** Stripe invoices (on-demand action). Gated on billing-manage (owner). */
  canViewInvoices?: boolean;
  /** Credit ledger activity (allowance grants / claw-backs). */
  canViewCreditActivity?: boolean;
}) {
  const { entries: topups, isLoading: topupsLoading } = usePaymentsHistory(
    canViewHistory ? organizationId : null
  );
  const {
    entries: invoices,
    upcoming,
    isLoading: invoicesLoading,
  } = useInvoiceHistory(canViewInvoices ? organizationId : null);
  const { entries: creditActivity, isLoading: creditActivityLoading } =
    useCreditActivity(canViewCreditActivity ? organizationId : null);
  const posthog = usePostHog();
  const viewedRef = useRef(false);

  const rows = useMemo<BillingRow[]>(() => {
    const invoiceRows: InvoiceBillingRow[] = (invoices ?? [])
      .filter(isVisibleInvoice)
      .map((inv) => ({
        kind: "invoice",
        date: inv.createdAt,
        invoice: inv,
        creditActivity: [],
      }));
    const standaloneCreditActivity: CreditActivityEntry[] = [];
    const matchedInvoiceIds = new Set<string>();

    for (const entry of creditActivity ?? []) {
      const matchingInvoice = findMatchingInvoiceRow(
        entry,
        invoiceRows,
        matchedInvoiceIds
      );
      if (matchingInvoice) {
        matchingInvoice.creditActivity.push(entry);
        matchedInvoiceIds.add(matchingInvoice.invoice.id);
      } else {
        standaloneCreditActivity.push(entry);
      }
    }

    const merged: BillingRow[] = [
      ...(topups ?? []).map(
        (e): BillingRow => ({ kind: "topup", date: e.occurredAt, topup: e })
      ),
      ...invoiceRows,
      ...(canViewInvoices
        ? []
        : standaloneCreditActivity.map(
            (entry): BillingRow => ({
              kind: "credit",
              date: entry.createdAt,
              credit: entry,
            })
          )),
    ];
    merged.sort((a, b) => b.date - a.date);
    if (upcoming) {
      merged.unshift({
        kind: "invoice",
        date: upcoming.createdAt,
        invoice: upcoming,
        creditActivity: [],
      });
    }
    return merged;
  }, [topups, invoices, creditActivity, upcoming, canViewInvoices]);

  const isLoading =
    (canViewHistory && topupsLoading) ||
    (canViewInvoices && invoicesLoading) ||
    (canViewCreditActivity && creditActivityLoading);

  useEffect(() => {
    if (viewedRef.current) return;
    if (isLoading) return;
    const topupList = topups ?? [];
    if (topupList.length === 0) return;
    viewedRef.current = true;
    posthog?.capture("credit_topup_history_viewed", {
      entry_count_bucket: bucketEntryCount(topupList.length),
      has_failed: topupList.some((e) => e.status === "failed"),
      has_pending: topupList.some((e) => e.status === "pending"),
    });
  }, [isLoading, posthog, topups]);

  if (!canViewHistory && !canViewInvoices && !canViewCreditActivity) {
    return null;
  }

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
              ) : row.kind === "invoice" ? (
                <InvoiceTableRow
                  key={`i_${row.invoice.id}`}
                  invoice={row.invoice}
                  creditActivity={row.creditActivity}
                />
              ) : (
                <CreditActivityTableRow
                  key={`c_${row.credit.id}`}
                  entry={row.credit}
                />
              )
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-3 sm:hidden max-h-[400px] overflow-y-auto">
        {rows.map((row) =>
          row.kind === "topup" ? (
            <TopupMobileRow
              key={`tm_${row.topup.sessionId}`}
              entry={row.topup}
            />
          ) : row.kind === "invoice" ? (
            <InvoiceMobileRow
              key={`im_${row.invoice.id}`}
              invoice={row.invoice}
              creditActivity={row.creditActivity}
            />
          ) : (
            <CreditActivityMobileRow
              key={`cm_${row.credit.id}`}
              entry={row.credit}
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
        <CreditAmount credits={topupCreditAmount(entry)} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">Credit top-up</TableCell>
      <TableCell>
        <StatusBadge entry={entry} />
      </TableCell>
      <TableCell className="text-right">
        <ReceiptCell entry={entry} />
      </TableCell>
    </TableRow>
  );
}

function InvoiceTableRow({
  invoice,
  creditActivity,
}: {
  invoice: InvoiceHistoryEntry;
  creditActivity: CreditActivityEntry[];
}) {
  const amount = invoiceAmountCents(invoice);
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap align-top text-sm">
        {formatDate(invoice.createdAt)}
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm tabular-nums">
        {formatInvoiceAmount(amount, invoice.currency)}
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm">
        <CreditAmount credits={sumCredits(creditActivity)} />
      </TableCell>
      <TableCell className="align-top text-sm">
        <InvoiceLines invoice={invoice} />
      </TableCell>
      <TableCell className="align-top">
        <InvoiceStatusBadge status={invoice.status} amountCents={amount} />
      </TableCell>
      <TableCell className="text-right align-top">
        <InvoiceReceiptCell invoice={invoice} amountCents={amount} />
      </TableCell>
    </TableRow>
  );
}

function CreditActivityTableRow({ entry }: { entry: CreditActivityEntry }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap align-top text-sm">
        {formatDate(entry.createdAt)}
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm tabular-nums">
        <span className="text-muted-foreground">-</span>
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm">
        <CreditAmount credits={entry.amountCredits} />
      </TableCell>
      <TableCell className="whitespace-nowrap align-top text-sm">
        {creditActivityDetail(entry)}
      </TableCell>
      <TableCell className="align-top">
        <CreditActivityStatusBadge entry={entry} />
      </TableCell>
      <TableCell className="text-right align-top">
        <span className="text-sm text-muted-foreground">-</span>
      </TableCell>
    </TableRow>
  );
}

function cleanLineDescription(desc: string): string {
  const cadence = /\/\s*year/i.test(desc)
    ? " · Annual"
    : /\/\s*month/i.test(desc)
    ? " · Monthly"
    : "";
  const name = desc.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return `${name}${cadence}`;
}

function InvoiceLines({ invoice }: { invoice: InvoiceHistoryEntry }) {
  const prorationSummary = summarizeProratedInvoice(invoice);
  const prorationLines = invoice.lines.filter(isStripeProrationLine);
  const regularLines = invoice.lines.filter(
    (line) => !isStripeProrationLine(line)
  );

  if (prorationSummary && regularLines.length === 0) {
    return <span className="text-foreground">{prorationSummary}</span>;
  }
  if (invoice.lines.length === 0) {
    return <span className="text-muted-foreground">Subscription</span>;
  }
  const lines = prorationSummary
    ? [
        ...regularLines.map((line) => ({
          description: cleanLineDescription(line.description),
          amountCents: line.amountCents,
        })),
        {
          description: prorationSummary,
          amountCents: prorationLines.reduce(
            (sum, line) => sum + line.amountCents,
            0
          ),
        },
      ]
    : invoice.lines.map((line) => ({
        description: cleanLineDescription(line.description),
        amountCents: line.amountCents,
      }));
  const showLineAmounts = lines.length > 1;
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span className="truncate text-foreground">{line.description}</span>
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
        <div className="flex flex-col items-end gap-0.5">
          <span className="tabular-nums font-medium">
            {formatUsd(entry.pricePaidCents)}
          </span>
          <CreditAmount credits={topupCreditAmount(entry)} />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">Credit top-up</div>
      <div className="flex items-center justify-between">
        <StatusBadge entry={entry} />
        <ReceiptCell entry={entry} />
      </div>
    </div>
  );
}

function InvoiceMobileRow({
  invoice,
  creditActivity,
}: {
  invoice: InvoiceHistoryEntry;
  creditActivity: CreditActivityEntry[];
}) {
  const amount = invoiceAmountCents(invoice);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between text-sm">
        <span>{formatDate(invoice.createdAt)}</span>
        <div className="flex flex-col items-end gap-0.5">
          <span className="tabular-nums font-medium">
            {formatInvoiceAmount(amount, invoice.currency)}
          </span>
          <CreditAmount credits={sumCredits(creditActivity)} />
        </div>
      </div>
      <InvoiceLines invoice={invoice} />
      <div className="flex items-center justify-between">
        <InvoiceStatusBadge status={invoice.status} amountCents={amount} />
        <InvoiceReceiptCell invoice={invoice} amountCents={amount} />
      </div>
    </div>
  );
}

function CreditActivityMobileRow({ entry }: { entry: CreditActivityEntry }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between text-sm">
        <span>{formatDate(entry.createdAt)}</span>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-muted-foreground">-</span>
          <CreditAmount credits={entry.amountCredits} />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {creditActivityDetail(entry)}
      </div>
      <div className="flex items-center justify-between">
        <CreditActivityStatusBadge entry={entry} />
        <span className="text-sm text-muted-foreground">-</span>
      </div>
    </div>
  );
}

function CreditAmount({
  credits,
  className = "",
}: {
  credits: number | null;
  className?: string;
}) {
  if (credits === null) {
    return <span className="text-muted-foreground">-</span>;
  }
  const tone =
    credits > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-muted-foreground";
  return (
    <span
      className={["tabular-nums font-medium", tone, className]
        .filter(Boolean)
        .join(" ")}
    >
      {formatCreditAmount(credits)}
    </span>
  );
}

function InvoiceStatusBadge({
  status,
  amountCents,
}: {
  status: string;
  amountCents: number;
}) {
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
  if (status === "paid" && amountCents < 0) {
    return (
      <Badge
        variant="outline"
        className="border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-200"
      >
        <Undo2 aria-hidden="true" />
        Credited
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

function CreditActivityStatusBadge({ entry }: { entry: CreditActivityEntry }) {
  if (entry.kind === "granted") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100"
      >
        <CheckCircle2 aria-hidden="true" />
        Granted
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700/60 dark:bg-slate-900/40 dark:text-slate-200"
    >
      <Undo2 aria-hidden="true" />
      Clawed back
    </Badge>
  );
}

function InvoiceReceiptCell({
  invoice,
  amountCents,
}: {
  invoice: InvoiceHistoryEntry;
  amountCents: number;
}) {
  const url = invoice.hostedInvoiceUrl ?? invoice.invoicePdfUrl;

  if (amountCents < 0) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span
          className="text-sm text-muted-foreground"
          title="Credited to the customer's Stripe balance, not refunded to the card."
        >
          Stripe balance
        </span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
            data-ph-no-capture
            aria-label={`View Stripe invoice for ${formatDate(
              invoice.createdAt
            )} balance credit (opens in new tab)`}
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
          >
            View invoice
            <ExternalLink aria-hidden="true" className="size-3" />
            <span className="sr-only">(opens in new tab)</span>
          </a>
        ) : null}
      </div>
    );
  }

  if (!url) return <span className="text-sm text-muted-foreground">-</span>;
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
  if (status === "refunded" || status === "partially_refunded") {
    const isPartial = status === "partially_refunded";
    const detail =
      typeof entry.reversedPaidCents === "number"
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

  const muted = "text-sm text-muted-foreground";
  if (entry.status === "succeeded") {
    return <span className={muted}>Not available</span>;
  }
  if (entry.status === "pending") {
    return <span className={muted}>Processing</span>;
  }
  return <span className={muted}>-</span>;
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
