import type { PlatformEvalIterationReport } from "@mcpjam/sdk/platform";
/**
 * What actually happened to each authored scorer, on one trial.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a row shows a SERVER FACT or it says
 * "not measured". It never computes a verdict, never re-evaluates a predicate,
 * and never lets an absent fact read as a pass. Four sources carry those
 * facts, and they are consulted in a fixed precedence per row kind:
 *
 *   `metadata.stepResults`   — the per-step verdict, with its reason. The only
 *                              place a step's "why" survives.
 *   `metadata.predicates`    — the evaluator's own sentence per predicate.
 *                              Present on runs that predate score rows.
 *   `metadata.scores`        — the score contract, joined to its definition by
 *                              RECOMPUTED `definitionHash` (never `scorerId`).
 *                              The only source that can say "error" or
 *                              "skipped" rather than just pass/fail.
 *   the trial chain          — the analyzer's projection, for the route row on
 *                              a run that has no score rows, and the only
 *                              source a built-in runner check reads: it
 *                              reports the stage's own verdict and reason.
 *
 * IDENTITY. Rows join by `hostedCriterionId`, the same function the server
 * mints `scorerId` with. It strips check policy, so flipping a check from Gate
 * to Warn keeps joining its own history; it includes turn scope, so a
 * step-scoped `noToolErrors` never joins the whole-run one. Two identical
 * authored predicates share one criterion id and therefore one result — which
 * is also what the server does, since it de-dupes definitions by id.
 *
 * ADVISORY IS NOT A STATE. An advisory miss is a `failed` FACT; the row's role
 * decides whether it is worn muted or as a red cross. The summary counts
 * required rows only, and it is a tally of facts — the trial's verdict word
 * stays where it already is, on the header.
 */

import {
  definitionHash,
  STAGE_REASON_LABELS,
  STAGE_STATE_LABELS,
  type EvaluationConfigSnapshot,
  type ResolvedScoreDefinition,
  type ScoreResult,
  type ScorerRole,
} from "@mcpjam/sdk/contract";
import type {
  EvalRunDecisionChain,
  StageResultRow,
  UserValueStage,
} from "@mcpjam/sdk/contract";
import {
  hostedCriterionId,
  HOSTED_RUBRIC_CHECKS_SCORER_PREFIX,
} from "@/shared/hosted-criterion-id";
import {
  assembleStepResults,
  type EvalStepEvidence,
  type EvalStepReplay,
  type StepReplayEnvelope,
} from "@/shared/eval-step-replay";
import type { TestStep } from "@/shared/steps";
import { parseIterationPredicates } from "@/components/evals/predicates-list";
import {
  parseEvaluationConfig,
  parseIterationScores,
} from "@/components/evals/scores-list";
import type { EvalStepStatus } from "@/shared/eval-stream-events";
import type { EvalIteration } from "@/components/evals/types";
import type { JudgeCase } from "@/components/evals/goal-completion-presentation";
import {
  RUNNER_OWNED_FAILURE,
  type RunnerCheckStage,
} from "@/components/evals/runner-checks";
import type { ScorecardGroup, ScorecardRow } from "./case-scorecard-model";
import { stageFloor, type StageFloorTrace } from "./stage-floor";
import { isRequiredRole } from "@mcpjam/sdk/predicates";

export type TrialRowResultSource =
  | "stepResult"
  | "predicateResult"
  | "scoreRow"
  | "chainSelection"
  | "chainStage"
  | "judgeCase"
  | "live";

export type TrialRowResult =
  | {
      state: "passed";
      source: TrialRowResultSource;
      reason?: string;
      value?: number;
      threshold?: number;
    }
  | {
      state: "failed";
      source: TrialRowResultSource;
      reason?: string;
      value?: number;
      threshold?: number;
    }
  /**
   * A rubric-check criterion the classifier could not call: P(yes) inside
   * `RUBRIC_CHECK_UNCERTAIN_BAND`. PRESENTATION only — the stored row still
   * says `passed = value >= 0.5`, and nothing gates on it — but a coin flip
   * wearing a pass or a miss glyph reads as a finding it is not.
   */
  | {
      state: "uncertain";
      source: "scoreRow";
      reason?: string;
      value: number;
      threshold?: number;
    }
  | {
      state: "error";
      source: "scoreRow" | "judgeCase" | "chainStage";
      reason: string;
    }
  | {
      state: "skipped";
      source: "stepResult" | "scoreRow" | "chainStage";
      reason?: string;
    }
  | {
      state: "notApplicable";
      source: "scoreRow" | "chainStage";
      reason?: string;
    }
  | { state: "pending"; source: "live" }
  /** `reason` only when the chain said WHY nothing was measured. */
  | { state: "notMeasured"; source?: "chainStage"; reason?: string };

