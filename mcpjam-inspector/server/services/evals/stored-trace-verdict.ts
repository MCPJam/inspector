// The live verdict boundary, fed from a STORED trace.
//
// The assertion backtest (a preview) and the persisted re-grade both grade
// recorded evidence through `buildEvalIterationVerdict` — the function every
// live iteration's verdict comes from — instead of calling the evaluators
// directly. One boundary is what keeps a re-graded verdict and a live one from
// disagreeing about the same transcript: matcher, case predicates, ordering and
// every gate run exactly as they ran when the iteration was recorded.
//
// What a stored trace can supply, and what this adapter does about the rest:
//
//   - ONE turn. `actualToolCalls` is stored flattened across turns, so the
//     case is graded as the single turn it was; a caller refuses multi-turn
//     cases rather than pretend to know which call answered which prompt.
//   - No tool inventory or declarations. A check that compares a call against
//     what the server DECLARED reports `status: "error"`, which is the
//     boundary's documented answer for "nobody can say what the model saw".
//   - No usage and no render observations, so `tokenBudgetUnder` and the
//     `widget*` checks fail closed here; callers treat them as unavailable.
//   - No pinned-tool errors or scripted widget checks: a stored trace carries
//     neither, so callers refuse cases that authored them.
//
// Pure: no model, no network, no runner.

import {
  isSkillToolName,
  type EvalMatchOptions,
  type Predicate,
  type PredicateResult,
  type ToolCall,
} from "@/shared/eval-matching";
import {
  buildEvalIterationVerdict,
  type EvalIterationVerdict,
} from "./iteration-verdict";
import type { AgentActivityAssessment } from "./agent-activity";

/** What one recorded iteration carries that a verdict can be built from. */
export type StoredTraceVerdictInputs = {
  query?: string;
  /** The frozen case's expectations. Absent ⇒ none. */
  expectedToolCalls?: ToolCall[];
  /** The recorded calls, widget calls included (as the runner persisted them). */
  actualToolCalls: ToolCall[];
  isNegativeTest?: boolean;
  matchOptions?: EvalMatchOptions;
  messages: Array<{ role: string; content: unknown }>;
  spans?: unknown[];
  /** The iteration's recorded cycle error (a completed run with a failed turn). */
  iterationError?: string;
  /** Absent ⇒ the runner default, `true`. */
  failOnToolError?: boolean;
  /** Recorded only when the guard fired; pass it through when present. */
  agentActivity?: AgentActivityAssessment;
};

/**
 * Build the verdict a live run would have built from this evidence.
 *
 * `effectivePredicates` are evaluated against the stored transcript;
 * `turnCheckResults` are already-decided rows (recorded per-turn step facts, or
 * rows a caller has settled itself) appended after them, the same
 * `[case, …per-turn]` order the runner persists.
 */
export function storedTraceVerdict(
  inputs: StoredTraceVerdictInputs,
  checks: {
    effectivePredicates?: Predicate[];
    turnCheckResults?: PredicateResult[];
  } = {},
): EvalIterationVerdict {
  const actual = inputs.actualToolCalls;
  const spans = inputs.spans ?? [];
  // The runner hands the gate no trace at all when it captured nothing, and
  // "no trace" and "an empty trace" read differently to the capture states.
  const trace =
    spans.length > 0 || inputs.messages.length > 0
      ? {
          ...(spans.length > 0 ? { spans } : {}),
          messages: inputs.messages,
        }
      : undefined;
  return buildEvalIterationVerdict({
    promptTurns: [
      {
        id: "stored-trace",
        prompt: inputs.query ?? "",
        expectedToolCalls: inputs.expectedToolCalls ?? [],
      },
    ],
    toolsCalledByPrompt: [actual],
    isNegativeTest: inputs.isNegativeTest === true,
    matchOptions: inputs.matchOptions,
    // A skill tool can only have been CALLED if it was advertised, and when
    // none was called the exemption filters nothing — so this is exactly the
    // runner's `hasSkillTools(advertised)` for every input it can change.
    skillToolsActive: actual.some((call) => isSkillToolName(call.toolName)),
    turnCheckResults: checks.turnCheckResults ?? [],
    effectivePredicates: checks.effectivePredicates?.length
      ? checks.effectivePredicates
      : undefined,
    trace: trace as Parameters<typeof buildEvalIterationVerdict>[0]["trace"],
    usage: undefined,
    renderObservations: undefined,
    iterationError: inputs.iterationError,
    failOnToolError: inputs.failOnToolError !== false,
    pinnedToolErrors: [],
    scriptedCheckFailures: [],
    ...(inputs.agentActivity ? { agentActivity: inputs.agentActivity } : {}),
  });
}
