import { useEffect, useRef } from "react";
import {
  CheckCircle2,
  Clock,
  CircleAlert,
  ExternalLink,
} from "lucide-react";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
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

const formatUsd = (cents: number): string => {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
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

export function PaymentsHistorySection() {
  // Hooks must be called unconditionally before any early-return — flag check
  // happens after. PostHog's `useFeatureFlagEnabled` can return `undefined`
  // during bootstrap; treat anything other than `true` as off so we don't
  // flash content before the flag resolves.
  const flagEnabled = useFeatureFlagEnabled("billing-entitlements-ui");
  const { entries, isLoading } = usePaymentsHistory();
  const posthog = usePostHog();
  const viewedRef = useRef(false);

  const safeEntries = entries ?? [];

  // Fire the view event once per mount when entries first load and aren't
  // empty. Ref guard defeats StrictMode double-mount and the auth-resolve
  // re-render that flips isLoading false. Gated on flagEnabled so we never
  // pollute telemetry for users who can't see the surface.
  useEffect(() => {
    if (flagEnabled !== true) return;
    if (viewedRef.current) return;
    if (isLoading) return;
    if (safeEntries.length === 0) return;
    viewedRef.current = true;
    posthog?.capture("credit_topup_history_viewed", {
      entry_count_bucket: bucketEntryCount(safeEntries.length),
      has_failed: safeEntries.some((e) => e.status === "failed"),
      has_pending: safeEntries.some((e) => e.status === "pending"),
    });
  }, [flagEnabled, isLoading, posthog, safeEntries]);

  if (flagEnabled !== true) return null;

  return (
    <Card className="border-border/60 py-6 shadow-sm">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Payment history</h2>
        </div>
        {isLoading ? (
          <LoadingRows />
        ) : safeEntries.length === 0 ? (
          <EmptyState />
        ) : (
          <PaymentsTable entries={safeEntries} />
        )}
      </CardContent>
    </Card>
  );
}

function PaymentsTable({ entries }: { entries: PaymentHistoryEntry[] }) {
  return (
    <div data-testid="payments-history-table">
      {/* Desktop: real table at sm+. Cap visible height at ~5 rows; older
       * rows scroll inside the card so the section never balloons even at
       * the 50-row server cap. */}
      <div className="hidden sm:block max-h-[280px] overflow-y-auto rounded-md border border-border/40">
        <Table>
          <TableHeader className="sticky top-0 bg-background">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Receipt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.sessionId}>
                <TableCell className="whitespace-nowrap text-sm">
                  {formatDate(entry.occurredAt)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm tabular-nums">
                  {formatUsd(entry.paidAmountCents)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={entry.status} />
                </TableCell>
                <TableCell className="text-right">
                  <ReceiptCell entry={entry} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {/* Mobile: stacked rows. Same height cap as desktop. */}
      <div className="flex flex-col gap-3 sm:hidden max-h-[400px] overflow-y-auto">
        {entries.map((entry) => (
          <MobileRow key={entry.sessionId} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function MobileRow({ entry }: { entry: PaymentHistoryEntry }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between text-sm">
        <span>{formatDate(entry.occurredAt)}</span>
        <span className="tabular-nums font-medium">
          {formatUsd(entry.paidAmountCents)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <StatusBadge status={entry.status} />
        <ReceiptCell entry={entry} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: PaymentHistoryEntry["status"] }) {
  if (status === "succeeded") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-100"
      >
        <CheckCircle2 aria-hidden="true" />
        Succeeded
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
      Math.round((Date.now() - entry.occurredAt) / (24 * 60 * 60 * 1000)),
    );
    return (
      <a
        href={entry.receiptUrl}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        data-ph-no-capture
        aria-label={`View receipt for ${formatDate(entry.occurredAt)} payment (opens in new tab)`}
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
  // doesn't read the same as a failed row (which legitimately has no
  // receipt).
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