export type TrialRowEvidence = {
  step?: EvalStepEvidence;
  scoreEvidence?: string[];
  /**
   * The role the trial was actually GRADED under, when it differs from what
   * the case now says. A role edited after a run does not re-grade it, and a
   * row that silently showed the new role would misreport what happened.
   *
   * The STORED spelling, verbatim — a run graded before the rename says
   * `"gating"` and one graded after says `"required"`. Read it with
   * `isRequiredRole`; the row renders one word either way.
   */
  frozenRole?: ScorerRole;
  /**
   * A runner check's recorded floor: the sentence a failing tool actually
   * returned, quoted from the trace (`stageFloor`). Kept apart from `reason`
   * so it renders with the marks the trace text carries.
   */
  floor?: string;
};

export type JoinedScorecardRow = ScorecardRow & {
  result: TrialRowResult;
  narrative?: { text: string; stale: boolean; citations: string[] };
  evidence?: TrialRowEvidence;
};

export type JoinedScorecardGroup = Omit<ScorecardGroup, "rows"> & {
  rows: JoinedScorecardRow[];
};

export type TrialFacts = {
  report?: PlatformEvalIterationReport | null;
  iteration: EvalIteration | null;
  /** Authored steps as they were when the trial ran. */
  steps: readonly TestStep[];
  chain?: EvalRunDecisionChain | null;
  judgeCase?: JudgeCase | null;
  envelope?: StepReplayEnvelope | null;
  /** In-flight statuses, while a run is streaming and nothing is persisted. */
  liveStepStatusById?: Map<string, EvalStepStatus>;
  /**
   * The downloaded trace, for the recorded floor a runner check quotes (the
   * sentence a failing tool actually returned). Optional: without it the row
   * still says what the chain decided.
   */
  trace?: StageFloorTrace | null;
};

const NOT_MEASURED: TrialRowResult = { state: "notMeasured" };

type ScoreIndex = {
  byScorerId: Map<
    string,
    { score: ScoreResult; definition: ResolvedScoreDefinition | null }
  >;
};

/**
 * Index score rows by the scorer id of their JOINED definition.
 *
 * The definition is found by recomputed `definitionHash`, exactly as
 * `ScoresList` does — a row whose stamped hash matches no stored definition
 * was produced under a different configuration, and pairing it with the
 * current one is the substitution the integrity model exists to catch. Such a
 * row is simply not indexed, so its scorer reads "not measured" rather than
 * borrowing someone else's verdict.
 */
function indexScores(
  scores: ScoreResult[] | null,
  config: EvaluationConfigSnapshot | null,
): ScoreIndex {
  const byHash = new Map<string, ResolvedScoreDefinition>();
  for (const definition of config?.definitions ?? []) {
    byHash.set(definitionHash(definition), definition);
  }
  const byScorerId = new Map<
    string,
    { score: ScoreResult; definition: ResolvedScoreDefinition | null }
  >();
  for (const score of scores ?? []) {
    const definition = byHash.get(score.definitionHash) ?? null;
    if (!definition) continue;
    byScorerId.set(definition.scorerId, { score, definition });
  }
  return { byScorerId };
}

