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
 *                              a run that has no score rows.
 *
 * IDENTITY. Rows join by `hostedCriterionId`, the same function the server
 * mints `scorerId` with. It strips check policy, so flipping a check from Gate
 * to Warn keeps joining its own history; it includes turn scope, so a
 * step-scoped `noToolErrors` never joins the whole-run one. Two identical
 * authored predicates share one criterion id and therefore one result — which
 * is also what the server does, since it de-dupes definitions by id.
 *
 * ADVISORY IS NOT A STATE. An advisory miss is a `failed` FACT; the row's role
 * decides whether it is worn as a Warn, a muted "reported", or a red cross.
 * The summary counts gates only, and it is a tally of facts — the trial's
 * verdict word stays where it already is, on the header.
 */

import {
  definitionHash,
  type EvaluationConfigSnapshot,
  type ResolvedScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
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
import type { ScorecardGroup, ScorecardRow } from "./case-scorecard-model";

export type TrialRowResultSource =
  | "stepResult"
  | "predicateResult"
  | "scoreRow"
  | "chainSelection"
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
  | { state: "error"; source: "scoreRow" | "judgeCase"; reason: string }
  | { state: "skipped"; source: "stepResult" | "scoreRow"; reason?: string }
  | { state: "notApplicable"; source: "scoreRow"; reason?: string }
  | { state: "pending"; source: "live" }
  | { state: "notMeasured" };

export type TrialRowEvidence = {
  step?: EvalStepEvidence;
  scoreEvidence?: string[];
  /**
   * The role the trial was actually GRADED under, when it differs from what
   * the case now says. A role edited after a run does not re-grade it, and a
   * row that silently showed the new role would misreport what happened.
   */
  frozenRole?: "gating" | "advisory";
};

export type JoinedScorecardRow = ScorecardRow & {
  result: TrialRowResult;
  evidence?: TrialRowEvidence;
};

export type JoinedScorecardGroup = Omit<ScorecardGroup, "rows"> & {
  rows: JoinedScorecardRow[];
};

export type TrialFacts = {
  iteration: EvalIteration | null;
  /** Authored steps as they were when the trial ran. */
  steps: readonly TestStep[];
  chain?: EvalRunDecisionChain | null;
  judgeCase?: JudgeCase | null;
  envelope?: StepReplayEnvelope | null;
  /** In-flight statuses, while a run is streaming and nothing is persisted. */
  liveStepStatusById?: Map<string, EvalStepStatus>;
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

  const scores = indexScores(
    parseIterationScores(metadata),
    parseEvaluationConfig(metadata),
  );

  // A chain the analyzer withheld (`unverified`) carries no stages at all —
  // and that is the point: it is a refusal to project, not a set of neutral
  // rows. Reading one would be inventing evidence.
  const selectionStage =
    trial.chain && trial.chain.status === "verified"
      ? trial.chain.stages.find((stage) => stage.stage === "selection")
      : undefined;

  return groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) =>
      joinRow(row, {
        stepRows,
        byCriterionId,
        scores,
        selectionStage,
        judgeCase: trial.judgeCase ?? null,
        liveStepStatusById: trial.liveStepStatusById,
        terminal,
      }),
    ),
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
  judgeCase: JudgeCase | null;
  liveStepStatusById: Map<string, EvalStepStatus> | undefined;
  terminal: boolean;
};

function joinRow(row: ScorecardRow, ctx: JoinContext): JoinedScorecardRow {
  const join = row.join;
  if (!join) return { ...row, result: NOT_MEASURED };

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
  const judge = ctx.judgeCase;
  if (judge) return { ...row, result: judgeResult(judge) };
  return { ...row, result: NOT_MEASURED };
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
  const authoredIsGating = row.role === "gate";
  const frozen = definition?.role;
  const drifted =
    frozen !== undefined &&
    ((frozen === "gating") !== authoredIsGating);
  const evidence: TrialRowEvidence = {
    ...(score.evidence && score.evidence.length > 0
      ? { scoreEvidence: [...score.evidence] }
      : {}),
    ...(drifted ? { frozenRole: frozen } : {}),
  };
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

export type TrialScorecardSummary = {
  gates: { passed: number; counted: number };
  warn: number;
  report: number;
  errors: number;
  notMeasured: number;
  pending: number;
};

/**
 * Count GATES, and only gates.
 *
 * A Warn or Report miss is real and is shown on its row, but it did not fail
 * the trial and must not read as though it did. Rows with no measurement are
 * excluded from the denominator rather than counted as failures — "1 of 2"
 * when one scorer never ran would claim a failure nobody observed.
 */
export function summarizeTrialScorecard(
  groups: ReadonlyArray<{ rows: readonly JoinedScorecardRow[] }>,
): TrialScorecardSummary {
  const summary: TrialScorecardSummary = {
    gates: { passed: 0, counted: 0 },
    warn: 0,
    report: 0,
    errors: 0,
    notMeasured: 0,
    pending: 0,
  };
  for (const group of groups) {
    for (const row of group.rows) {
      const { state } = row.result;
      if (state === "notMeasured") summary.notMeasured += 1;
      if (state === "pending") summary.pending += 1;
      if (state === "error") summary.errors += 1;
      if (row.role === "gate") {
        if (state === "passed") {
          summary.gates.counted += 1;
          summary.gates.passed += 1;
        } else if (state === "failed" || state === "error") {
          summary.gates.counted += 1;
        }
        continue;
      }
      if (state !== "failed") continue;
      if (row.role === "warn") summary.warn += 1;
      else summary.report += 1;
    }
  }
  return summary;
}
