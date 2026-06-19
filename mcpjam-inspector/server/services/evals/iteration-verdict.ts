/**
 * The shared post-loop verdict pipeline for an eval iteration.
 *
 * The four runner variants (local/hosted × batch/stream in `evals-runner.ts`)
 * differ only in HOW a turn is executed and whether SSE is emitted. Everything
 * AFTER the turn loop — score tool calls, run per-turn checks, run case-level
 * predicates, gate the verdict, build the per-turn trace summaries — is the
 * same, and used to be copy-pasted ~4× (which silently drifted: backend paths
 * dropped per-turn checks and the pinned-render default). It lives here once.
 *
 * The turn loop and persistence (`finishParams`) stay per-path; this module is
 * purely the verdict computation, kept as pure as practical (no I/O, returns a
 * NEW evaluation rather than mutating the caller's).
 */

import { finalizePassedForEval } from "@mcpjam/sdk";
import {
  evaluateMultiTurnResults,
  type MultiTurnEvaluationResult,
  type ToolCall,
  type UsageTotals,
} from "../evals/types";
import {
  buildIterationTranscript,
  buildTurnTranscript,
  evaluatePredicates,
  evaluateTurnChecks,
  summarizeRenderObservations,
  type MatchOptionsDTO,
  type Predicate,
  type PredicateResult,
  type ToolErrorRecord,
  type TurnChecksInput,
} from "@/shared/eval-matching";
import { isPinnedOnly, type PromptTurn } from "@/shared/prompt-turns";
import type {
  PromptTraceSummary,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import type { TestCaseType } from "@/shared/probe-config";

/**
 * Per-turn check verdicts, evaluated by `evaluateTurnChecks` against each
 * turn's slice of the transcript. `perTurnSignals` carries what a runner
 * captured per turn (tool calls, this turn's assistant message + tool errors,
 * and this turn's render observations — grouped by promptIndex).
 */
export function buildTurnCheckResults(
  promptTurns: PromptTurn[],
  perTurnSignals: {
    toolsCalledByPrompt: ToolCall[][];
    assistantMessageByPrompt: (string | undefined)[];
    toolErrorsByPrompt: ToolErrorRecord[][];
    renderObservations: readonly RunnerWidgetRenderObservation[];
  }
): PredicateResult[] {
  const inputs: TurnChecksInput[] = promptTurns.map((turn, i) => ({
    promptIndex: i,
    checks: turn.checks,
    transcript: buildTurnTranscript({
      toolCalls: perTurnSignals.toolsCalledByPrompt[i] ?? [],
      finalAssistantMessage: perTurnSignals.assistantMessageByPrompt[i],
      toolErrors: perTurnSignals.toolErrorsByPrompt[i] ?? [],
      renderObservations: summarizeRenderObservations(
        perTurnSignals.renderObservations.filter((o) => o.promptIndex === i)
      ),
    }),
  }));
  return evaluateTurnChecks(inputs);
}

export function buildPromptTraceSummaries(
  evaluation: MultiTurnEvaluationResult,
  turnCheckResults: PredicateResult[] = []
): PromptTraceSummary[] {
  return evaluation.promptSummaries.map((summary) => {
    const perTurn = turnCheckResults.filter(
      (r) =>
        r.scope?.kind === "turn" && r.scope.promptIndex === summary.promptIndex
    );
    return {
      promptIndex: summary.promptIndex,
      prompt: summary.prompt,
      expectedToolCalls: summary.expectedToolCalls,
      actualToolCalls: summary.actualToolCalls,
      expectedOutput: summary.expectedOutput,
      passed: summary.passed,
      ...(perTurn.length ? { predicateResults: perTurn } : {}),
      missing: summary.missing,
      unexpected: summary.unexpected,
      argumentMismatches: summary.argumentMismatches.map((mismatch) => {
        const mismatchedArguments = new Set<string>([
          ...Object.keys(mismatch.expectedArgs ?? {}),
          ...Object.keys(mismatch.actualArgs ?? {}),
        ]);
        return {
          expected: {
            toolName: mismatch.toolName,
            arguments: mismatch.expectedArgs,
          },
          actual: {
            toolName: mismatch.toolName,
            arguments: mismatch.actualArgs,
          },
          mismatchedArguments: Array.from(mismatchedArguments).filter(
            (key) =>
              JSON.stringify(mismatch.expectedArgs?.[key]) !==
              JSON.stringify(mismatch.actualArgs?.[key])
          ),
        };
      }),
    };
  });
}

/**
 * Whether the runner captured per-turn signals for this iteration.
 *
 * EXPLICIT discriminator, not silently-optional: a runner that ran turns but
 * couldn't capture per-turn data passes `{ kind: "none" }`, and
 * `computeIterationVerdict` then refuses to silently drop authored per-turn
 * checks (it throws — see below). That silent drop is the exact regression this
 * extraction exists to make impossible.
 */
export type PerTurnSignals =
  | { kind: "none" }
  | {
      kind: "captured";
      assistantMessageByPrompt: (string | undefined)[];
      toolErrorsByPrompt: ToolErrorRecord[][];
    };

/** The resolved-snapshot fields of a test case the verdict depends on. */
export type VerdictTestInput = {
  isNegativeTest?: boolean;
  matchOptions?: MatchOptionsDTO;
  /** Resolved predicate list pinned on the iteration snapshot — NOT live state. */
  successPredicates?: Predicate[];
  caseType?: TestCaseType;
};

export type ComputeIterationVerdictInput = {
  test: VerdictTestInput;
  promptTurns: PromptTurn[];
  toolsCalledByPrompt: ToolCall[][];
  perTurnSignals: PerTurnSignals;
  /**
   * Full iteration render-observation list, each entry promptIndex-stamped by
   * the runner (`RunnerWidgetRenderObservation.promptIndex` is always set).
   * Used for both case-level `widget*` checks and per-turn grouping.
   */
  renderObservations: readonly RunnerWidgetRenderObservation[];
  traceForGate: Parameters<typeof buildIterationTranscript>[0]["trace"];
  accumulatedUsage: UsageTotals;
  /** Pinned (model-free) tool errors — local batch only; absent elsewhere. */
  pinnedToolErrors?: ToolErrorRecord[];
  failOnToolError: boolean;
  iterationError?: string;
};

export type ComputeIterationVerdictResult = {
  /** A NEW evaluation with the gated verdict applied — caller's input is untouched. */
  evaluation: MultiTurnEvaluationResult;
  passed: boolean;
  casePredicateResults: PredicateResult[];
  turnCheckResults: PredicateResult[];
  /** case ++ per-turn — the flattened blob persisted to metadata.predicates. */
  allPredicateResults: PredicateResult[];
  promptTraceSummaries: PromptTraceSummary[];
};

function usageReported(usage: UsageTotals): boolean {
  return (
    (usage.totalTokens ?? 0) > 0 ||
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0
  );
}

/**
 * Score an iteration and produce its verdict + persisted results, shared by all
 * four runner paths. Pure: no I/O, returns new values.
 */
export function computeIterationVerdict(
  input: ComputeIterationVerdictInput
): ComputeIterationVerdictResult {
  const {
    test,
    promptTurns,
    toolsCalledByPrompt,
    perTurnSignals,
    renderObservations,
    traceForGate,
    accumulatedUsage,
    pinnedToolErrors,
    failOnToolError,
    iterationError,
  } = input;

  const baseEvaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
    test.matchOptions
  );

  const turnCheckResults =
    perTurnSignals.kind === "captured"
      ? buildTurnCheckResults(promptTurns, {
          toolsCalledByPrompt,
          assistantMessageByPrompt: perTurnSignals.assistantMessageByPrompt,
          toolErrorsByPrompt: perTurnSignals.toolErrorsByPrompt,
          renderObservations,
        })
      : [];

  // Loud, not silent: never drop authored per-turn checks just because the
  // caller didn't capture per-turn signals. (Backend paths used to do exactly
  // that — silently. This guard turns that latent bug into a hard failure.)
  if (
    perTurnSignals.kind === "none" &&
    promptTurns.some((t) => (t.checks?.length ?? 0) > 0)
  ) {
    throw new Error(
      "computeIterationVerdict: promptTurns authored per-turn checks but the " +
        "runner passed perTurnSignals { kind: 'none' }. Capture per-turn " +
        "signals (assistant message + tool errors) or those checks would be " +
        "silently ignored."
    );
  }

  const promptTraceSummaries = buildPromptTraceSummaries(
    baseEvaluation,
    turnCheckResults
  );

  // Effective predicates come ONLY from the resolved test snapshot, never
  // recomputed from live suite/case state. A pinned-only case with no authored
  // predicates defaults to "the widget rendered" (fails closed if nothing did).
  const effectivePredicates: Predicate[] | undefined = test.successPredicates
    ?.length
    ? test.successPredicates
    : isPinnedOnly({ caseType: test.caseType, promptTurns })
      ? [{ type: "widgetRendered" }]
      : undefined;

  const casePredicateResults = effectivePredicates?.length
    ? evaluatePredicates(
        buildIterationTranscript({
          trace: traceForGate,
          toolCalls: baseEvaluation.toolsCalled,
          usage: usageReported(accumulatedUsage) ? accumulatedUsage : undefined,
          renderObservations: summarizeRenderObservations(renderObservations),
          // Pinned turns have no trace; thread their tool errors explicitly.
          ...(pinnedToolErrors ? { toolErrors: pinnedToolErrors } : {}),
        }),
        effectivePredicates
      )
    : [];

  const allPredicateResults = [...casePredicateResults, ...turnCheckResults];

  let passed = finalizePassedForEval({
    matchPassed: baseEvaluation.passed,
    trace: traceForGate,
    iterationError,
    failOnToolError,
    predicateResults: allPredicateResults,
  });
  // A pinned (model-free) tool call's error never enters the trace, so the
  // `failOnToolError` gate (which inspects the trace) is blind to it. Apply it
  // explicitly so a failing pinned call can't pass.
  if (passed && failOnToolError && (pinnedToolErrors?.length ?? 0) > 0) {
    passed = false;
  }

  return {
    evaluation: { ...baseEvaluation, passed },
    passed,
    casePredicateResults,
    turnCheckResults,
    allPredicateResults,
    promptTraceSummaries,
  };
}
