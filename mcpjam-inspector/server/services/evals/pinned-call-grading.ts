/**
 * How an `assert` step grades around the case's pinned (`toolCall`) steps.
 *
 * A pinned call is a fixture: the case makes it, not the agent. Its transcript
 * entry is a one-line summary, because hosted `/stream` input must stay
 * text-only, so its result reaches grading through the executor state
 * (`StepExecutionState.pinnedCalls`) instead. Two kinds of assertion read it:
 *
 *   - A result-content assertion (`toolResultContains`, `toolResultMatches`,
 *     `toolResultMatchesSchema`) that names a tool the case pinned before it
 *     grades the result of the most recent pinned call of that tool, and only
 *     that result. An earlier pinned read cannot rescue it, nor can the
 *     agent's own call of the tool, and a pinned call with nothing to grade
 *     (an error, no result, a blocked call) is missing evidence, never a pass.
 *   - `toolCalledAtLeastOnce` and `firstToolWas` describe the agent's path, so
 *     they read every call except the pinned ones.
 *
 * Every other assertion reads the transcript exactly as before, pinned calls
 * included. `toolResultSizeUnder` stays there too: it budgets what a model
 * was handed, and a pinned call hands a model nothing.
 * A declared output-schema check reads every pinned result, after the run too.
 */
import { DECLARED_OUTPUT_SCHEMA, evaluatePredicates } from "@mcpjam/sdk/predicates";
import type { BuildTranscriptInput, IterationTranscript, Predicate } from "@mcpjam/sdk/predicates";
import type { ToolCallStep } from "@/shared/steps";
import type { PinnedCallEvidence } from "./pinned-turn";
import type { StepEngineOutcome, StepExecutionState } from "./step-executor";
import { callToolResultRow, toolCallFailure } from "./transcript-evidence";

/** One `toolCall` step that ran, with what its call returned. */
export interface PinnedCallRecord extends PinnedCallEvidence {
  stepId: string;
  stepIndex: number;
  toolName: string;
  /** Where this step's own calls sit in `StepExecutionState.toolCalls`. */
  callIndices: number[];
}

/** Transcript channels one assertion reads in place of the snapshot's own. */
export type AssertionScope = Partial<
  Pick<BuildTranscriptInput, "toolCalls" | "toolResults" | "resultsCaptured">
>;

type GradingState = Pick<StepExecutionState, "toolCalls" | "pinnedCalls">;

/**
 * Record a `toolCall` step once its outcome is applied. `callsBefore` is
 * `state.toolCalls.length` from just before that.
 */
export function recordPinnedCall(
  state: GradingState,
  args: {
    step: ToolCallStep;
    stepIndex: number;
    outcome: StepEngineOutcome;
    callsBefore: number;
  },
): void {
  const { step, stepIndex, outcome, callsBefore } = args;
  const callIndices: number[] = [];
  for (let i = callsBefore; i < state.toolCalls.length; i++) {
    callIndices.push(i);
  }
  state.pinnedCalls.push({
    // A handler that reported no result leaves nothing to grade.
    isError: false,
    ...outcome.pinnedCall,
    stepId: step.id,
    stepIndex,
    toolName: step.toolName,
    callIndices,
  });
}

/** What `assertion` reads in place of the snapshot, or `{}` for the snapshot. */
export function assertionScope(
  state: GradingState,
  assertion: Predicate,
): AssertionScope {
  if (
    assertion.type === "toolCalledAtLeastOnce" ||
    assertion.type === "firstToolWas"
  ) {
    const pinned = new Set(state.pinnedCalls.flatMap((c) => c.callIndices));
    return { toolCalls: state.toolCalls.filter((_, i) => !pinned.has(i)) };
  }
  if (
    assertion.type !== "toolResultContains" &&
    assertion.type !== "toolResultMatches" &&
    (assertion.type !== "toolResultMatchesSchema" || gradesPinnedResults(assertion))
  ) {
    return {};
  }
  const graded = latestPinnedCall(state.pinnedCalls, assertion.toolName);
  if (!graded) return {};
  const row = graded.isError
    ? undefined
    : callToolResultRow(graded.toolName, graded.result, graded.toolCallId);
  // Nothing to grade reads as an uncaptured result: the check reports missing
  // evidence instead of scoring an empty one, which `max: 0` would pass.
  return row
    ? { toolResults: [row], resultsCaptured: true }
    : { toolResults: undefined, resultsCaptured: false };
}

/** Stored predicates are loosely typed; `evaluatePredicates` reports a malformed one. */
const gradesPinnedResults = (p: Predicate) => typeof p === "object" && p !== null &&
  p.type === "toolResultMatchesSchema" && p.schema === DECLARED_OUTPUT_SCHEMA;

/** Without these rows the declared check counts each pinned call as one that returned nothing. */
export function evaluateWithPinnedResults(
  transcript: IterationTranscript,
  predicates: readonly Predicate[],
  calls: readonly PinnedCallRecord[] = [],
) {
  const rows = calls.flatMap((call) => {
    const row = callToolResultRow(call.toolName, call.result, call.toolCallId, call.declaredServerKey);
    const failure = call.failureMessage && toolCallFailure({ type: "error-text", value: call.failureMessage }, call.toolName);
    return row ? [{ ...row, ...(failure ? { callFailure: failure } : {}) }] : [];
  });
  const withPinned = { ...transcript, toolResults: [...(transcript.toolResults ?? []), ...rows] };
  return predicates.flatMap((p) => evaluatePredicates(gradesPinnedResults(p) ? withPinned : transcript, [p]));
}

/** The most recent pinned call of `toolName`; none when no tool is named. */
function latestPinnedCall(
  calls: PinnedCallRecord[],
  toolName: string | undefined,
): PinnedCallRecord | undefined {
  if (toolName === undefined) return undefined;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call?.toolName === toolName) return call;
  }
  return undefined;
}
