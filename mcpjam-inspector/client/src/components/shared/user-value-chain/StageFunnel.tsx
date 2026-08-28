/**
 * A funnel over one population's chains.
 *
 * ONE population per funnel, always. A User Testing scenario and a swarm run
 * answer different questions and neither is an eval trial, so this component
 * takes a single backend-computed summary and has no way to combine two —
 * there is no `summaries` prop and no addition anywhere in this file. Putting
 * two of these side by side is a layout decision; summing them is not
 * available.
 *
 * ── The four things it always shows ──────────────────────────────────────────
 *
 *  1. **The numerator and the eligible denominator, as numbers.** `4 / 7`, not
 *     just `57%`. A percentage alone hides how much was measured, and "57% of
 *     seven" and "57% of seven hundred" are not the same finding.
 *  2. **Zero eligible as words, never 0%.** A rate over an empty denominator
 *     is not a small number; it is not a number. `passRate: null` renders "not
 *     measured" and no bar.
 *  3. **Exclusions.** Every session that contributed nothing is counted and
 *     named — no chain, deriving, stale, or a worker that gave up. A funnel
 *     that quietly shrank its own denominator would swing on every re-grade,
 *     and the swing would look like a finding.
 *  4. **Truncation.** When the population is larger than the backend's scan,
 *     it says so. A silently sampled funnel is one nobody can reconcile
 *     against the session list beside it.
 *
 * Nothing here derives or re-folds. Every number is the backend's.
 */

import {
  USER_VALUE_STAGE_LABELS,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import {
  formatPassRate,
  type ChatSessionStageFunnel,
  type StageTally,
} from "./user-value-chain-types";

const EXCLUSION_LABELS = {
  absent: "no chain",
  deriving: "deriving",
  stale: "awaiting a newer chain",
  failed: "derivation failed",
} satisfies Record<keyof ChatSessionStageFunnel["exclusions"], string>;

function StageBar({ tally }: { tally: StageTally }) {
  const rate = formatPassRate(tally.passRate);
  const widthPct = tally.passRate === null ? 0 : tally.passRate * 100;

  return (
    <li className="py-1.5" data-stage={tally.stage}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground">
          {USER_VALUE_STAGE_LABELS[tally.stage]}
        </span>
        {rate === null ? (
          // Rule 2. The words, not a zero.
          <span className="text-[11px] text-muted-foreground">
            not measured
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{rate}</span>{" "}
            {/* Rule 1. The counts travel with the rate, always. */}
            <span aria-label={`${tally.passed} of ${tally.eligible} eligible`}>
              ({tally.passed}/{tally.eligible} eligible)
            </span>
          </span>
        )}
      </div>
      <div
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
        role="presentation"
      >
        {tally.passRate === null ? null : (
          <div
            className="h-full rounded-full bg-emerald-500"
            style={{ width: `${widthPct}%` }}
          />
        )}
      </div>
      {tally.eligible < tally.observations ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="mt-0.5 text-[11px] text-muted-foreground/80">
              {tally.observations - tally.eligible} of {tally.observations}{" "}
              observations had no verdict
            </p>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {/* The three non-verdicts stay three facts, here too. */}
            {tally.notMeasured} not measured, {tally.notApplicable} not
            applicable to the session, {tally.notReached} never ran because an
            earlier stage failed. None of these is a failure, and none is
            counted in the denominator.
          </TooltipContent>
        </Tooltip>
      ) : null}
    </li>
  );
}

export function StageFunnel({
  summary,
  title,
  /**
   * What this population IS, in the reader's words. Required, because the one
   * way to misread a funnel is to forget which sessions are in it.
   */
  populationLabel,
  className,
}: {
  summary: ChatSessionStageFunnel | null | undefined;
  title: string;
  populationLabel: string;
  className?: string;
}) {
  if (!summary) return null;

  const excluded = Object.values(summary.exclusions).reduce((a, b) => a + b, 0);
  const excludedEntries = (
    Object.entries(summary.exclusions) as Array<
      [keyof ChatSessionStageFunnel["exclusions"], number]
    >
  ).filter(([, count]) => count > 0);
  const firstFailed = Object.entries(summary.firstFailedStage).sort(
    (a, b) => b[1] - a[1]
  ) as Array<[UserValueStage, number]>;

  return (
    <section
      className={cn("rounded-md border border-border/60 p-3", className)}
      aria-label={title}
      data-source={summary.source ?? "unknown"}
    >
      <header className="mb-2">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        <p className="text-[11px] text-muted-foreground">
          {populationLabel} · {summary.counted} of {summary.total} session
          {summary.total === 1 ? "" : "s"} measured
        </p>
      </header>

      {summary.notMeasured ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Nothing in this population has a derived chain yet, so there is
          nothing to measure. This is not a zero.
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {summary.stages.map((tally) => (
            <StageBar key={tally.stage} tally={tally} />
          ))}
        </ul>
      )}

      {firstFailed.length > 0 ? (
        <div className="mt-2 border-t border-border/40 pt-2">
          <p className="text-[11px] text-muted-foreground">
            {/* WHERE these sessions stop. Not why — and never "root cause". */}
            Where the chain stopped:{" "}
            {firstFailed
              .map(
                ([stage, count]) =>
                  `${USER_VALUE_STAGE_LABELS[stage]} (${count})`
              )
              .join(", ")}
          </p>
        </div>
      ) : null}

      {excluded > 0 ? (
        <p className="mt-2 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
          {/* Rule 3. Named, not absorbed. */}
          Excluded: {excluded} session{excluded === 1 ? "" : "s"} (
          {excludedEntries
            .map(([key, count]) => `${count} ${EXCLUSION_LABELS[key]}`)
            .join(", ")}
          ).
        </p>
      ) : null}

      {summary.truncated ? (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {/* Rule 4. A silently sampled funnel is unreconcilable. */}
          This population is larger than one scan; these numbers cover the most
          recent {summary.total} sessions only.
        </p>
      ) : null}
    </section>
  );
}
