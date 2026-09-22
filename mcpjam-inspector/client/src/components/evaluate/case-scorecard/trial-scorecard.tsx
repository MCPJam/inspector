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
 * LAYOUT. The chain's six links as a rail down the left, one stage open
 * beside it. The open section's heading carries that stage's state word from
 * the verified chain; under it, at most one sentence about the stage as a
 * whole (the AI note, else the recorded floor, else the chain's own reason for
 * a failure no row explains); then the evaluators that grade that stage, each
 * as an EXPECTED / ACTUAL pair. Nothing is split by where a check came from: a
 * default check and an authored one grade the same stage, so they file
 * together.
 *
 * The rail needs a verified chain to be a rail — six links whose states came
 * from somewhere. Without one there is nothing to hang the sections on and no
 * break to open at, so they stack instead, which is also what the authoring
 * pane does before a run exists.
 *
 * The judge's row hosts the existing review panel as its BODY rather than
 * reimplementing it, which is what keeps the blind-label protocol intact: the
 * panel still owns whether the score is hidden, and still reports that back up
 * so the score rows below hide too.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGE_QUESTIONS,
  USER_VALUE_STAGES,
} from "@mcpjam/sdk/contract";
import type {
  EvalRunDecisionChain,
  StageResultRow,
  UserValueStage,
} from "@mcpjam/sdk/contract";
import type { TestStep } from "@/shared/steps";
import type { StepReplayEnvelope } from "@/shared/eval-step-replay";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { EvalIteration } from "@/components/evals/types";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";
import type { CaseScorecardInput } from "./case-scorecard-model";
import { buildCaseScorecard } from "./case-scorecard-model";
import {
  joinTrialResults,
  summarizeTrialScorecard,
  type JoinedScorecardRow,
} from "./trial-results";
import { ScorecardGroupSection } from "./scorecard-group";
import { StageRail, buildStageRailCells } from "./stage-rail";
import {
  defaultSelectedTrialStage,
  judgeDecidedStage,
} from "../stage-trial-model";
import { TrialScorecardRow } from "./trial-scorecard-row";
import { reportAvailability } from "./report-availability";
import { stageFloor, type StageFloorTrace } from "./stage-floor";
import { FindingText } from "@/components/shared/actionable-insights/finding-text";

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

/**
 * The chain's own account of a failed stage, as a sentence.
 *
 * `STAGE_REASON_LABELS` are fragments that complete "because <reason>", so
 * the state word leads. Only for a failure: a passing stage's "the evidence
 * was inspected and the stage held" repeats the heading's PASSED.
 */
function chainReasonSentence(row: StageResultRow | undefined): string | null {
  if (!row || row.state !== "failed" || !row.reason) return null;
  const reason = STAGE_REASON_LABELS[row.reason];
  return reason ? `Failed because ${reason}.` : null;
}

/**
 * Which stage the rail opens on, before the reader has chosen one.
 *
 * PURE, and derived at render: on the trace pane the chain arrives after mount,
 * so an opening computed once from an empty chain would open `01` on every
 * iteration and never on the break.
 */