function resultFromScore(
  score: ScoreResult,
  definition: ResolvedScoreDefinition | null,
): TrialRowResult {
  if (score.status === "error") {
    return {
      state: "error",
      source: "scoreRow",
      reason: score.error ?? "The evaluator could not run.",
    };
  }
  if (score.status === "skipped") {
    return { state: "skipped", source: "scoreRow", reason: score.rationale };
  }
  if (score.status === "not_applicable") {
    return {
      state: "notApplicable",
      source: "scoreRow",
      reason: score.rationale,
    };
  }
  const threshold = definition?.passThreshold ?? score.passThreshold;
  const passed =
    typeof score.value === "number"
      ? score.value >= threshold
      : score.passed === true;
  return {
    state: passed ? "passed" : "failed",
    source: "scoreRow",
    ...(score.rationale ? { reason: score.rationale } : {}),
    ...(typeof score.value === "number" ? { value: score.value } : {}),
    threshold,
  };
}

function stepReplayResult(
  row: EvalStepReplay | undefined,
  terminal: boolean,
): TrialRowResult | null {
  if (!row) return null;
  if (row.status === "ok") {
    return {
      state: "passed",
      source: "stepResult",
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }
  if (row.status === "fail") {
    return {
      state: "failed",
      source: "stepResult",
      ...(row.reason ? { reason: row.reason } : {}),
    };
  }
  if (row.status === "skipped") {
    return {
      state: "skipped",
      source: "stepResult",
      reason:
        row.reason ?? "An earlier step failed, so this one never ran.",
    };
  }
  // `pending` on a finished trial means the runner never reached a verdict for
  // this step — an honest absence, not a hold.
  return terminal ? null : { state: "pending", source: "live" };
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "setup_failed",
  "skipped",
]);

function isTerminal(iteration: EvalIteration | null): boolean {
  if (!iteration) return false;
  return TERMINAL_STATUSES.has(iteration.status as string);
}

/**
 * Fill each row's result from the trial.
 *
 * Pure. Every branch either names a source or returns `notMeasured`.
 */
/** Keyed once per key, so a re-render does not repeat the warning. */
const warnedAmbiguousJoinKeys = new Set<string>();

export function joinTrialResults(
  groups: readonly ScorecardGroup[],
  trial: TrialFacts,
): JoinedScorecardGroup[] {
  const iteration = trial.iteration;
  const metadata = iteration?.metadata;
  const terminal = isTerminal(iteration);

  const stepRows = new Map<string, EvalStepReplay>();
  for (const row of assembleStepResults(
    trial.steps,
    metadata as never,
    (trial.envelope ?? undefined) as never,
  )) {
    stepRows.set(row.stepId, row);
  }

  const predicateResults = parseIterationPredicates(metadata) ?? [];
  const byCriterionId = new Map<
    string,
    (typeof predicateResults)[number]
  >();
  for (const result of predicateResults) {
    byCriterionId.set(
      hostedCriterionId(result.predicate, result.scope),
      result,
    );
  }

  const evaluationConfig = parseEvaluationConfig(metadata);
  const scores = indexScores(parseIterationScores(metadata), evaluationConfig);
  // Scorers this trial was graded with. The arguments row exists only where
  // the trial declared it: a trial graded before the split graded arguments
  // inside the route row, and a second row saying "not measured" would claim
  // they went unchecked.
  const declared = new Set(
    (evaluationConfig?.definitions ?? []).map(
      (definition) => definition.scorerId,
    ),
  );

  // A chain the analyzer withheld (`unverified`) carries no stages at all —
  // and that is the point: it is a refusal to project, not a set of neutral
  // rows. Reading one would be inventing evidence.
  const chainStages = new Map<UserValueStage, StageResultRow>(
    trial.chain && trial.chain.status === "verified"
      ? trial.chain.stages.map((row) => [row.stage, row])
      : [],
  );
  const selectionStage = chainStages.get("selection");

  const graded = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter(
        (row) =>
          row.join?.kind !== "toolArguments" || declared.has(row.join.scorerId),
      ),
    }))
    .filter((group) => group.rows.length > 0);

  return graded.map((group) => ({
    ...group,
    rows: group.rows.map((row) => {
      const joined = joinRow(row, {
        stepRows,
        byCriterionId,
        scores,
        selectionStage,
        chainStages,
        chain: trial.chain ?? null,
        trace: trial.trace ?? null,
        setupFailed: iteration?.status === "setup_failed",
        judgeCase: trial.judgeCase ?? null,
        liveStepStatusById: trial.liveStepStatusById,
        terminal,
      });
      const join = row.join;
      // A widget-assert step row mints no scorer id — the server never graded
      // it as a named scorer — so it has no key and legitimately never
      // receives a narrative. Undefined here means "nothing to match", NOT
      // "match anything".
      const joinKey = !join || join.kind === "stage"
        ? undefined
        : join.kind === "predicate"
        ? `predicate:${join.criterionId}`
        : join.kind === "step"
        ? join.criterionId
          ? `predicate:${join.criterionId}`
          : undefined
        : join.scorerId;
      const matches = joinKey
        ? (trial.report?.rows.filter((note) => note.joinKey === joinKey) ?? [])
        : [];
      // Two notes for one key would make the narrative a coin flip, so the row
      // keeps its recorded observation instead. The server de-dupes scorer
      // definitions by id, so this is a bug in the producer if it ever fires.
      if (matches.length > 1 && !warnedAmbiguousJoinKeys.has(joinKey!)) {
        warnedAmbiguousJoinKeys.add(joinKey!);
        console.warn(
          `[scorecard] ${matches.length} trace narratives claim the scorer "${joinKey}"; showing the recorded observation instead.`,
        );
      }
      const note = matches.length === 1 ? matches[0] : undefined;
      return note
        ? {
            ...joined,
            narrative: {
              text: note.actual,
              citations: note.citations,
              stale:
                trial.report?.status !== "ready" ||
                note.verdictSeen !== joined.result.state,
            },
          }
        : joined;
    }),
  }));
}

