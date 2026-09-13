import { Skeleton } from "@mcpjam/design-system/skeleton";
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
import {
  isRecommendedDefaultPredicateKind,
  STAGE_STATE_LABELS,
} from "@mcpjam/sdk/contract";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import type { TestStep } from "@/shared/steps";
import type { StepReplayEnvelope } from "@/shared/eval-step-replay";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { EvalIteration } from "@/components/evals/types";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";
import type { CaseScorecardInput, ScorecardRow } from "./case-scorecard-model";
import { buildCaseScorecard } from "./case-scorecard-model";
import { joinTrialResults, summarizeTrialScorecard } from "./trial-results";
import { ScorecardGroupSection } from "./scorecard-group";
import { TrialChainPanel } from "../trial-chain-panel";
import { TrialScorecardRow } from "./trial-scorecard-row";

// Explicit step/case assertions remain added checks, even when their kind is
// also offered by default. Frozen predicates have no inherited/added origin;
// classify their standard default kinds with the chain.
function isDefaultAssertion(row: ScorecardRow): boolean {
  return (
    row.provenance === "judge" ||
    row.provenance === "route" ||
    row.provenance === "suite" ||
    (row.provenance === "snapshot" &&
      !!row.predicate &&
      isRecommendedDefaultPredicateKind(row.predicate.type))
  );
}

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
    parts.push("No evaluators ran");
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
  nextQuestionSlot,
  judgeHidden = false,
  isRunning = false,
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
  nextQuestionSlot?: ReactNode;
  /**
   * True while a reviewer is labelling this trial and has not revealed the
   * judge. The judge row then withholds its score, glyph and rationale — a
   * label recorded as blind beside a visible verdict is not calibration data.
   */
  judgeHidden?: boolean;
  isRunning?: boolean;
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
    authored.numbering,
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

  const defaultGroups = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(isDefaultAssertion),
    }))
    .filter((group) => group.rows.length > 0);
  const addedGroups = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => !isDefaultAssertion(row)),
    }))
    .filter((group) => group.rows.length > 0);

  const summary = summarizeTrialScorecard(addedGroups);

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

  const userValueStage =
    chain?.status === "verified"
      ? chain.stages.find((stage) => stage.stage === "userValue")
      : undefined;
  const userValuePassRows = groups
    .flatMap((group) => group.rows)
    .filter(
      (row) => row.stage === "userValue" && row.result.state === "passed",
    );
  const userValueEvidence = [
    ...new Set(
      [
        ...(userValueStage?.state === "passed"
          ? (userValueStage.evidence?.predicateReasons ?? [])
          : []),
        ...userValuePassRows.flatMap((row) => [
          ...("reason" in row.result && row.result.reason
            ? [row.result.reason]
            : []),
          ...(row.evidence?.scoreEvidence ?? []),
        ]),
      ]
        .map((text) => text.trim())
        .filter(Boolean),
    ),
  ];
  const showUserValueEvidence =
    !judgeHidden &&
    (userValueStage?.state === "passed" || userValuePassRows.length > 0);

  const renderGroups = (sectionGroups: typeof groups) => (
    <>
      {sectionGroups.map((group) => (
        <ScorecardGroupSection
          key={group.stage}
          stage={group.stage}
          label={group.label}
          question={group.question}
          state={stageState(group.stage)}
          evidence={
            group.stage === "userValue" &&
            group.rows.some((row) => row.provenance === "judge") &&
            showUserValueEvidence ? (
              <div
                className="space-y-1 rounded-md border border-border bg-muted/20 px-3 py-2"
                data-testid="user-value-pass-evidence"
              >
                <p className="text-xs font-medium">Evidence for this pass</p>
                {userValueEvidence.length ? (
                  <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                    {userValueEvidence.map((text) => (
                      <li
                        className="whitespace-pre-wrap break-words"
                        key={text}
                      >
                        {text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This run recorded a pass without supporting evidence.
                  </p>
                )}
              </div>
            ) : undefined
          }
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
    </>
  );

  const inProgress =
    isRunning ||
    iteration?.status === "pending" ||
    iteration?.status === "running" ||
    (!iteration && !!liveStepStatusById?.size);
  if (inProgress) {
    return (
      <div
        className="space-y-4 p-4"
        role="status"
        aria-live="polite"
        aria-busy="true"
        data-testid="trial-scorecard-loading"
      >
        <p className="text-sm text-muted-foreground">
          Run in progress. The report will appear when it finishes.
        </p>
        <div
          className="grid gap-4 sm:grid-cols-[170px_minmax(0,1fr)]"
          aria-hidden="true"
        >
          <div className="space-y-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
          <Skeleton className="h-60 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="trial-scorecard">
      <section
        className="space-y-4"
        aria-label="User value chain — default assertions"
      >
        {!judgeHidden ? (
          <TrialChainPanel
            layout="report"
            chain={chain}
            resetKey={iteration?._id}
            stageFooter={(stage) => {
              const selected = defaultGroups.find(
                (group) => group.stage === stage,
              );
              return selected ? (
                <div
                  className="mt-3 space-y-2"
                  aria-label="Recorded assertions"
                >
                  {selected.rows.map((row) => (
                    <TrialScorecardRow
                      key={row.key}
                      row={row}
                      body={row.provenance === "judge" ? judgeSlot : undefined}
                      hideJudgeResult={judgeHidden}
                      syncedStepId={syncedStepId}
                      onSyncStep={onSyncStep}
                    />
                  ))}
                  {stage === "userValue" && showUserValueEvidence && (
                    <div
                      className="text-xs text-muted-foreground"
                      data-testid="user-value-pass-evidence"
                    >
                      {userValueEvidence.length
                        ? userValueEvidence.join(" ")
                        : "This run recorded a pass without supporting evidence."}
                    </div>
                  )}
                </div>
              ) : null;
            }}
          />
        ) : null}
        {(judgeHidden || chain?.status !== "verified") &&
          renderGroups(defaultGroups)}
        {!judgeHidden ? nextQuestionSlot : null}
      </section>

      <section
        className="space-y-3 border-t border-border pt-4"
        aria-label="Added assertions"
      >
        <h3 className="text-sm font-semibold">Added assertions</h3>
        {addedGroups.length ? (
          <>
            <p
              className="text-xs text-muted-foreground"
              data-testid="trial-scorecard-summary"
            >
              {summaryLine(summary)}
            </p>
            {renderGroups(addedGroups)}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            No extra assertions added.
          </p>
        )}
      </section>

      {/*
        The integrity view stays reachable, collapsed. It answers a different
        question — which score rows the backend could not join, and whether it
        downgraded the verdict for it — and a reader who needs that is looking
        for it.
      */}
      {(!judgeHidden || !judgeCase) && suggestionsSlot ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer py-2">
            Suggested assertions
          </summary>
          {suggestionsSlot}
        </details>
      ) : null}

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
