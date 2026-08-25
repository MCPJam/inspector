/**
 * The second derivation pass: re-derive one run's stage rows now that a
 * judge has spoken.
 *
 * The first pass (`finalize-iteration.ts`) runs while no judge has finished —
 * the runner must not wait on a model — so `userValue` (and, for a selection
 * failure, `failureCategory`) land on whatever deterministic evidence existed
 * at the time. This pass reruns THE SAME pure SDK analyzer
 * (`deriveStageResults`, reached through the same `buildStageMetadata`, never
 * a second implementation) with whichever advisory evidence has since
 * arrived attached, and posts only the derivation-owned keys.
 *
 * TWO judges feed this ONE pass: goal-completion's `judgeVerdict`
 * (`StageEvidence.judgeEvidence`, tier-2 input to `userValue`) and D7's
 * `metadataAttributionVerdict` (`StageEvidence.metadataAttribution`, tier-2
 * input to `selection`'s `failureCategory`). An iteration can carry either,
 * both, or neither — `deriveIterationPayload` builds ONE unified stage
 * derivation from whatever is present, and the two verdicts are then posted
 * to their OWN backend surfaces, keyed by their OWN job id
 * (`goalCompletionJobId` / `metadataAttributionJobId`) and reported to their
 * OWN fanout state, because the two judges are independently triggered
 * (D7 does not require goal-completion to be enabled on the suite at all —
 * see the D7 plan §2/§3) and a write to one must never block or misreport
 * the other.
 *
 * WHAT IT NEVER DOES: touch `passed`, `iteration.result`, or the run's pass/fail
 * counts. That is the whole reason `dual_write` is safe — a judge can move a
 * stage row and a score row, and nothing it does can move a verdict.
 *
 * Idempotent and safe to re-run: the pass reads current state, derives, and
 * posts; the backend rejects a stale job id and refuses terminal iterations,
 * so a duplicate doorbell produces the same rows and the same reports.
 */

import type { StageEvidence } from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { STAGE_ANALYZER_VERSION } from "@mcpjam/sdk/contract";
import { logger } from "../../utils/logger.js";
import { buildStageMetadata } from "./finalize-iteration.js";
import {
  resolveGradingEngineMode,
  type GradingEngineMode,
} from "./grading-mode.js";
import {
  applyJudgeStageDerivation,
  applyMetadataAttributionStageDerivation,
  fetchRunForJudgeSecondPass,
  markJudgeStageFanout,
  markMetadataAttributionStageFanout,
  JudgeStageBackendError,
  type JudgeDerivationOutcome,
  type JudgeSecondPassIterationRow,
  type JudgeSecondPassRunRow,
} from "./judge-stage-backend.js";
import { buildHostedScoreContract } from "./score-rows.js";

/** Iteration statuses that can still receive a derivation. */
const DERIVABLE_STATUSES = new Set(["completed", "failed"]);

/** The five backend calls this pass makes, injectable for tests. */
export type JudgeSecondPassPorts = {
  fetchRun: typeof fetchRunForJudgeSecondPass;
  applyDerivation: typeof applyJudgeStageDerivation;
  markFanout: typeof markJudgeStageFanout;
  /** D7's write — sibling of `applyDerivation`, own staleness key. */
  applyMetadataAttributionDerivation: typeof applyMetadataAttributionStageDerivation;
  /** D7's fanout report — sibling of `markFanout`, own run-row state. */
  markMetadataAttributionFanout: typeof markMetadataAttributionStageFanout;
};

const defaultPorts: JudgeSecondPassPorts = {
  fetchRun: fetchRunForJudgeSecondPass,
  applyDerivation: applyJudgeStageDerivation,
  markFanout: markJudgeStageFanout,
  applyMetadataAttributionDerivation: applyMetadataAttributionStageDerivation,
  markMetadataAttributionFanout: markMetadataAttributionStageFanout,
};

export type JudgeSecondPassOutcomeEntry = {
  iterationId: string;
  outcome: JudgeDerivationOutcome;
};

