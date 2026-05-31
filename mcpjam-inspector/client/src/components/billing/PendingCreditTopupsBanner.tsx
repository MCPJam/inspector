import { useMemo } from "react";
import { Clock, CircleAlert } from "lucide-react";
import { usePendingCreditTopups } from "@/hooks/usePendingCreditTopups";
import type { PendingCreditTopup } from "@/hooks/usePendingCreditTopups";

const formatUsd = (cents: number): string => {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
};

/** Renders a small notice for any in-flight or recently-failed credit top-up. */
export function PendingCreditTopupsBanner() {
  const { pending, failed } = usePendingCreditTopups();

  const pendingTotalCents = useMemo(
    () => (pending ?? []).reduce((sum, t) => sum + t.amountCents, 0),
    [pending],
  );

  if (!pending && !failed) return null;

  const hasPending = (pending?.length ?? 0) > 0;
  const hasFailed = (failed?.length ?? 0) > 0;
  if (!hasPending && !hasFailed) return null;

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="pending-credit-topups-banner"
    >
      {hasPending && (
        <PendingNotice
          totalAmountCents={pendingTotalCents}
          count={pending?.length ?? 0}
        />
      )}
      {hasFailed &&
        (failed ?? []).map((topup) => (
          <FailedNotice key={topup.id} topup={topup} />
        ))}
    </div>
  );
}

interface PendingNoticeProps {
  totalAmountCents: number;
  count: number;
}

function PendingNotice({ totalAmountCents, count }: PendingNoticeProps) {
  const amountLabel = formatUsd(totalAmountCents);
  const headline =
    count === 1
      ? `Top-up of ${amountLabel} is pending`
      : `${count} top-ups (${amountLabel} total) are pending`;
  return (
    <div
      role="status"
      data-testid="pending-credit-topups-pending"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="font-medium">{headline}</p>
        <p className="text-amber-800/80 dark:text-amber-200/80">
          Bank transfers usually take 1–5 business days to clear. Credits land
          automatically once your payment settles.
        </p>
      </div>
    </div>
  );
}

interface FailedNoticeProps {
  topup: PendingCreditTopup;
}

function FailedNotice({ topup }: FailedNoticeProps) {
  return (
    <div
      role="alert"
      data-testid="pending-credit-topups-failed"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive dark:border-destructive/60"
    >
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="font-medium">
          Top-up of {formatUsd(topup.amountCents)} could not be completed
        </p>
        <p className="text-destructive/80">
          Your payment was declined or returned. No credits were granted —
          please try again with a different payment method.
        </p>
      </div>
    </div>
  );
}
