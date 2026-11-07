import {
  STAGE_REASON_LABELS,
  USER_VALUE_STAGE_LABELS,
  USER_VALUE_STAGES,
  type EvalRunDecisionDiagnostic,
  type StageReason,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type { EvalIteration } from "../../evals/types";
import { computeIterationResult } from "../../evals/pass-criteria";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";
import { remedyForReason, type StageRemedy } from "../stage-remedy";
import {
  buildStageFixPrompt,
  type StageFixPromptToolCall,
} from "../stage-fix-prompt";

export type TestRunVerdict =
  "passed" | "flaky" | "failed" | "pending" | "undecided" | "empty";

const failedResult = (iteration: EvalIteration) => {
  const result = computeIterationResult(iteration);
  return result === "failed" || result === "timed_out";
};

/**
 * The test run's verdict. Marks are the decision's own per-run case verdicts,
 * so a run whose decision was not read paints no word ("undecided") rather
 * than one guessed from pass counts.
 */
export function testRunVerdict(
  rows: readonly EvaluateCaseRow[],
  iterations: readonly EvalIteration[],
): TestRunVerdict {
  if (iterations.length === 0) return "empty";
  if (
    iterations.some(
      (iteration) => computeIterationResult(iteration) === "pending",
    )
  ) {
    return "pending";
  }
  if (rows.some((row) => row.mark === "failed")) return "failed";
  if (rows.length === 0 || !rows.every((row) => row.mark === "passed")) {
    return "undecided";
  }
  return iterations.some(failedResult) ? "flaky" : "passed";
}

export type TestRunFinding = {
  key: string;
  stage: UserValueStage | null;
  reason: StageReason | null;
  /** Across every launch run; the first is the one "Open iteration" opens. */
  iterationIds: string[];
  /** This test run's iteration count. */
  total: number;
  observed: string;
  remedy: StageRemedy | null;
  representative: EvalRunDecisionDiagnostic | null;
};

function observedSentence(
  stage: UserValueStage | null,
  reason: StageReason | null,
  count: number,
  total: number,
): string {
  const counted = `${count} of ${total} ${total === 1 ? "iteration" : "iterations"}`;
  if (!stage) {
    return `${counted} did not complete, and no stage was established.`;
  }
  const at = `${counted} broke at ${USER_VALUE_STAGE_LABELS[stage]}`;
  return reason ? `${at}: ${STAGE_REASON_LABELS[reason]}.` : `${at}.`;
}

const stageOrder = (stage: UserValueStage | null) =>
  stage ? USER_VALUE_STAGES.indexOf(stage) : USER_VALUE_STAGES.length;

/**
 * One finding per stage and reason across the launch: each launch run's case
 * row groups its own failures, and the same break on two models is one piece
 * of work, so their groups merge.
 */
export function buildTestRunFindings(
  rows: readonly EvaluateCaseRow[],
  total: number,
): TestRunFinding[] {
  const byKey = new Map<string, TestRunFinding>();
  for (const group of rows.flatMap((row) => row.failureGroups)) {
    const key = `${group.stage ?? "none"}:${group.reason ?? "none"}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.iterationIds.push(...group.iterationIds);
      existing.representative ??= group.representative;
      continue;
    }
    byKey.set(key, {
      key,
      stage: group.stage,
      reason: group.reason,
      iterationIds: [...group.iterationIds],
      total,
      observed: "",
      remedy: group.reason ? remedyForReason(group.reason) : null,
      representative: group.representative,
    });
  }
  return [...byKey.values()]
    .map((finding) => ({
      ...finding,
      observed: observedSentence(
        finding.stage,
        finding.reason,
        finding.iterationIds.length,
        total,
      ),
    }))
    .sort(
      (a, b) =>
        b.iterationIds.length - a.iterationIds.length ||
        stageOrder(a.stage) - stageOrder(b.stage),
    );
}

/** The prompt Copy fix prompt hands a coding agent, as the run report's failure groups build it. */
export function testRunFixPrompt(
  finding: TestRunFinding,
  caseTitle: string,
  iterations: readonly EvalIteration[],
): string {
  const diagnostic = finding.representative;
  const iteration = iterations.find(
    (candidate) => candidate._id === finding.iterationIds[0],
  );
  const expected =
    diagnostic?.expected?.toolNames ??
    (iteration?.testCaseSnapshot?.expectedToolCalls ?? []).map(
      (call) => call.toolName,
    );
  const observed: StageFixPromptToolCall[] =
    iteration?.actualToolCalls ??
    (diagnostic?.observed?.toolNames ?? []).map((toolName) => ({ toolName }));
  return buildStageFixPrompt({
    caseTitle,
    stage: finding.stage,
    reason: finding.reason,
    ...(diagnostic?.chain.status === "verified"
      ? {
          chain: diagnostic.chain.stages,
          failureCategory: diagnostic.chain.failureCategory,
        }
      : {}),
    ...(diagnostic?.nextAction ? { nextAction: diagnostic.nextAction } : {}),
    expectedToolCalls: expected.map((toolName) => ({ toolName })),
    observedToolCalls: observed,
    observedFailure: diagnostic?.observed?.failure ?? null,
    iterations: { failed: finding.iterationIds.length, total: finding.total },
    remedy: finding.remedy,
  });
}