export type JudgeSecondPassResult = {
  runId: string;
  mode: GradingEngineMode;
  /** `true` when the pass decided to do nothing (mode, no judge, no run). */
  noop: boolean;
  /** Combined count across both judges — see `outcomes` for goal-completion's own. */
  graded: number;
  /** Goal-completion's own outcomes. Kept as the top-level field for callers
   * that predate D7 — the second, D7-specific set lives in
   * `metadataAttributionOutcomes` so this array's shape never changes. */
  outcomes: JudgeSecondPassOutcomeEntry[];
  /** D7's own outcomes. Empty when this run's `metadataAttributionJobId` is unset. */
  metadataAttributionOutcomes: JudgeSecondPassOutcomeEntry[];
  reason?:
    | "mode_off"
    | "mode_shadow"
    | "run_not_found"
    | "no_job_id"
    | "no_judge_verdicts"
    | "backend_unavailable";
};

/** `metadata.judgeVerdict` as the backend writes it (W2). */
type JudgeVerdictMetadata = {
  status?: unknown;
  verdict?: unknown;
  score?: unknown;
  threshold?: unknown;
  partialFloor?: unknown;
  judgeTemplateVersion?: unknown;
  judgeTemplateHash?: unknown;
  model?: unknown;
};

function readJudgeVerdict(
  metadata: Record<string, unknown> | undefined
): JudgeVerdictMetadata | undefined {
  const verdict = metadata?.judgeVerdict;
  return typeof verdict === "object" && verdict !== null
    ? (verdict as JudgeVerdictMetadata)
    : undefined;
}

/**
 * Project `metadata.judgeVerdict` onto the analyzer's tier-2 evidence.
 *
 * A verdict the judge could not produce becomes `error`, NOT a failure: "the
 * grader broke" and "the product did not deliver" are different rows and the
 * chain has always kept them apart. A `skipped` verdict falls through to
 * whatever the deterministic evidence said, which is the honest reading of a
 * case the judge was never asked about.
 */
export function judgeEvidenceFromVerdict(
  verdict: JudgeVerdictMetadata | undefined
): StageEvidence["judgeEvidence"] | undefined {
  if (!verdict) return undefined;
  const status = verdict.status;
  if (status === "error") {
    return { status: "error" };
  }
  if (status === "skipped") {
    return { status: "skipped" };
  }
  const band = verdict.verdict;
  if (band === "pass" || band === "partial" || band === "fail") {
    return { status: "scored", verdict: band };
  }
  // A verdict row with no band is a judge that was owed an answer and has not
  // produced one — `judgePending`, never a silent pass.
  return { status: "pending", pendingKind: "scheduled" };
}

/** `metadata.metadataAttributionVerdict` as the backend writes it (D7). */
type MetadataAttributionVerdictMetadata = {
  status?: unknown;
  attributed?: unknown;
  reasons?: unknown;
};

function readMetadataAttributionVerdict(
  metadata: Record<string, unknown> | undefined
): MetadataAttributionVerdictMetadata | undefined {
  const verdict = metadata?.metadataAttributionVerdict;
  return typeof verdict === "object" && verdict !== null
    ? (verdict as MetadataAttributionVerdictMetadata)
    : undefined;
}

/**
 * Project `metadata.metadataAttributionVerdict` onto the analyzer's tier-2
 * evidence. Mirrors `judgeEvidenceFromVerdict`'s subordination rules exactly
 * — a broken judge is `error`, never a failure; a status the backend has not
 * produced yet is `pending`, never a silent `attributed: false`.
 */
