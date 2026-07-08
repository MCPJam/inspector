// Phase-4 PR1 (plan: please-do-a-sequential-fail-fast-verdict.md).
//
// The SINGLE verdict boundary. Extracted verbatim from the two post-loop 5-gate
// blocks in `evals-runner.ts` (`runLocalIteration` + `runHostedIterationWithBrowser`)
// so both legacy paths — and, later, the sequential `executeSteps` path — assemble
// the verdict through ONE code path. No second scorer.
//
// It is a PURE function: no browser, no runner, no `@/shared` cycle. The caller
// shapes the path-specific inputs (the widget-merged tool calls, the per-turn
// check results, the effective predicates, the gate's trace, the pinned/scripted
// failure arrays) and this owns the order-sensitive assembly:
//   matcher → case predicates → [case, …per-turn] ordering → finalizePassedForEval
//   → pinned-tool-error gate → scripted-check gate.
//
// Per-turn check RESULTS are passed in rather than computed here: the legacy
// runner already computes them from runner-only signals (`buildTurnCheckResults`),
// and the step path will supply already-executed check facts — this is the
// `checkResultsOverride` seam. The local-only behaviors (per-turn checks, the
// pinned `widgetRendered` default, threaded pinned tool errors) are expressed by
// what the caller passes: the hosted path passes `turnCheckResults: []`,
// `effectivePredicates: test.successPredicates`, `pinnedToolErrors: []`,
// `toolErrors: undefined` — making the shared body byte-identical to today.

import {
  evaluateMultiTurnResults,
  type MultiTurnEvaluationResult,
} from "./types";
import {
  buildIterationTranscript,
  evaluatePredicates,
  type PredicateResult,
  type ToolErrorRecord,
} from "@/shared/eval-matching";
import { finalizePassedForEval } from "@mcpjam/sdk";

type EvalArgs = Parameters<typeof evaluateMultiTurnResults>;
type TranscriptArgs = Parameters<typeof buildIterationTranscript>[0];
type FinalizeTrace = Parameters<typeof finalizePassedForEval>[0]["trace"];
type EffectivePredicates = Parameters<typeof evaluatePredicates>[1];

export interface EvalIterationVerdictInput {
  // ── matcher (tool-match summary + negative-test semantics) ──
  promptTurns: EvalArgs[0];
  /** Already widget-merged (`toolsCalledByPromptWithWidgets`). */
  toolsCalledByPrompt: EvalArgs[1];
  isNegativeTest: EvalArgs[2];
  matchOptions: EvalArgs[3];

  // ── per-turn check results (computed by the caller / step facts) ──
  /** Scope-tagged per-turn results, OR `[]` (hosted skips per-turn checks). */
  turnCheckResults: PredicateResult[];

  // ── case-level predicates ──
  /** `successPredicates` or the pinned-only `widgetRendered` default; `undefined` to skip. */
  effectivePredicates: EffectivePredicates | undefined;
  /** Gate trace + the case-predicate transcript inputs (built once by the caller). */
  trace: FinalizeTrace;
  usage: TranscriptArgs["usage"];
  renderObservations: TranscriptArgs["renderObservations"];
  /** Pinned tool errors threaded into the case-predicate transcript (local only; omit for hosted). */
  toolErrors?: ToolErrorRecord[];

  // ── gates ──
  iterationError: string | undefined;
  failOnToolError: boolean;
  /** Pinned (model-free) tool errors — invisible to the trace gate (local only; `[]` for hosted). */
  pinnedToolErrors: ToolErrorRecord[];
  /** Widget interaction-check failures, AFTER the caller flushed active checks. */
  scriptedCheckFailures: { toolName: string; reason: string }[];
}

export interface EvalIterationVerdict {
  /**
   * The matcher result. `passed` is the MATCHER verdict (un-gated) — mirroring
   * the legacy ordering where `promptTraceSummaries` is built before the gated
   * verdict is reflected back. The caller assigns `evaluation.passed = passed`
   * after building its summaries.
   */
  evaluation: MultiTurnEvaluationResult;
  /** The fully-gated pass/fail. */
  passed: boolean;
  /** `[…case-level, …per-turn]` — the persisted `metadata.predicates` ordering. */
  predicateResults: PredicateResult[];
}

export function buildEvalIterationVerdict(
  input: EvalIterationVerdictInput,
): EvalIterationVerdict {
  const evaluation = evaluateMultiTurnResults(
    input.promptTurns,
    input.toolsCalledByPrompt,
    input.isNegativeTest,
    input.matchOptions,
  );

  const casePredicateResults = input.effectivePredicates?.length
    ? evaluatePredicates(
        buildIterationTranscript({
          trace: input.trace as TranscriptArgs["trace"],
          // `evaluation.toolsCalled` already includes widget calls (merged into
          // the matcher input by the caller).
          toolCalls: evaluation.toolsCalled,
          usage: input.usage,
          renderObservations: input.renderObservations,
          // Pinned turns have no trace; thread their tool errors explicitly.
          // Hosted omits the key entirely (parity), so include it only when given.
          ...(input.toolErrors !== undefined
            ? { toolErrors: input.toolErrors }
            : {}),
        }),
        input.effectivePredicates,
      )
    : [];

  // Case-level + per-turn (scope-tagged) results gate AND persist together, in
  // `[case, …per-turn]` order (NOT execution order).
  const predicateResults = [...casePredicateResults, ...input.turnCheckResults];

  let passed = finalizePassedForEval({
    matchPassed: evaluation.passed,
    trace: input.trace,
    // A failed per-turn cycle (`iterationError`) must not sneak through as a
    // pass on negative / zero-expected-tool cases.
    iterationError: input.iterationError,
    failOnToolError: input.failOnToolError,
    predicateResults,
  });

  // A pinned (model-free) tool call's error never enters the trace, so the
  // `failOnToolError` trace gate is blind to it — apply it explicitly. Hosted
  // passes `pinnedToolErrors: []`, making this inert there (byte-identical).
  if (passed && input.failOnToolError && input.pinnedToolErrors.length > 0) {
    passed = false;
  }

  // Widget interaction checks: a failed assertion — or a group whose widget
  // never rendered — fails the iteration unconditionally (the assertion is the
  // test). The caller flushes active checks before passing `scriptedCheckFailures`.
  if (passed && input.scriptedCheckFailures.length > 0) {
    passed = false;
  }

  return { evaluation, passed, predicateResults };
}
