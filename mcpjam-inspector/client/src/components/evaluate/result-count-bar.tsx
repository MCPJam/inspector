/**
 * The thin pass/fail bar and its key. Used on pairing rows (and nowhere else
 * as a second style — the matrix cells keep their own taller bar).
 */
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ResultBarCounts = {
  passed: number;
  failed: number;
  pending: number;
  cancelled: number;
};

const SEGMENTS = ["passed", "failed", "pending", "cancelled"] as const;

function segmentClass(status: (typeof SEGMENTS)[number]) {
  return status === "passed"
    ? "bg-success"
    : status === "failed"
      ? "bg-destructive"
      : status === "pending"
        ? "bg-pending/60"
        : "bg-muted-foreground/40";
}

export function resultBarTotal(counts: ResultBarCounts): number {
  return counts.passed + counts.failed + counts.pending + counts.cancelled;
}

export function ResultCountBar({
  counts,
  className,
}: {
  counts: ResultBarCounts;
  className?: string;
}) {
  const total = resultBarTotal(counts);
  if (total <= 0) return null;
  return (
    <div
      className={cn(
        "flex h-1.5 overflow-hidden rounded-full bg-muted",
        className,
      )}
      aria-label={`${counts.passed} passed, ${counts.failed} failed`}
      data-testid="result-count-bar"
    >
      {SEGMENTS.map((status) =>
        counts[status] > 0 ? (
          <span
            key={status}
            className={segmentClass(status)}
            style={{ width: `${(counts[status] / total) * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

export function ResultCountKey({
  counts,
}: {
  counts: Pick<ResultBarCounts, "passed" | "failed">;
}) {
  return (
    <div
      className="flex items-center gap-2 text-[11px] tabular-nums"
      data-testid="result-count-key"
    >
      <span className="flex items-center gap-1 text-success">
        <Check className="size-3" aria-hidden />
        {counts.passed} passed
      </span>
      <span className="flex items-center gap-1 text-destructive">
        <X className="size-3" aria-hidden />
        {counts.failed} failed
      </span>
    </div>
  );
}
