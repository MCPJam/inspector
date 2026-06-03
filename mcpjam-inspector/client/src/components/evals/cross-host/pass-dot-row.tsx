import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { EvalIteration } from "../types";
import { computeIterationResult } from "../pass-criteria";

const MAX_DOTS = 12;

interface PassDotRowProps {
  iterations: EvalIteration[];
}

/**
 * Sort iterations by `iterationNumber` ascending, with `createdAt` as a
 * tiebreaker for legacy rows that may share a number (or have none). The
 * input array is whatever the caller hands in — could be a query-result
 * slice or a Map-derived list — so sort upstream ordering doesn't
 * guarantee stability across renders. Stable sort keeps the dot row from
 * jittering when iterations re-fetch.
 */
function stableOrder(iterations: EvalIteration[]): EvalIteration[] {
  return [...iterations].sort((a, b) => {
    const an = a.iterationNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.iterationNumber ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    const at = a.createdAt ?? 0;
    const bt = b.createdAt ?? 0;
    return at - bt;
  });
}

export function PassDotRow({ iterations }: PassDotRowProps) {
  const ordered = useMemo(() => stableOrder(iterations), [iterations]);
  const shown = ordered.slice(0, MAX_DOTS);
  const overflow = ordered.length - shown.length;

  // Pre-compute aria summary so screen readers get a useful description
  // of the row state without enumerating every dot. The dots themselves
  // stay aria-hidden — they're visual aids, the summary carries meaning.
  const counts = useMemo(() => {
    let passed = 0;
    let failed = 0;
    let other = 0;
    for (const iter of ordered) {
      const result = computeIterationResult(iter);
      if (result === "passed") passed++;
      else if (result === "failed") failed++;
      else other++;
    }
    return { passed, failed, other, total: ordered.length };
  }, [ordered]);

  const ariaLabel =
    counts.total === 0
      ? "No iterations"
      : `${counts.passed} passed, ${counts.failed} failed${
          counts.other > 0 ? `, ${counts.other} pending or cancelled` : ""
        } out of ${counts.total}`;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="flex items-center gap-0.5 flex-wrap"
    >
      {shown.map((iter) => {
        const result = computeIterationResult(iter);
        return (
          <span
            key={iter._id}
            title={result}
            aria-hidden
            className={cn(
              "inline-block size-2 rounded-full ring-1",
              result === "passed" && "bg-success/50 ring-success/60",
              result === "failed" && "bg-destructive/50 ring-destructive/60",
              result === "cancelled" && "bg-muted-foreground/50 ring-muted-foreground/60",
              result === "pending" && "bg-warning/50 ring-warning/60",
            )}
          />
        );
      })}
      {overflow > 0 && (
        <span aria-hidden className="text-[10px] text-muted-foreground">
          +{overflow}
        </span>
      )}
    </div>
  );
}