type JoinContext = {
  stepRows: Map<string, EvalStepReplay>;
  byCriterionId: Map<
    string,
    { predicate: unknown; passed: boolean; reason: string }
  >;
  scores: ScoreIndex;
  selectionStage:
    | { state: string; reason?: string }
    | undefined;
  /** The verified chain's rows; empty when the chain is absent or withheld. */
  chainStages: Map<UserValueStage, StageResultRow>;
  chain: EvalRunDecisionChain | null;
  trace: StageFloorTrace | null;
  /** The iteration's environment was never prepared. */
  setupFailed: boolean;
  judgeCase: JudgeCase | null;
  liveStepStatusById: Map<string, EvalStepStatus> | undefined;
  terminal: boolean;
};

function joinRow(row: ScorecardRow, ctx: JoinContext): JoinedScorecardRow {
  const join = row.join;
  if (!join) return { ...row, result: NOT_MEASURED };

  if (join.kind === "stage") {
    const result = runnerCheckResult(join.stage, ctx);
    const floor =
      result.state === "failed"
        ? stageFloor(join.stage, ctx.chain, ctx.trace)
        : null;
    return {
      ...row,
      result,
      ...(floor ? { evidence: { floor: floor.actual } } : {}),
    };
  }

  if (join.kind === "step") {
    const replay = ctx.stepRows.get(join.stepId);
    const fromStep = stepReplayResult(replay, ctx.terminal);
    const evidence = replay?.evidence
      ? { step: replay.evidence }
      : undefined;
    const live = !ctx.terminal
      ? ctx.liveStepStatusById?.get(join.stepId)
      : undefined;
    // A synthesized pending replay row carries no result yet. The live event
    // can already know this step passed or failed while later steps run.
    if (fromStep && (fromStep.state !== "pending" || !live)) {
      return { ...row, result: fromStep, ...(evidence ? { evidence } : {}) };
    }
    // Older runs recorded no per-step verdict; the predicate row still carries
    // the evaluator's sentence for the same scoped criterion.
    if (join.criterionId) {
      const predicate = ctx.byCriterionId.get(join.criterionId);
      if (predicate) {
        return {
          ...row,
          result: {
            state: predicate.passed ? "passed" : "failed",
            source: "predicateResult",
            ...(predicate.reason ? { reason: predicate.reason } : {}),
          },
          ...(evidence ? { evidence } : {}),
        };
      }
    }
    if (live) {
      return {
        ...row,
        result: liveResult(live),
        ...(evidence ? { evidence } : {}),
      };
    }
    return {
      ...row,
      result: fromStep ?? NOT_MEASURED,
      ...(evidence ? { evidence } : {}),
    };
  }

  if (join.kind === "predicate") {
    const predicate = ctx.byCriterionId.get(join.criterionId);
    if (predicate) {
      return {
        ...row,
        result: {
          state: predicate.passed ? "passed" : "failed",
          source: "predicateResult",
          ...(predicate.reason ? { reason: predicate.reason } : {}),
        },
      };
    }
    const scored = ctx.scores.byScorerId.get(`predicate:${join.criterionId}`);
    if (scored) {
      return {
        ...row,
        result: resultFromScore(scored.score, scored.definition),
        evidence: scoreEvidence(scored.score, scored.definition, row),
      };
    }
    return { ...row, result: NOT_MEASURED };
  }

  if (join.kind === "toolArguments") {
    const scored = ctx.scores.byScorerId.get(join.scorerId);
    return scored
      ? {
          ...row,
          result: resultFromScore(scored.score, scored.definition),
          evidence: scoreEvidence(scored.score, scored.definition, row),
        }
      : { ...row, result: NOT_MEASURED };
  }

  if (join.kind === "toolMatch") {
    const scored = ctx.scores.byScorerId.get(join.scorerId);
    if (scored) {
      return {
        ...row,
        result: resultFromScore(scored.score, scored.definition),
        evidence: scoreEvidence(scored.score, scored.definition, row),
      };
    }
    // No score rows (a quick run, or an SDK run): the analyzer's own selection
    // verdict is then the fact. Anything other than passed/failed — not
    // reached, not measured, not applicable — is NOT a verdict about the
    // route, so it must not be worn as one.
    const stage = ctx.selectionStage;
    if (stage?.state === "passed" || stage?.state === "failed") {
      return {
        ...row,
        result: {
          state: stage.state,
          source: "chainSelection",
          ...(stage.reason ? { reason: stage.reason } : {}),
        },
      };
    }
    return { ...row, result: NOT_MEASURED };
  }

  // judge
  const scored = ctx.scores.byScorerId.get(join.scorerId);
  if (scored) {
    return {
      ...row,
      result: resultFromScore(scored.score, scored.definition),
      evidence: scoreEvidence(scored.score, scored.definition, row),
    };
  }
  // The goal verdict answers for the goal judge's row ONLY. Any other judge
  // row borrowing it would show the goal judge's score under its own name.
  const judge = ctx.judgeCase;
  if (judge && join.slot === "goalCompletion") {
    return { ...row, result: judgeResult(judge) };
  }
  return { ...row, result: NOT_MEASURED };
}

