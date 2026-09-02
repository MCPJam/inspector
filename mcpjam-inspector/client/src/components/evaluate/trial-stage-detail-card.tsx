/**
 * "What happened" for the one stage a reader selected, on ONE TRIAL.
 *
 * The per-trial sibling of `StageDetailCard`. Same frame — the eyebrow, the
 * stage label, the contract's question — and a different body, because the two
 * cards answer different questions about different populations:
 *
 *   - `StageDetailCard` explains a RUN's stage: three rates over a population,
 *     a reason histogram, exclusion counts.
 *   - this explains a TRIAL's stage: one state, one reason, that row's own
 *     evidence.
 *
 * ── What is deliberately absent ──────────────────────────────────────────────
 *
 * No `RateCell`. A rate needs a denominator and one trial is not a population;
 * "100% (1/1)" would be a statistic manufactured from a single observation.
 * No latency: it is deliberately NOT a field on `StageResultRow` (see the
 * stage-measurements contract), and inventing one from elsewhere would attach
 * a timing claim to a row that never carried it. No findings slot: a trial IS
 * the finding, so there is nothing to fill it with.
 *
 * ── Nothing here diagnoses ───────────────────────────────────────────────────
 *
 * The state, the reason and the evidence are read off the row. `nextAction` is
 * the contract's own field, passed in by the caller that holds the diagnostic
 * — never recomputed here from a failure category, because the wording that
 * handles a verdict/chain disagreement is decided by logic this component
 * cannot see.
 */
import {
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  type StageResultRow,
} from "@mcpjam/sdk/contract";
import { describeStageRowEvidence } from "../evals/run-decision-summary-presentation";
import { UNRECOGNIZED_STATE_LABEL } from "./stage-trial-model";

export function TrialStageDetailCard({
  row,
  nextAction,
}: {
  row: StageResultRow;
  /**
   * The operator's next step, when the caller has one for THIS stage.
   *
   * Optional because it belongs to the diagnostic rather than to the row: a
   * surface reading a trial's chain without its decision summary has no
   * next action to offer, and offering a made-up one would be worse than
   * offering none.
   */
  nextAction?: string;
}) {
  // No `?? row.state` fallback: printing a wire spelling at a human is the
  // failure the label maps exist to prevent, and this build genuinely does not
  // know what a state it has no label for means.
  const stateLabel = STAGE_STATE_LABELS[row.state] ?? UNRECOGNIZED_STATE_LABEL;
  const reasonLabel = row.reason ? STAGE_REASON_LABELS[row.reason] : null;
  const evidence = describeStageRowEvidence(row);
  const predicateReasons = row.evidence?.predicateReasons ?? [];

  return (
    <div
      className="mt-2 rounded-md border border-border/60 p-3"
      data-testid="trial-stage-detail-card"
      data-stage={row.stage}
      data-state={row.state}
    >
      <h5 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        What happened
      </h5>

      <p className="mt-1 text-xs font-medium text-foreground">
        {USER_VALUE_STAGE_LABELS[row.stage]}
      </p>
      {/* The QUESTION this stage answers, in the contract's own words. */}
      <p className="text-[11px] text-muted-foreground">
        {USER_VALUE_STAGE_QUESTIONS[row.stage]}
      </p>

      <p
        className="mt-2 text-[11px] text-foreground"
        data-testid="trial-stage-state"
      >
        {stateLabel}
      </p>
      {reasonLabel ? (
        // The wire spelling rides as an attribute so a test and a later join
        // can match on it; only the words are rendered.
        <p
          className="mt-0.5 text-[11px] text-muted-foreground"
          data-testid="trial-stage-reason"
          data-reason={row.reason}
        >
          {reasonLabel}
        </p>
      ) : null}

      {predicateReasons.length > 0 ? (
        <ul
          className="mt-1.5 space-y-0.5"
          data-testid="trial-stage-predicate-reasons"
        >
          {predicateReasons.map((reason, index) => (
            // Authored elsewhere and not guaranteed unique, so the index is
            // part of the key rather than the string alone.
            <li
              key={`${index}-${reason}`}
              className="text-[10px] text-muted-foreground/80"
            >
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      {evidence ? (
        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
          {evidence}
        </p>
      ) : null}

      {nextAction ? (
        <p
          className="mt-1.5 text-[10px] text-muted-foreground"
          data-testid="trial-stage-next-action"
        >
          Next action: {nextAction}
        </p>
      ) : null}
    </div>
  );
}
