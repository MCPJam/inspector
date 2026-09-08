/**
 * "What happened" for the one stage a reader selected.
 *
 * The stage cards above say WHERE the chain broke; this says what was measured
 * there, over which population, and — once PR 3 fills the `findings` slot —
 * which trials to open next.
 *
 * ── This is an explanation, not a second verdict ─────────────────────────────
 *
 * Nothing in this card states whether the run passed. D9's decision card is the
 * authority on that and is a different card on a different read. Everything
 * here is D5c's measured description of the execution chain, and the two can
 * legitimately disagree in a way that is not a bug: under policy v2 a case can
 * pass with a failing trial in it, so a stage can be measured as failing on a
 * run whose verdict is `passed`.
 *
 * ── The rates come from `RateCell`, imported and not re-implemented ──────────
 *
 * A second renderer for the same three rates is a second place for a zero
 * denominator to become a `0%`. There is one, in `stage-analytics-panel.tsx`,
 * and this imports it.
 */
import {
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
} from "@mcpjam/sdk/contract";
import type { ReactNode } from "react";
import { RateCell } from "./stage-analytics-panel";
import type { StageRowView } from "./stage-analytics-model";

export function StageDetailCard({
  stage,
  findings,
}: {
  stage: StageRowView;
  /**
   * The evidence for this stage's failures, when there is any to join.
   *
   * A SLOT rather than a prop this card renders itself: the diagnostics that
   * fill it come from D9, on a different read with its own loading and failure
   * states, and this card must render completely without them. A stage's
   * measured rates are true whether or not a diagnostics page arrived.
   */
  findings?: ReactNode;
}) {
  return (
    <div
      className="mt-2 rounded-md border border-border/60 p-3"
      data-testid="stage-detail-card"
      data-stage={stage.stage}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          What happened
        </h5>
        {stage.latency ? (
          // Unit AND basis, the same rule the stage rows follow: a duration
          // without its basis is a claim rather than a measurement.
          <span className="text-[10px] text-muted-foreground">
            {stage.latency}
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-xs font-medium text-foreground">
        {USER_VALUE_STAGE_LABELS[stage.stage]}
      </p>
      {/* The QUESTION this stage answers, in the contract's own words. Without
          it a reader has a label and three percentages and has to reconstruct
          what was being asked. */}
      <p className="text-[11px] text-muted-foreground">
        {USER_VALUE_STAGE_QUESTIONS[stage.stage]}
      </p>

      <div className="mt-2 grid gap-3 sm:grid-cols-3">
        <RateCell rate={stage.reach} />
        <RateCell rate={stage.coverage} />
        <RateCell rate={stage.pass} />
      </div>

      {stage.reachUnknown > 0 || stage.notApplicable > 0 ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
          {/* Two different facts, and neither is a drop-off. */}
          {stage.reachUnknown} captured nothing (reach undecidable),{" "}
          {stage.notApplicable} not applicable to the case. Neither is counted
          as a drop-off.
        </p>
      ) : null}

      {stage.reasons.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5" data-testid="stage-detail-reasons">
          {stage.reasons.map((entry) => (
            <li
              key={entry.reason}
              data-reason={entry.reason}
              className="text-[10px] text-muted-foreground/80"
            >
              {entry.count} — {entry.label}
            </li>
          ))}
        </ul>
      ) : null}

      {findings ?? null}
    </div>
  );
}
