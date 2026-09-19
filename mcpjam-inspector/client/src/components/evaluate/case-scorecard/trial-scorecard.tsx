import type { PlatformEvalIterationReport } from "@mcpjam/sdk/platform";
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
import { judgeDecidedStage } from "../stage-trial-model";
import { TrialScorecardRow } from "./trial-scorecard-row";
import { reportAvailability } from "./report-availability";
import { stageFloor, type StageFloorTrace } from "./stage-floor";
import { FindingText } from "@/components/shared/actionable-insights/finding-text";

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
  if (summary.required.counted > 0) {
    parts.push(
      `${summary.required.passed} of ${summary.required.counted} required passed`,
    );
  } else if (summary.advisory + summary.errors > 0) {
    // Something was measured, but nothing that could fail the trial.
    parts.push("No required assertions ran");
  } else {
    // Nothing was measured at all. "0 of 0 required passed" would read like a
    // result; this says there is no result to read.
    parts.push("No evaluators ran");
  }
  if (summary.advisory > 0) parts.push(`${summary.advisory} advisory`);
  if (summary.errors > 0) {
    parts.push(`${summary.errors} could not be evaluated`);
  }
  if (summary.pending > 0) parts.push(`${summary.pending} running`);
  return parts.join(" · ");
}

export function TrialScorecard({
  report,
  authored,
  iteration,
  steps,
  chain,
  judgeCase,
  envelope,
  trace,
  liveStepStatusById,
  judgeSlot,
  scoresSection,
  nextQuestionSlot,
  judgeHidden: judgeHiddenRequested = false,
  isRunning = false,
  syncedStepId,
  onSyncStep,
}: {
  report?: PlatformEvalIterationReport | null;
  authored: CaseScorecardInput;
  iteration: EvalIteration | null;
  /** The steps the trial ran, which are not always the ones on screen. */
  steps: readonly TestStep[];
  chain?: EvalRunDecisionChain | null;
  judgeCase?: JudgeCase | null;
  envelope?: StepReplayEnvelope | null;
  /**
   * The downloaded trace, for the recorded stage floor. The same object
   * `envelope` narrows; taken separately so the assembler's narrow view and
   * this reader's stay independent.
   */
  trace?: StageFloorTrace | null;
  liveStepStatusById?: Map<string, EvalStepStatus>;
  judgeSlot?: ReactNode;
  scoresSection?: ReactNode | null;
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
      report,
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
    report,
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

  /**
   * Blind review withholds a verdict, so it needs one to withhold. A trial
   * the judge never graded (the model call failed, or it was never owed) has
   * nothing to leak, and the label control that lifts the mask only mounts
   * beside a verdict. Masking it anyway left "hidden until you label" on a
   * row nobody could label, and hid the stage's own explanation with it.
   * Every channel the verdict can arrive on counts, so this fails closed.
   */
  const judgeHidden =
    judgeHiddenRequested &&
    (Boolean(judgeCase) ||
      judgeDecidedStage(chain) !== null ||
      groups.some((group) =>
        group.rows.some(
          (row) =>
            row.provenance === "judge" && row.result.state !== "notMeasured",
        ),
      ));

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
  /**
   * Blind review masks ONE card, and only when the judge decided it. The
   * chain's User value row is assertion-decided or judge-decided, never both
   * (`deriveUserValue` is two-tier), so a row whose reason names an assertion
   * has no verdict to leak and stays visible. The other five stages are the
   * runner's observations and are never masked.
   */
  const maskedStage = judgeHidden ? judgeDecidedStage(chain) : null;

  const stageState = useMemo(() => {
    const byStage = new Map(
      (chain?.status === "verified" ? chain.stages : []).map((row) => [
        row.stage as string,
        row,
      ]),
    );
    return (stage: string) => {
      const row = byStage.get(stage);
      if (!row || stage === maskedStage) return undefined;
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
  }, [chain, maskedStage]);

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
          ? userValueStage.evidence?.predicateReasons ?? []
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

  // Blind review withholds every narrative, so it must not advertise one
  // either: a reviewer told "reading iterations 4 of 40" knows an explanation is
  // coming for the row they are labelling.
  const availability = judgeHidden
    ? { kind: "ready" as const }
    : reportAvailability(report, {
        runSettled: iteration?.status === "completed",
      });

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="trial-scorecard">
      <section
        className="space-y-4"
        aria-label="User value chain — default assertions"
      >
        {availability.kind !== "ready" && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="report-availability"
            data-availability={availability.kind}
            {...(availability.kind === "pending"
              ? { role: "status", "aria-live": "polite" }
              : {})}
          >
            {availability.line}
          </p>
        )}
        {/*
          The rail renders on every trial that has one, blind review included
          — the same component the run page draws, so the two surfaces cannot
          drift. Blind review masks the judge-decided card, nothing more.
        */}
        <TrialChainPanel
          layout="report"
          chain={chain}
          resetKey={iteration?._id}
          maskedStage={maskedStage}
          // The judge row is in User value's footer; open it while a label
          // is owed, whether or not the card had to be masked.
          initialStage={judgeHidden ? "userValue" : undefined}
          stageFooter={(stage) => {
            const selected = defaultGroups.find(
              (group) => group.stage === stage,
            );
            const note =
              !judgeHidden && report?.status === "ready"
                ? report.stageNotes?.find((note) => note.stage === stage)
                : undefined;
            // The recorded sentence only where no explanation exists: two
            // accounts of one failure read as two failures.
            const floor =
              note || judgeHidden ? null : stageFloor(stage, chain, trace);
            return selected || note || floor ? (
              <ul className="mt-4" aria-label="Recorded assertions">
                {note && (
                  <li
                    className="border-b border-border/60 py-4 text-sm leading-relaxed"
                    data-narrative-source="ai"
                  >
                    <p>
                      <FindingText text={note.actual} />
                    </p>
                  </li>
                )}
                {floor && (
                  <li
                    className="border-b border-border/60 py-4 text-sm leading-relaxed"
                    data-narrative-source="recorded"
                    data-testid="stage-floor"
                  >
                    <p>
                      <FindingText text={floor.actual} />
                    </p>
                  </li>
                )}
                {(selected?.rows ?? []).map((row) => (
                  <TrialScorecardRow
                    key={row.key}
                    layout="report"
                    row={row}
                    body={row.provenance === "judge" ? judgeSlot : undefined}
                    hideJudgeResult={judgeHidden}
                    syncedStepId={syncedStepId}
                    onSyncStep={onSyncStep}
                  />
                ))}
                {stage === "userValue" && showUserValueEvidence && (
                  <li
                    className="text-xs text-muted-foreground"
                    data-testid="user-value-pass-evidence"
                  >
                    {userValueEvidence.length
                      ? userValueEvidence.join(" ")
                      : "This run recorded a pass without supporting evidence."}
                  </li>
                )}
              </ul>
            ) : null;
          }}
        />
        {/* No verified chain ⇒ no rail to hang the rows on; list them flat. */}
        {chain?.status !== "verified" && renderGroups(defaultGroups)}
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
