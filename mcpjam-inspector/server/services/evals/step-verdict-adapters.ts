// Phase-4 PR3 (plan: please-do-a-sequential-fail-fast-verdict.md).
//
// Fact adapters: normalize `executeSteps` execution FACTS into the existing
// `buildEvalIterationVerdict` inputs. They bucket / scope / label already-produced
// facts — they do NOT evaluate (no matcher, no predicate eval, no gating). The
// verdict boundary still owns all of that.

import { stepTurnIndices, type TestStep } from "@/shared/steps";
import type { PredicateResult, ToolCall } from "@/shared/eval-matching";
import type { EvalStepResultRecord } from "@/shared/eval-step-replay";
import type { StepExecutionState } from "./step-executor";

/**
 * Failed `interact` steps + failed widget-DOM `assert` steps, shaped as the
 * verdict's `scriptedCheckFailures` ({toolName, reason}). These outcomes live in
 * `StepExecutionState` (the explicit `replayInteractStep`/`evaluateWidgetAssertion`
 * API does NOT populate `browser.scriptedCheckFailures`), so without folding them
 * back in, a failed click/DOM-assert would NOT fail the iteration on the
 * executeSteps path. Transcript-predicate asserts (`predicateResult` set) are
 * EXCLUDED — they already gate via the predicate results. (TL-flagged §2 gap.)
 */
export function buildStepScriptedCheckFailures(
  state: Pick<StepExecutionState, "interactionFailures" | "assertionResults">,
): { toolName: string; reason: string }[] {
  return [
    ...state.interactionFailures.map((f) => ({
      toolName: f.toolName,
      reason: f.reason,
    })),
    ...state.assertionResults
      .filter((r) => !r.passed && r.predicateResult === undefined)
      .map((r) => ({ toolName: "widget-assertion", reason: r.reason })),
  ];
}

/**
 * Densify the per-turn tool-call bucket to the `ToolCall[][]` shape
 * `evaluateMultiTurnResults` indexes by turn — one slot per turn, `[]` where a
 * turn issued no calls. `turnCount` aligns with `promptTurns.length` (a trailing
 * turn with no calls still needs its empty slot).
 */
export function bucketStepToolCallsByPrompt(
  state: Pick<StepExecutionState, "toolCallsByTurn">,
  turnCount: number,
): ToolCall[][] {
  const out: ToolCall[][] = [];
  for (let i = 0; i < turnCount; i++) out.push(state.toolCallsByTurn[i] ?? []);
  return out;
}

/**
 * Transcript-predicate assert results → per-turn `PredicateResult[]`, scope-tagged
 * by the assert step's turn ordinal (`stepTurnIndices`). These are the step path's
 * equivalent of the legacy `turnCheckResults`; `buildEvalIterationVerdict` prepends
 * the case-level results, yielding the `[case, …per-turn]` ordering (invariant #2).
 *
 * Widget DOM-assert results carry no `predicateResult` (they're gate-only until
 * PR7c), so they're excluded here — they still fail the verdict via
 * `interactionFailures`/assert `passed:false`, just not as `metadata.predicates` rows.
 */
/**
 * After `executeSteps`, derive per-turn predicate results from step assert
 * facts (not a re-evaluation of `promptTurns.checks`). Replaces the legacy
 * `buildTurnCheckResults(promptTurns)` path whenever the sequential executor
 * ran — avoids duplicate rows and fixes hosted parity (hosted used `[]`).
 */
export function resolveTurnCheckResultsFromStepExecution(
  state: Pick<StepExecutionState, "assertionResults">,
  steps: TestStep[],
): PredicateResult[] {
  return buildStepCheckResults(state, steps);
}

/**
 * Collapse the executor's per-step facts onto the authored step list — ONE
 * verdict row per step, keyed by `stepId` — for persistence at
 * `testIteration.metadata.stepResults`. This is the clean per-step contract the
 * public `/steps` API projects: the lossy `metadata.predicates` rows are
 * turn-scoped (no `stepId`), interact failures aren't persisted at all, and
 * widget-DOM asserts are gate-only — so we write the rows the runner already has.
 *
 * Status per kind:
 *   - any step in `skippedSteps`            → "skipped" (fail-fast halted before it ran)
 *   - `assert`                              → from `assertionResults[stepId].passed`
 *   - `interact`                            → "fail" if in `interactionFailures`, else "ok"
 *   - `prompt` / `toolCall`                 → "ok" (executed; cycle errors are iteration-level)
 */
export function buildStepResultRecords(
  state: Pick<
    StepExecutionState,
    "assertionResults" | "interactionFailures" | "skippedSteps"
  >,
  steps: TestStep[],
): EvalStepResultRecord[] {
  const skipped = new Map(state.skippedSteps.map((s) => [s.stepId, s]));
  const asserts = new Map(state.assertionResults.map((r) => [r.stepId, r]));
  const interactFails = new Map(
    state.interactionFailures.map((f) => [f.stepId, f]),
  );
  return steps.map((step, stepIndex) => {
    const base = { stepId: step.id, stepIndex, kind: step.kind } as const;
    const skip = skipped.get(step.id);
    if (skip) return { ...base, status: "skipped", reason: skip.reason };
    if (step.kind === "assert") {
      const r = asserts.get(step.id);
      if (r) {
        return {
          ...base,
          status: r.passed ? "ok" : "fail",
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      // An assert with no recorded result never evaluated (no halt either) —
      // surface it as pending rather than a false pass.
      return { ...base, status: "pending" };
    }
    if (step.kind === "interact") {
      const f = interactFails.get(step.id);
      return f
        ? { ...base, status: "fail", reason: f.reason }
        : { ...base, status: "ok" };
    }
    return { ...base, status: "ok" };
  });
}

export function buildStepCheckResults(
  state: Pick<StepExecutionState, "assertionResults">,
  steps: TestStep[],
): PredicateResult[] {
  const turnByStep = stepTurnIndices(steps);
  return state.assertionResults
    .filter((r) => r.predicateResult !== undefined)
    .map((r) => ({
      ...(r.predicateResult as PredicateResult),
      scope: {
        kind: "turn" as const,
        promptIndex: turnByStep[r.stepIndex] ?? 0,
      },
    }))
    .sort((a, b) => (a.scope?.promptIndex ?? 0) - (b.scope?.promptIndex ?? 0));
}
