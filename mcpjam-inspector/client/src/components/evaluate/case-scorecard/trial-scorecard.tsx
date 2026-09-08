/**
 * The trial, as the same scorers the left pane authored.
 *
 * WHAT THIS REPLACES. The evidence pane opened on Steps, which lists what the
 * runner did — a prompt, some asserts, in execution order, labelled with wire
 * enums and no reasons. To find out whether a case's scorers held you had to
 * read that list, scroll past the whole transcript to "Whole-run checks"
 * (usually empty, because step-scoped rows are filtered out of it), and then
 * to "Scores" (absent unless the run persisted score rows). Three surfaces,
 * none of them the question.
 *
 * The Scorecard is one: the rows the left pane shows, in the same order, each
 * with the trial's result beside it. Same model, same labels, same
 * provenance — so "what I asked for" and "what happened" line up row for row.
 *
 * The judge's row hosts the existing review panel as its BODY rather than
 * reimplementing it, which is what keeps the blind-label protocol intact: the
 * panel still owns whether the score is hidden, and still reports that back up
 * so the score rows below hide too.
 */

import { useMemo, type ReactNode } from "react";
import { STAGE_STATE_LABELS } from "@mcpjam/sdk/contract";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import type { TestStep } from "@/shared/steps";
import type { StepReplayEnvelope } from "@/shared/eval-step-replay";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { EvalIteration } from "@/components/evals/types";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";
import type { CaseScorecardInput } from "./case-scorecard-model";
import { buildCaseScorecard } from "./case-scorecard-model";
import { joinTrialResults, summarizeTrialScorecard } from "./trial-results";
import { ScorecardGroupSection } from "./scorecard-group";
import { StageStrip } from "./stage-strip";
import { TrialScorecardRow } from "./trial-scorecard-row";

/**
 * The tally line.
 *
 * Gates only, and no verdict word: the trial header already says PASSED, from
 * `trialVerdict`. A second word here is the bug the Steps tab shipped with —
 * it derived its own from a different field, free to disagree on one screen.
 */
export function summaryLine(
  summary: ReturnType<typeof summarizeTrialScorecard>,
): string {
  const parts: string[] = [];
  if (summary.gates.counted > 0) {
    parts.push(
      `${summary.gates.passed} of ${summary.gates.counted} ${
        summary.gates.counted === 1 ? "gate" : "gates"
      } passed`,
    );
  } else if (summary.warn + summary.report + summary.errors > 0) {
    // Something was measured, but nothing that could fail the trial.
    parts.push("No gates ran");
  } else {
    // Nothing was measured at all. "0 of 0 gates passed" would read like a
    // result; this says there is no result to read.
    parts.push("No scorers ran");
  }
  if (summary.warn > 0) parts.push(`${summary.warn} warn`);
  if (summary.errors > 0) {
    parts.push(`${summary.errors} could not be evaluated`);
  }
  if (summary.pending > 0) parts.push(`${summary.pending} running`);
  return parts.join(" · ");
}

