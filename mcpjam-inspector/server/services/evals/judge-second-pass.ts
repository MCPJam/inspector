/**
 * The second derivation pass: re-derive one run's stage rows now that the
 * judge has spoken.
 *
 * The first pass (`finalize-iteration.ts`) runs while the judge has not started
 * — the runner must not wait on a model — so `userValue` lands on whatever
 * deterministic evidence existed at the time. This pass reruns THE SAME pure
 * SDK analyzer (`deriveStageResults`, reached through the same
 * `buildStageMetadata`, never a second implementation) with `judgeEvidence`
 * attached, and posts only the derivation-owned keys.
 *
 * WHAT IT NEVER DOES: touch `passed`, `iteration.result`, or the run's pass/fail
 * counts. That is the whole reason `dual_write` is safe — a judge can move a
 * stage row and a score row, and nothing it does can move a verdict.
 *
 * Idempotent and safe to re-run: the pass reads current state, derives, and
 * posts; the backend rejects a stale `goalCompletionJobId` and refuses terminal
 * iterations, so a duplicate doorbell produces the same rows and the same
 * report.
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
  fetchRunForJudgeSecondPass,
  markJudgeStageFanout,
  JudgeStageBackendError,
  type JudgeDerivationOutcome,
  type JudgeSecondPassIterationRow,
  type JudgeSecondPassRunRow,
} from "./judge-stage-backend.js";
import { buildHostedScoreContract } from "./score-rows.js";

/** Iteration statuses that can still receive a derivation. */
const DERIVABLE_STATUSES = new Set(["completed", "failed"]);

/** The three backend calls this pass makes, injectable for tests. */
export type JudgeSecondPassPorts = {
  fetchRun: typeof fetchRunForJudgeSecondPass;
  applyDerivation: typeof applyJudgeStageDerivation;
  markFanout: typeof markJudgeStageFanout;
};

const defaultPorts: JudgeSecondPassPorts = {
  fetchRun: fetchRunForJudgeSecondPass,
  applyDerivation: applyJudgeStageDerivation,
  markFanout: markJudgeStageFanout,
};

export type JudgeSecondPassResult = {
  runId: string;
  mode: GradingEngineMode;
  /** `true` when the pass decided to do nothing (mode, no judge, no run). */
  noop: boolean;
  graded: number;
  outcomes: Array<{ iterationId: string; outcome: JudgeDerivationOutcome }>;
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
  goalCompletionJobId: string | number;
}): { stage: Record<string, unknown>; scores?: unknown[]; config?: unknown } {
  const { iteration } = args;
  const metadata = iteration.metadata ?? {};
  const verdict = readJudgeVerdict(metadata);
  const judgeEvidence = judgeEvidenceFromVerdict(verdict);
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
    ...(verdict && isFiniteNumber(verdict.threshold)
      ? { judgeVerdict: verdict }
      : {}),
  });
  return scores.length > 0
    ? { stage, scores, config: evaluationConfig }
    : { stage };
}

/**
 * Grade one run's iterations, if this run's mode says to.
 *
 * THE MODE CHECK IS NOT THE ROUTE'S ALONE. W2's `saveGoalCompletion` rings the
 * doorbell on every judge save without consulting the grading mode, so this
 * function re-resolves the mode from the run's own snapshot and stops when it
 * is not `dual_write`. `shadow` deliberately writes NOTHING here: a shadow row
 * is produced in-process by the first pass, and a second-pass write is by
 * definition a real write.
 */
export async function runJudgeSecondPass(
  runId: string,
  ports: JudgeSecondPassPorts = defaultPorts
): Promise<JudgeSecondPassResult> {
  const envMode = resolveGradingEngineMode();
  if (envMode === "off") {
    return { runId, mode: "off", noop: true, graded: 0, outcomes: [], reason: "mode_off" };
  }

  let run: JudgeSecondPassRunRow;
  try {
    run = await ports.fetchRun(runId);
  } catch (error) {
    if (error instanceof JudgeStageBackendError && error.isRouteMissing) {
      logger.warn("[evals] judge second pass: backend read route unavailable", {
        runId,
      });
      return {
        runId,
        mode: envMode,
        noop: true,
        graded: 0,
        outcomes: [],
        reason: "backend_unavailable",
      };
    }
    throw error;
  }

  const mode = resolveGradingEngineMode({
    runSnapshot: run.configSnapshot?.gradingEngine ?? run.gradingEngine,
  });
  if (mode !== "dual_write") {
    return {
      runId,
      mode,
      noop: true,
      graded: 0,
      outcomes: [],
      reason: mode === "off" ? "mode_off" : "mode_shadow",
    };
  }

  const goalCompletionJobId = run.goalCompletionJobId;
  if (goalCompletionJobId === undefined) {
    // Without the job id the backend cannot tell this derivation from a stale
    // one, and a derivation it cannot date is one it should not accept.
    return {
      runId,
      mode,
      noop: true,
      graded: 0,
      outcomes: [],
      reason: "no_job_id",
    };
  }

  const derivedAt = Date.now();
  const outcomes: Array<{
    iterationId: string;
    outcome: JudgeDerivationOutcome;
  }> = [];
  let failed = false;

  for (const iteration of run.iterations ?? []) {
    // No verdict ⇒ no judge evidence ⇒ nothing this pass could change. Send
    // NOTHING, and do not report the iteration: it was not graded.
    if (!readJudgeVerdict(iteration.metadata)) continue;
    if (
      iteration.status !== undefined &&
      !DERIVABLE_STATUSES.has(iteration.status)
    ) {
      continue;
    }

    const { stage, scores, config } = deriveIterationPayload({
      iteration,
      mode,
      goalCompletionJobId,
    });
    if (Object.keys(stage).length === 0) continue;

    try {
      const result = await ports.applyDerivation(iteration.iterationId, {
        goalCompletionJobId,
        judgeStageDerivedAt: derivedAt,
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
        ...(scores ? { scores } : {}),
        ...(config !== undefined ? { evaluationConfig: config } : {}),
      });
      outcomes.push({
        iterationId: iteration.iterationId,
        outcome: result.outcome,
      });
    } catch (error) {
      if (error instanceof JudgeStageBackendError) {
        if (error.isNotFound) {
          // The row is gone. Nothing to report for it, and nothing to retry.
          continue;
        }
        if (error.isConflict || error.isRouteMissing) {
          // The run moved under us, or the surface is not deployed. Either way
          // a retry races the same way, so stop and let the sweep decide.
          failed = true;
          break;
        }
      }
      failed = true;
      logger.warn("[evals] judge second pass: derivation write failed", {
        runId,
        iterationId: iteration.iterationId,
        error: error instanceof Error ? error.name : "unknown",
      });
      break;
    }
  }

  if (outcomes.length === 0 && !failed) {
    return {
      runId,
      mode,
      noop: true,
      graded: 0,
      outcomes: [],
      reason: "no_judge_verdicts",
    };
  }

  try {
    await ports.markFanout({
      runId,
      goalCompletionJobId,
      outcomes,
      ...(failed ? { failed: true } : {}),
    });
  } catch (error) {
    // The sweep is the delivery guarantee: an unreported pass is retried, and
    // a retry is idempotent, so a failed report costs a minute rather than a
    // derivation.
    logger.warn("[evals] judge second pass: fanout report failed", {
      runId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  return { runId, mode, noop: false, graded: outcomes.length, outcomes };
}