/**
 * The band, on P(yes), where a rubric-check criterion reads Uncertain. A
 * classifier at 0.51 has not said yes; it has declined to decide.
 */
export const RUBRIC_CHECK_UNCERTAIN_BAND = { from: 0.4, below: 0.6 } as const;

const RUBRIC_CHECK_LABEL_PREFIX = "rubric check: ";

/**
 * The rubric-check rows this trial was ACTUALLY graded with.
 *
 * Built from the trial's stored score rows, joined to their definitions the
 * same way every other row is (recomputed `definitionHash`), rather than from
 * the suite's current criteria: a criterion edited or removed since the run
 * would otherwise show a row this trial was never asked, and a deployment
 * that does not grade rubric checks would show rows that never fill in.
 * Returned in the order the backend asked them, criteria first.
 */
export function rubricCheckTrialRows(
  iteration: EvalIteration | null,
): JoinedScorecardRow[] {
  const metadata = iteration?.metadata;
  if (!metadata) return [];
  const scores = indexScores(
    parseIterationScores(metadata),
    parseEvaluationConfig(metadata),
  );
  const rows: JoinedScorecardRow[] = [];
  for (const [scorerId, { score, definition }] of scores.byScorerId) {
    if (!scorerId.startsWith(HOSTED_RUBRIC_CHECKS_SCORER_PREFIX)) continue;
    const key = scorerId.slice(HOSTED_RUBRIC_CHECKS_SCORER_PREFIX.length);
    const criterion = key.startsWith("c:");
    const stored = definition?.label ?? "";
    const label = stored.startsWith(RUBRIC_CHECK_LABEL_PREFIX)
      ? stored.slice(RUBRIC_CHECK_LABEL_PREFIX.length)
      : stored || key.slice(2);
    const row: ScorecardRow = {
      key: scorerId,
      stage: "userValue",
      provenance: "rubricCheck",
      label,
      kindLabel: "Rubric check",
      role: "advisory",
      roleLock: "judge",
      editable: false,
      rubricCheck: { key, criterion },
      tooltip: criterion
        ? "A suite criterion, asked on its own as a yes or no question. Advisory."
        : "A question the suite added to its rubric checks. Advisory.",
      join: { kind: "judge", slot: "rubricChecks", scorerId },
    };
    const result = resultFromScore(score, definition);
    const evidence = scoreEvidence(score, definition, row);
    rows.push({
      ...row,
      result: criterion ? uncertainIfUndecided(result) : result,
      ...(evidence ? { evidence } : {}),
    });
  }
  return rows;
}

