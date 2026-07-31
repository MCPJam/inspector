import { AlertTriangle, Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { UsageBreakdown } from "@/hooks/useUsageInsights";
import { cn } from "@/lib/utils";

/**
 * Negative-feedback rate segmented by inferred outcome.
 *
 * Explicitly NOT an agreement rate or an accuracy percentage. Feedback is
 * satisfaction, not outcome ground truth, and response rates are single-digit —
 * so a "% correct" number computed against it would be a fabrication dressed up
 * as a measurement.
 *
 * What this DOES show: whether thumbs-down concentrates in the sessions we
 * labeled `completed`. That is a prompt to investigate, not a verdict — it can
 * mean the extraction is wrong, or that users got exactly what they asked for
 * and disliked it. Either way it is visible without claiming a number we cannot
 * support. The inferred outcome is never overwritten by feedback.
 */
interface ChatboxOutcomeCalibrationProps {
  breakdown: UsageBreakdown | null | undefined;
}

/** Below this many ratings a rate is too thin to read; show the raw counts. */
const MIN_RATINGS_FOR_RATE = 5;

export function ChatboxOutcomeCalibration({
  breakdown,
}: ChatboxOutcomeCalibrationProps) {
  const rows = breakdown?.outcomeFeedbackCalibration ?? [];
  const hasAnyRating = rows.some((row) => row.rated > 0);

  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-b px-5 py-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Feedback by inferred outcome</h3>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="About feedback calibration"
              className="text-muted-foreground hover:text-foreground"
            >
              <Info className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            Not an accuracy score. Feedback measures satisfaction, not whether
            the goal was met, and only a few percent of sessions leave any. Read
            this as a smell test: thumbs-down concentrated in sessions labeled
            &ldquo;completed&rdquo; is worth investigating &mdash; it can mean
            the outcome extraction is wrong, or that users got what they asked
            for and disliked it.
          </TooltipContent>
        </Tooltip>
      </div>

      {/* These rates come off the same bounded scan as the grid's, so they carry
          the same qualification. Rendering them bare here while the grid warns
          would be inconsistent — and the inconsistency would read as "this one
          is unconditional". */}
      {breakdown?.scan?.truncated ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-warning-foreground"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Counted over the most recent{" "}
            {breakdown.scan.matched.toLocaleString()} matching sessions, not the
            full history.
          </span>
        </div>
      ) : null}

      {!hasAnyRating ? (
        <p className="text-[11px] text-muted-foreground">
          No sessions in this window carry a rating, so there is nothing to
          compare inferred outcomes against yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-separate border-spacing-0 text-left">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  Inferred outcome
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Sessions
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Rated
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Negative
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Negative rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                // A high negative rate among sessions we called `completed` is
                // the actionable disagreement; flag only that combination.
                const suspicious =
                  row.outcome === "completed" &&
                  row.rated >= MIN_RATINGS_FOR_RATE &&
                  row.negativeRate !== null &&
                  row.negativeRate >= 0.2;
                return (
                  <tr
                    key={row.outcome}
                    className="border-t border-border/60 text-xs"
                  >
                    <th
                      scope="row"
                      className="py-1.5 pr-3 text-left font-medium"
                    >
                      {row.outcome}
                    </th>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {row.sessions.toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {row.rated.toLocaleString()}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {row.negative.toLocaleString()}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right tabular-nums",
                        suspicious && "font-medium text-destructive"
                      )}
                    >
                      {/* A rate off one or two ratings is noise. Show the raw
                          counts instead of a percentage that reads as a
                          finding. */}
                      {row.negativeRate === null
                        ? "—"
                        : row.rated < MIN_RATINGS_FOR_RATE
                        ? `${row.negative}/${row.rated}`
                        : `${Math.round(row.negativeRate * 100)}%`}
                      {/* The flagged row is the whole point of the panel, so it
                          cannot be announced in colour alone. */}
                      {suspicious ? (
                        <span className="sr-only">
                          {" "}
                          — unexpectedly negative for a completed outcome
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