export function openingStage({
  chain,
  stages,
  judgeHidden,
  maskedStage,
}: {
  chain: EvalRunDecisionChain | null | undefined;
  /** The stages that have a section, in chain order. */
  stages: readonly UserValueStage[];
  judgeHidden: boolean;
  maskedStage: UserValueStage | null;
}): UserValueStage | null {
  const shown = (stage: UserValueStage | null | undefined) =>
    stage && stages.includes(stage) ? stage : null;
  // Blind review outranks the break. The judge row and its label control live
  // in User value's section, and a reviewer who has to go and find it labels a
  // different thing on every iteration. The choice is a RULE, so it leaks
  // nothing about whether the judge is the stage that failed.
  if (judgeHidden) {
    return shown(maskedStage) ?? shown("userValue") ?? shown(stages[0]);
  }
  if (!chain || chain.status !== "verified") return shown(stages[0]);
  // The contract's own first break, never re-derived here.
  const atBreak = shown(defaultSelectedTrialStage(chain));
  if (atBreak) return atBreak;
  // Nothing broke, so open the END of the chain: the question a reader brings
  // to a delivered iteration is whether the request was satisfied, not whether
  // the session connected. Where the story finished, not a claim about it.
  const last = chain.stages[chain.stages.length - 1]?.stage;
  return shown(last) ?? shown(stages[0]);
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

  const summary = summarizeTrialScorecard(groups);

  /**
   * The stage the reader picked off the rail, or `null` for "has not picked" —
   * the opening is then derived at render. A different iteration is a different
   * chain, so a carried selection would open a stage this one never broke at.
   */
  const [chosenStage, setChosenStage] = useState<UserValueStage | null>(null);
  useEffect(() => setChosenStage(null), [iteration?._id]);

  /**
   * Blind review masks ONE stage, and only when the judge decided it. The
   * chain's User value row is assertion-decided or judge-decided, never both
   * (`deriveUserValue` is two-tier), so a row whose reason names an assertion
   * has no verdict to leak and stays visible. The other five stages are the
   * runner's observations and are never masked.
   */
  const maskedStage = judgeHidden ? judgeDecidedStage(chain) : null;

  /** The verified chain's row per stage; empty when there is no chain. */
  const chainRows = useMemo(
    () =>
      new Map<UserValueStage, StageResultRow>(
        (chain?.status === "verified" ? chain.stages : []).map((row) => [
          row.stage,
          row,
        ]),
      ),
    [chain],
  );

  /**
   * The state word each section heading shows, read from the same chain the
   * run page draws its cards from: one source, so the two cannot disagree.
   */
  const stageState = (stage: UserValueStage) => {
    const row = chainRows.get(stage);
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

  /**
   * At most ONE sentence about the stage as a whole. The AI note when the
   * report has one; else the recorded floor; else, for a failure no row
   * accounts for, the chain's own reason. Two accounts of one failure read as
   * two failures. Blind review withholds every narrative, so it must not
   * advertise one either.
   */
  const stageSentence = (
    stage: UserValueStage,
    rows: readonly JoinedScorecardRow[],
  ): { text: string; source: "ai" | "recorded" | "chain" } | null => {
    if (judgeHidden && stage === maskedStage) return null;
    const note =
      !judgeHidden && report?.status === "ready"
        ? report.stageNotes?.find((note) => note.stage === stage)
        : undefined;
    if (note) return { text: note.actual, source: "ai" };
    const floor = judgeHidden ? null : stageFloor(stage, chain, trace);
    if (floor) return { text: floor.actual, source: "recorded" };
    const explained = rows.some(
      (row) => row.result.state === "failed" || row.result.state === "error",
    );
    if (explained) return null;
    const reason = chainReasonSentence(chainRows.get(stage));
    return reason ? { text: reason, source: "chain" } : null;
  };

  const userValueStage = chainRows.get("userValue");
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

  // One section per stage that has rows or a chain row, in chain order. A
  // stage the chain measured but nothing grades still gets its heading, so a
  // failure there has somewhere to be read.
  const sections = USER_VALUE_STAGES.flatMap((stage) => {
    const group = groups.find((candidate) => candidate.stage === stage);
    const chainRow = chainRows.get(stage);
    if (!group && !chainRow) return [];
    return [
      {
        stage,
        label: group?.label ?? USER_VALUE_STAGE_LABELS[stage],
        question: group?.question ?? USER_VALUE_STAGE_QUESTIONS[stage],
        rows: group?.rows ?? [],
      },
    ];
  });

  /**
   * A rail needs a verified chain behind it: six links whose states came from
   * somewhere, and a first break to open at. Without one, six neutral dots
   * hiding five of six sections is a worse answer than the stack.
   */
  const railed = chain?.status === "verified" && sections.length > 0;
  const sectionStages = sections.map((section) => section.stage);
  const selectedStage =
    chosenStage && sectionStages.includes(chosenStage)
      ? chosenStage
      : openingStage({
          chain,
          stages: sectionStages,
          judgeHidden,
          maskedStage,
        });
  const visibleSections = railed
    ? sections.filter((section) => section.stage === selectedStage)
    : sections;

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
        {/* The shape it will settle into: a rail, and one stage beside it. */}
        <div
          className="grid gap-6 sm:grid-cols-[170px_minmax(0,1fr)]"
          aria-hidden="true"
        >
          <div className="space-y-1">
            {Array.from({ length: USER_VALUE_STAGES.length }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
          <div className="space-y-3">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-40 w-full" />
          </div>
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

  function renderSection(section: (typeof sections)[number]) {
    const sentence = stageSentence(section.stage, section.rows);
    return (
      <ScorecardGroupSection
        key={section.stage}
        layout="report"
        stage={section.stage}
        label={section.label}
        question={section.question}
        state={stageState(section.stage)}
        evidence={
          sentence ? (
            <p
              className="text-sm leading-relaxed"
              data-narrative-source={
                sentence.source === "chain" ? "recorded" : sentence.source
              }
              {...(sentence.source === "recorded"
                ? { "data-testid": "stage-floor" }
                : sentence.source === "chain"
                  ? { "data-testid": "stage-reason" }
                  : {})}
            >
              <FindingText text={sentence.text} />
            </p>
          ) : undefined
        }
        footer={
          section.stage === "userValue" && showUserValueEvidence ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="user-value-pass-evidence"
            >
              {userValueEvidence.length
                ? userValueEvidence.join(" ")
                : "This run recorded a pass without supporting evidence."}
            </p>
          ) : undefined
        }
      >
        {section.rows.map((row) => (
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
      </ScorecardGroupSection>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4" data-testid="trial-scorecard">
      <section className="space-y-6" aria-label="User value chain">
        {/*
          The tally counts required rows only, and is withheld during blind
          review: a gating judge is one of those rows, and "1 of 1 required
          passed" beside the label control would say the verdict outright.
        */}
        {!judgeHidden && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="trial-scorecard-summary"
          >
            {summaryLine(summary)}
          </p>
        )}
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
        {railed ? (
          <div className="grid gap-6 sm:grid-cols-[170px_minmax(0,1fr)]">
            <StageRail
              cells={buildStageRailCells({
                stages: sectionStages,
                rows: chainRows,
                maskedStage,
              })}
              selected={selectedStage}
              onSelect={setChosenStage}
            />
            <div className="min-w-0 space-y-6">
              {visibleSections.map(renderSection)}
            </div>
          </div>
        ) : (
          visibleSections.map(renderSection)
        )}
        {!judgeHidden ? nextQuestionSlot : null}
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