function uncertainIfUndecided(result: TrialRowResult): TrialRowResult {
  if (
    (result.state !== "passed" && result.state !== "failed") ||
    result.source !== "scoreRow" ||
    typeof result.value !== "number" ||
    result.value < RUBRIC_CHECK_UNCERTAIN_BAND.from ||
    result.value >= RUBRIC_CHECK_UNCERTAIN_BAND.below
  ) {
    return result;
  }
  return {
    state: "uncertain",
    source: "scoreRow",
    value: result.value,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.threshold !== undefined ? { threshold: result.threshold } : {}),
  };
}

/** "Failed because the server reported a tool error." — the chain's own words. */
function chainStageSentence(row: StageResultRow): string {
  const state = STAGE_STATE_LABELS[row.state];
  const lead = state.charAt(0).toUpperCase() + state.slice(1);
  // "Never ran (an earlier stage failed)" already says why.
  const reason =
    row.reason &&
    !(row.state === "notReached" && row.reason === "earlierStageFailed")
      ? STAGE_REASON_LABELS[row.reason]
      : undefined;
  return reason ? `${lead} because ${reason}.` : `${lead}.`;
}

const SETUP_ABORTED_SENTENCE = `${STAGE_REASON_LABELS.setupAborted
  .charAt(0)
  .toUpperCase()}${STAGE_REASON_LABELS.setupAborted.slice(1)}.`;

/**
 * "Decided by an evaluator: an assertion on the result did not hold." — what a
 * runner check says when its stage failed for an evaluator's reason.
 */
function evaluatorDecidedSentence(row: StageResultRow): string {
  // A reason newer than this client's catalog has no label; say less rather
  // than print "undefined".
  const label = row.reason ? STAGE_REASON_LABELS[row.reason] : undefined;
  return label ? `Decided by an evaluator: ${label}.` : "Decided by an evaluator.";
}

/**
 * What a built-in runner check reports: the stage's own row from the verified
 * chain, restated, and nothing else.
 *
 * It computes no verdict. The state is the chain's, and so is ACTUAL: the
 * chain's state and reason (the caller adds, as evidence, the sentence a
 * failing tool actually returned). A chain that is absent or withheld leaves
 * the row not measured, like any other row with no fact.
 *
 * With one exception: a failure is the runner check's only when the stage
 * failed for the reason the runner owns (`RUNNER_OWNED_FAILURE`). A stage its
 * evaluators failed — a required assertion, a rejected argument, a widget that
 * did not render — reads as not decided here, never as passed: the analysis
 * stops at the first failing reason, so the runner's own check behind it may
 * never have been read.
 *
 * The one fact it takes from outside the chain is the iteration's own
 * `setup_failed` status: nothing was measured because the environment was
 * never prepared, and that is an error to show, not a silence. A stage the
 * setup signals DID measure (a connection that failed on the server's side)
 * keeps its measured verdict.
 */