export function metadataAttributionEvidenceFromVerdict(
  verdict: MetadataAttributionVerdictMetadata | undefined
): StageEvidence["metadataAttribution"] | undefined {
  if (!verdict) return undefined;
  const status = verdict.status;
  if (status === "error") {
    return { status: "error" };
  }
  if (status === "skipped") {
    return { status: "skipped" };
  }
  if (status === "scored") {
    const reasons = Array.isArray(verdict.reasons)
      ? verdict.reasons.filter(
          (r): r is string => typeof r === "string" && r.length > 0
        )
      : undefined;
    return {
      status: "scored",
      attributed: verdict.attributed === true,
      ...(reasons && reasons.length > 0 ? { reasons } : {}),
    };
  }
  if (status === "not_applicable") {
    // A terminal, already-decided outcome ("the judge doesn't apply here")
    // — distinct from `pending`, which means a verdict is still owed. Fell
    // through to `pending` before this branch existed, which would have
    // misled any retry/sweep logic that distinguishes the two.
    return { status: "not_applicable" };
  }
  return { status: "pending", pendingKind: "scheduled" };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * A stored `metadata.predicates` row.
 *
 * The rows were written by the runner from `PredicateResult`, so the shape is
 * ours; the guard narrows the two fields the projection reads rather than
 * trusting the whole document, and the predicate body is passed through to the
 * definition hash exactly as stored (rehashing a re-parsed predicate is how a
 * `definitionHash` stops matching the one the first pass wrote).
 */
type StoredPredicateRow = {
  predicate: Predicate;
  passed: boolean;
  reason?: string;
};

function isPredicateRow(value: unknown): value is StoredPredicateRow {
  const record = asRecord(value);
  return (
    typeof record?.passed === "boolean" &&
    asRecord(record.predicate) !== undefined
  );
}

/** Everything the derivation needs from one stored iteration. */
function deriveIterationPayload(args: {
  iteration: JudgeSecondPassIterationRow;
  mode: GradingEngineMode;
  judgeVerdict: JudgeVerdictMetadata | undefined;
  attributionVerdict: MetadataAttributionVerdictMetadata | undefined;
}): { stage: Record<string, unknown>; scores?: unknown[]; config?: unknown } {
  const { iteration, judgeVerdict, attributionVerdict } = args;
  const metadata = iteration.metadata ?? {};
  const judgeEvidence = judgeEvidenceFromVerdict(judgeVerdict);
  const metadataAttribution = metadataAttributionEvidenceFromVerdict(
    attributionVerdict
  );
  const predicateRows = (asArray(metadata.predicates) ?? []).filter(
    isPredicateRow
  );
  const stage = buildStageMetadata({
    ...(iteration.stageCase ? { stageCase: iteration.stageCase } : {}),
    ...(iteration.spans?.length ? { spans: iteration.spans } : {}),
    ...(iteration.prompts?.length ? { prompts: iteration.prompts } : {}),
    ...(iteration.messages?.length ? { messages: iteration.messages } : {}),
    ...(predicateRows.length ? { predicateResults: predicateRows } : {}),
    ...(iteration.toolSignals ? { toolSignals: iteration.toolSignals } : {}),
    ...(iteration.setupSignals
      ? { setupSignals: iteration.setupSignals }
      : {}),
    ...(judgeEvidence ? { judgeEvidence } : {}),
    ...(metadataAttribution ? { metadataAttribution } : {}),
    status: iteration.status === "failed" ? "failed" : "completed",
    ...(iteration.error ? { error: iteration.error } : {}),
  });

  if (args.mode !== "dual_write") return { stage };

  const { scores, evaluationConfig } = buildHostedScoreContract({
    ...(predicateRows.length
      ? {
          predicateResults: predicateRows.map((row) => ({
            predicate: row.predicate,
            passed: row.passed,
            ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
          })),
        }
      : {}),
    ...(judgeVerdict && isFiniteNumber(judgeVerdict.threshold)
      ? { judgeVerdict }
      : {}),
  });
  return scores.length > 0
    ? { stage, scores, config: evaluationConfig }
    : { stage };
}

/** The derivation-owned fields common to both judges' write bodies. */
function stageFields(stage: Record<string, unknown>) {
  return {
    ...(asArray(stage.stageResults)
      ? { stageResults: asArray(stage.stageResults) }
      : {}),
    ...(typeof stage.firstFailedStage === "string"
      ? { firstFailedStage: stage.firstFailedStage }
      : {}),
    ...(typeof stage.failureCategory === "string"
      ? { failureCategory: stage.failureCategory }
      : {}),
    stageAnalyzerVersion:
      typeof stage.stageAnalyzerVersion === "number"
        ? stage.stageAnalyzerVersion
        : STAGE_ANALYZER_VERSION,
  };
}

/**
 * Grade one run's iterations, if this run's mode says to.
 *
 * THE MODE CHECK IS NOT THE ROUTE'S ALONE. Both judges' save mutations ring
 * the doorbell on every save without consulting the grading mode, so this
 * function re-resolves the mode from the run's own snapshot and stops when it
 * is not `dual_write`. `shadow` deliberately writes NOTHING here: a shadow row
 * is produced in-process by the first pass, and a second-pass write is by
 * definition a real write.
 */
export async function runJudgeSecondPass(
  runId: string,
  ports: JudgeSecondPassPorts = defaultPorts
): Promise<JudgeSecondPassResult> {
  const emptyResult = (
    mode: GradingEngineMode,
    reason: JudgeSecondPassResult["reason"]
  ): JudgeSecondPassResult => ({
    runId,
    mode,
    noop: true,
    graded: 0,
    outcomes: [],
    metadataAttributionOutcomes: [],
    reason,
  });

  const envMode = resolveGradingEngineMode();
  if (envMode === "off") {
    return emptyResult("off", "mode_off");
  }

  let run: JudgeSecondPassRunRow;
  try {
    run = await ports.fetchRun(runId);
  } catch (error) {
    if (error instanceof JudgeStageBackendError && error.isRouteMissing) {
      logger.warn("[evals] judge second pass: backend read route unavailable", {
        runId,
      });
      return emptyResult(envMode, "backend_unavailable");
    }
    throw error;
  }

  const mode = resolveGradingEngineMode({
    runSnapshot: run.configSnapshot?.gradingEngine ?? run.gradingEngine,
  });
  if (mode !== "dual_write") {
    return emptyResult(mode, mode === "off" ? "mode_off" : "mode_shadow");
  }

  const goalCompletionJobId = run.goalCompletionJobId;
  const metadataAttributionJobId = run.metadataAttributionJobId;
  if (goalCompletionJobId === undefined && metadataAttributionJobId === undefined) {
    // Without a job id the backend cannot tell this derivation from a stale
    // one, and a derivation it cannot date is one it should not accept.
    return emptyResult(mode, "no_job_id");
  }

  const derivedAt = Date.now();
  const goalCompletionOutcomes: JudgeSecondPassOutcomeEntry[] = [];
  const metadataAttributionOutcomes: JudgeSecondPassOutcomeEntry[] = [];
  let goalCompletionFailed = false;
  let metadataAttributionFailed = false;

  for (const iteration of run.iterations ?? []) {
    const judgeVerdict = readJudgeVerdict(iteration.metadata);
    const attributionVerdict = readMetadataAttributionVerdict(
      iteration.metadata
    );
    // No verdict of either kind ⇒ no advisory evidence ⇒ nothing this pass
    // could change. Send NOTHING, and do not report the iteration: it was
    // not graded by anyone.
    if (!judgeVerdict && !attributionVerdict) continue;
    if (
      iteration.status !== undefined &&
      !DERIVABLE_STATUSES.has(iteration.status)
    ) {
      continue;
    }

    // Each judge's write is derived and posted SEPARATELY, never from one
    // shared payload — the backend applies `stageResults` /
    // `failureCategory` as a full-field overwrite (see
    // `internalApplyJudgeStageDerivation`), keyed and staleness-checked
    // against only ITS OWN job id. A single combined derivation sent to both
    // endpoints would let a stale/rejected write from one judge still land
    // via the other's successful write — e.g. a metadata-attribution job
    // superseded mid-pass could still persist `failureCategory: "metadata"`
    // through goal-completion's still-valid channel, or vice versa.
    //
    // Goal-completion's derivation therefore NEVER attaches
    // `metadataAttribution` — D7's evidence has no business riding through a
    // channel that only validates `goalCompletionJobId`. D7's derivation
    // attaches `judgeEvidence` only once THIS pass has actually confirmed
    // goal-completion's own write (or goal-completion has nothing to
    // confirm at all, i.e. no job id on this run) — so D7's write, if it
    // lands, either carries a durably-written userValue conclusion or none,
    // never one whose own write this pass just saw rejected.
    let goalCompletionConfirmed = false;

    if (
      judgeVerdict &&
      goalCompletionJobId !== undefined &&
      !goalCompletionFailed
    ) {
      const { stage, scores, config } = deriveIterationPayload({
        iteration,
        mode,
        judgeVerdict,
        attributionVerdict: undefined,
      });
      if (Object.keys(stage).length > 0) {
        const fields = stageFields(stage);
        try {
          const result = await ports.applyDerivation(iteration.iterationId, {
            goalCompletionJobId,
            judgeStageDerivedAt: derivedAt,
            ...fields,
            ...(scores ? { scores } : {}),
            ...(config !== undefined ? { evaluationConfig: config } : {}),
          });
          goalCompletionOutcomes.push({
            iterationId: iteration.iterationId,
            outcome: result.outcome,
          });
          // `stale` / `deferred` / `skipped_terminal` are normal RETURN
          // VALUES, not exceptions (see `JudgeDerivationOutcome`) — a
          // `stale` outcome means the backend refused to persist anything
          // for a job id that has moved on. Only `applied` means the
          // derivation actually landed, which is the only case D7's write
          // below may safely chain judgeEvidence from.
          goalCompletionConfirmed = result.outcome === "applied";
        } catch (error) {
          if (error instanceof JudgeStageBackendError && error.isNotFound) {
            // The row is gone. Nothing to report for it, and nothing to retry.
          } else if (
            error instanceof JudgeStageBackendError &&
            (error.isConflict || error.isRouteMissing)
          ) {
            // The run moved under us, or the surface is not deployed. Either
            // way a retry races the same way, so stop this judge's writes and
            // let the sweep decide — but D7's writes below are unaffected.
            goalCompletionFailed = true;
          } else {
            goalCompletionFailed = true;
            logger.warn("[evals] judge second pass: derivation write failed", {
              runId,
              iterationId: iteration.iterationId,
              judge: "goalCompletion",
              error: error instanceof Error ? error.name : "unknown",
            });
          }
        }
      }
    }

    if (
      attributionVerdict &&
      metadataAttributionJobId !== undefined &&
      !metadataAttributionFailed
    ) {
      const includeJudgeEvidence =
        judgeVerdict !== undefined &&
        (goalCompletionConfirmed || goalCompletionJobId === undefined);
      const { stage } = deriveIterationPayload({
        iteration,
        mode,
        judgeVerdict: includeJudgeEvidence ? judgeVerdict : undefined,
        attributionVerdict,
      });
      if (Object.keys(stage).length === 0) continue;
      const fields = stageFields(stage);
      try {
        const result = await ports.applyMetadataAttributionDerivation(
          iteration.iterationId,
          {
            metadataAttributionJobId,
            judgeStageDerivedAt: derivedAt,
            ...fields,
          }
        );
        metadataAttributionOutcomes.push({
          iterationId: iteration.iterationId,
          outcome: result.outcome,
        });
      } catch (error) {
        if (error instanceof JudgeStageBackendError && error.isNotFound) {
          // no-op, same reasoning as goal-completion's NotFound above
        } else if (
          error instanceof JudgeStageBackendError &&
          (error.isConflict || error.isRouteMissing)
        ) {
          metadataAttributionFailed = true;
        } else {
          metadataAttributionFailed = true;
          logger.warn("[evals] judge second pass: derivation write failed", {
            runId,
            iterationId: iteration.iterationId,
            judge: "metadataAttribution",
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    }
  }

  const nothingGraded =
    goalCompletionOutcomes.length === 0 &&
    metadataAttributionOutcomes.length === 0;
  if (nothingGraded && !goalCompletionFailed && !metadataAttributionFailed) {
    return emptyResult(mode, "no_judge_verdicts");
  }

  if (
    goalCompletionJobId !== undefined &&
    (goalCompletionOutcomes.length > 0 || goalCompletionFailed)
  ) {
    try {
      await ports.markFanout({
        runId,
        goalCompletionJobId,
        outcomes: goalCompletionOutcomes,
        ...(goalCompletionFailed ? { failed: true } : {}),
      });
    } catch (error) {
      // The sweep is the delivery guarantee: an unreported pass is retried,
      // and a retry is idempotent, so a failed report costs a minute rather
      // than a derivation.
      logger.warn("[evals] judge second pass: fanout report failed", {
        runId,
        judge: "goalCompletion",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  if (
    metadataAttributionJobId !== undefined &&
    (metadataAttributionOutcomes.length > 0 || metadataAttributionFailed)
  ) {
    try {
      await ports.markMetadataAttributionFanout({
        runId,
        metadataAttributionJobId,
        outcomes: metadataAttributionOutcomes,
        ...(metadataAttributionFailed ? { failed: true } : {}),
      });
    } catch (error) {
      logger.warn("[evals] judge second pass: fanout report failed", {
        runId,
        judge: "metadataAttribution",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return {
    runId,
    mode,
    noop: false,
    graded: goalCompletionOutcomes.length + metadataAttributionOutcomes.length,
    outcomes: goalCompletionOutcomes,
    metadataAttributionOutcomes,
  };
}