export function TrialScorecard({
  authored,
  iteration,
  steps,
  chain,
  judgeCase,
  envelope,
  liveStepStatusById,
  judgeSlot,
  scoresSection,
  suggestionsSlot,
  judgeHidden = false,
  syncedStepId,
  onSyncStep,
}: {
  authored: CaseScorecardInput;
  iteration: EvalIteration | null;
  /** The steps the trial ran, which are not always the ones on screen. */
  steps: readonly TestStep[];
  chain?: EvalRunDecisionChain | null;
  judgeCase?: JudgeCase | null;
  envelope?: StepReplayEnvelope | null;
  liveStepStatusById?: Map<string, EvalStepStatus>;
  judgeSlot?: ReactNode;
  scoresSection?: ReactNode | null;
  /**
   * "Suggested from this run", under the graded rows.
   *
   * A slot rather than a hook, for the same reason `IterationDetails.scorecard`
   * is one: the writers that accept a suggestion and the flag that gates it
   * belong to the editor, and `RunColumn` mounts this component too.
   */
  suggestionsSlot?: ReactNode;
  /**
   * True while a reviewer is labelling this trial and has not revealed the
   * judge. The judge row then withholds its score, glyph and rationale — a
   * label recorded as blind beside a visible verdict is not calibration data.
   */
  judgeHidden?: boolean;
  syncedStepId?: string | null;
  onSyncStep?: (stepId: string | null) => void;
}) {
  const groups = useMemo(() => {
    const card = buildCaseScorecard(authored);
    return joinTrialResults(card.groups, {
      iteration,
      steps,
      chain,
      judgeCase,
      envelope,
      liveStepStatusById,
    });
    // Keyed on the FIELDS, not the input object: callers build that object in
    // render, so an identity dep would rebuild — and re-digest every criterion
    // id — on each keystroke in the prompt box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    authored.steps,
    authored.toolsChoice,
    authored.kind,
    authored.matchOptions,
    authored.suiteDefaultMatchOptions,
    authored.predicates,
    authored.suiteDefaultPredicates,
    authored.snapshotPredicates,
    authored.expectedOutput,
    authored.judgeConfigOverride,
    authored.suiteJudgeConfig,
    authored.suiteJudgeRubric,
    iteration,
    steps,
    chain,
    judgeCase,
    envelope,
    liveStepStatusById,
  ]);

  // The total can reveal a judge gate's verdict even when its row is hidden.
  const summary = useMemo(
    () => summarizeTrialScorecard(
      judgeHidden
        ? groups.map((group) => ({
            ...group,
            rows: group.rows.filter((row) => row.provenance !== "judge"),
          }))
        : groups,
    ),
    [groups, judgeHidden],
  );

  /**
   * The state word each group heading shows, read from the chain the strip
   * above is drawn from — one source, so the chip's colour and the heading's
   * word can never disagree.
   */
  const stageState = useMemo(() => {
    const byStage = new Map(
      (chain?.status === "verified" ? chain.stages : []).map((row) => [
        row.stage as string,
        row,
      ]),
    );
    return (stage: string) => {
      const row = byStage.get(stage);
      if (!row || judgeHidden) return undefined;
      return {
        label: STAGE_STATE_LABELS[row.state],
        tone:
          row.state === "failed"
            ? ("failed" as const)
            : row.state === "passed"
              ? ("passed" as const)
              : ("neutral" as const),
      };
    };
  }, [chain, judgeHidden]);

  return (
    <div
      className="flex flex-col gap-3 p-3"
      data-testid="trial-scorecard"
    >
      {!judgeHidden ? (
        <StageStrip chain={chain} resetKey={iteration?._id} />
      ) : null}

      <p
        className="text-xs text-muted-foreground"
        data-testid="trial-scorecard-summary"
      >
        {summaryLine(summary)}
      </p>

      {groups.map((group) => (
        <ScorecardGroupSection
          key={group.stage}
          stage={group.stage}
          label={group.label}
          question={group.question}
          state={stageState(group.stage)}
        >
          {group.rows.map((row) => (
            <TrialScorecardRow
              key={row.key}
              row={row}
              body={row.provenance === "judge" ? judgeSlot : undefined}
              hideJudgeResult={judgeHidden}
              syncedStepId={syncedStepId}
              onSyncStep={onSyncStep}
            />
          ))}
        </ScorecardGroupSection>
      ))}

      {/*
        The integrity view stays reachable, collapsed. It answers a different
        question — which score rows the backend could not join, and whether it
        downgraded the verdict for it — and a reader who needs that is looking
        for it.
      */}
      {!judgeHidden || !judgeCase ? suggestionsSlot : null}

      {scoresSection ? (
        <details
          className="rounded-md border border-border/50"
          data-testid="iteration-score-rows"
        >
          <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted-foreground">
            Score rows
          </summary>
          <div className="border-t border-border/50">{scoresSection}</div>
        </details>
      ) : null}
    </div>
  );
}