function runnerCheckResult(
  stage: RunnerCheckStage,
  ctx: JoinContext,
): TrialRowResult {
  const row = ctx.chainStages.get(stage);
  const measured = row?.state === "passed" || row?.state === "failed";
  if (ctx.setupFailed && !measured) {
    return {
      state: "error",
      source: "chainStage",
      reason: SETUP_ABORTED_SENTENCE,
    };
  }
  if (!row) return NOT_MEASURED;
  const sentence = chainStageSentence(row);
  switch (row.state) {
    case "passed":
      return { state: "passed", source: "chainStage", reason: sentence };
    case "failed":
      return row.reason === RUNNER_OWNED_FAILURE[stage]
        ? { state: "failed", source: "chainStage", reason: sentence }
        : {
            state: "notMeasured",
            source: "chainStage",
            reason: evaluatorDecidedSentence(row),
          };
    case "notApplicable":
      return { state: "notApplicable", source: "chainStage", reason: sentence };
    case "notReached":
      return { state: "skipped", source: "chainStage", reason: sentence };
    default:
      return { state: "notMeasured", source: "chainStage", reason: sentence };
  }
}

function liveResult(status: EvalStepStatus): TrialRowResult {
  if (status === "ok") return { state: "passed", source: "live" };
  if (status === "fail") return { state: "failed", source: "live" };
  if (status === "skipped") return { state: "skipped", source: "stepResult" };
  return { state: "pending", source: "live" };
}

function judgeResult(judge: JudgeCase): TrialRowResult {
  if (judge.status === "error") {
    return {
      state: "error",
      source: "judgeCase",
      reason: judge.reason ?? "The judge could not grade this iteration.",
    };
  }
  if (judge.status === "skipped") {
    return { state: "skipped", source: "scoreRow", reason: judge.reason };
  }
  if (typeof judge.score !== "number") return NOT_MEASURED;
  return {
    state: judge.passed ? "passed" : "failed",
    source: "judgeCase",
    ...(judge.reason ? { reason: judge.reason } : {}),
    value: judge.score,
  };
}

function scoreEvidence(
  score: ScoreResult,
  definition: ResolvedScoreDefinition | null,
  row: ScorecardRow,
): TrialRowEvidence | undefined {
  const authoredIsRequired = row.role === "required";
  const frozen = definition?.role;
  const drifted =
    frozen !== undefined &&
    (isRequiredRole(frozen) !== authoredIsRequired);
  const evidence: TrialRowEvidence = {
    ...(score.evidence && score.evidence.length > 0
      ? { scoreEvidence: [...score.evidence] }
      : {}),
    ...(drifted ? { frozenRole: frozen } : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

export type TrialScorecardSummary = {
  required: { passed: number; counted: number };
  /** Advisory misses, with or without `severity: "warn"`. */
  advisory: number;
  errors: number;
  notMeasured: number;
  pending: number;
};

/**
 * Count REQUIRED rows, and only required rows.
 *
 * An advisory miss is real and is shown on its row, but it did not fail the
 * trial and must not read as though it did. Rows with no measurement are
 * excluded from the denominator rather than counted as failures — "1 of 2"
 * when one scorer never ran would claim a failure nobody observed.
 */
export function summarizeTrialScorecard(
  groups: ReadonlyArray<{ rows: readonly JoinedScorecardRow[] }>,
): TrialScorecardSummary {
  const summary: TrialScorecardSummary = {
    required: { passed: 0, counted: 0 },
    advisory: 0,
    errors: 0,
    notMeasured: 0,
    pending: 0,
  };
  for (const group of groups) {
    for (const row of group.rows) {
      // A runner check is not an evaluator: it reports the stage's verdict,
      // which the rows that decided it are already counted for.
      if (row.provenance === "builtin") continue;
      const { state } = row.result;
      if (state === "notMeasured") summary.notMeasured += 1;
      if (state === "pending") summary.pending += 1;
      if (state === "error") summary.errors += 1;
      if (row.role === "required") {
        if (state === "passed") {
          summary.required.counted += 1;
          summary.required.passed += 1;
        } else if (state === "failed" || state === "error") {
          summary.required.counted += 1;
        }
        continue;
      }
      if (state !== "failed") continue;
      summary.advisory += 1;
    }
  }
  return summary;
}
