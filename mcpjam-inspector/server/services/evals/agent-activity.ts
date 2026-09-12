/**
 * Did the agent actually DO anything this iteration?
 *
 * A hosted eval trial can report a pass having run nothing at all. The tool
 * matcher is satisfied when every EXPECTED call was made and none was
 * forbidden — and if the model was never invoked, it made no forbidden call
 * either. On a case whose expectations are about what must NOT happen, or
 * whose success predicates read a transcript that is simply empty, "nothing
 * ran" and "it ran and behaved perfectly" produce the same verdict.
 *
 * That is not hypothetical. Every way an agent can silently fail to start —
 * a credential the harness could not materialise, a plan wall, an executor
 * that rejected before the first turn, a browser that never provisioned —
 * lands here, and the only guard that ever existed for it is
 * `external-account-plan-wall.ts`: an exact literal match, for Cursor, for one
 * specific message.
 *
 * WHAT THIS IS NOT. It is not a quality check. It does not ask whether the
 * agent did the RIGHT thing, or enough of it, or chose good tools. It asks
 * one question — was there any activity at all — and its exemptions are
 * generous on purpose, because a false positive here fails a run that was fine
 * and a false negative merely leaves the status quo.
 */

/** A fact about the surface, not about the trace. @see assessAgentActivity */
export interface AgentActivityToolSurface {
  /** How many MCP tools the iteration actually advertised to the model. */
  mcpTools: number;
  /** Whether a browser tool policy was resolved for this case. */
  browserTools: boolean;
}

export interface AgentActivityInput {
  /**
   * A case whose steps are all PINNED tool calls, with no model behind them.
   *
   * Exempt, and this is the exemption that matters most: a model-free case is
   * SUPPOSED to have zero model invocations, so a guard that did not know
   * about them would fail every widget probe in the suite.
   */
  modelFree: boolean;
  /**
   * A case that passes by the agent NOT doing something.
   *
   * Exempt because "it did nothing" is, for a negative test, a plausible
   * correct answer rather than a symptom. The guard cannot tell a model that
   * correctly declined from one that never ran, and failing the first is worse
   * than missing the second.
   */
  isNegativeTest: boolean;
  /** How many tool calls the case declared it expects. */
  expectedToolCalls: number;
  toolSurface: AgentActivityToolSurface;
  /** How many tool calls actually happened. */
  toolCalls: number;
  /**
   * How many times a MODEL ran.
   *
   * `category: "llm"` spans in the gate trace, falling back to assistant
   * messages when the executor reports no span channel at all
   * (`traceLacksSpanChannel`). Both are needed: an executor that reports no
   * spans is exactly the one whose runs would otherwise look empty, and
   * treating "this executor does not report spans" as "nothing ran" is how a
   * guard against vacuous passes becomes a source of them.
   */
  modelInvocations: number;
}

/** Why the guard did not fire. @see AgentActivityAssessment */
export type AgentActivityExemption =
  | "model_free"
  | "negative_test"
  | "no_tool_expected"
  | "no_tool_surface";

export type AgentActivityAssessment =
  /** Something happened. Nothing to report. */
  | { status: "active" }
  /** The question does not apply to this case, and why. */
  | { status: "exempt"; reason: AgentActivityExemption }
  /**
   * A case that expected work produced NONE — no tool call, no model
   * invocation. The verdict must not be a pass.
   */
  | { status: "no_agent_activity"; detail: string };

/**
 * Decide whether this iteration shows any agent activity at all.
 *
 * FIRES ONLY on the unambiguous case, which is the whole design:
 *
 *   not model-free, not a negative test, the case expected tool calls OR had a
 *   browser policy, ZERO tool calls happened, and ZERO model invocations.
 *
 * Every one of those is necessary. Drop "expected tool calls or browser" and a
 * pure-conversation case that legitimately calls nothing fails. Drop "zero
 * model invocations" and a model that ran and chose not to call a tool fails,
 * which is a real answer and often the right one. What is left is a case that
 * asked for work and shows no evidence that anything was even attempted.
 */
export function assessAgentActivity(
  input: AgentActivityInput,
): AgentActivityAssessment {
  if (input.modelFree) return { status: "exempt", reason: "model_free" };
  if (input.isNegativeTest) {
    // Its own reason rather than folded into `active`: "we chose not to ask"
    // is a different fact from "we asked and the answer was yes", and the
    // metadata this lands in is read by people deciding whether the guard is
    // doing anything.
    return { status: "exempt", reason: "negative_test" };
  }
  const expectsWork =
    input.expectedToolCalls > 0 || input.toolSurface.browserTools;
  if (!expectsWork) {
    return {
      status: "exempt",
      reason:
        input.toolSurface.mcpTools > 0 ? "no_tool_expected" : "no_tool_surface",
    };
  }
  if (input.toolCalls > 0 || input.modelInvocations > 0) {
    return { status: "active" };
  }
  return {
    status: "no_agent_activity",
    detail:
      "the agent made no tool calls and the model was never invoked, on a " +
      `case that expected ${
        input.expectedToolCalls > 0
          ? `${input.expectedToolCalls} tool call(s)`
          : "browser work"
      }; nothing ran, so a pass here would be vacuous`,
  };
}

/**
 * Count model invocations from whatever the runner captured.
 *
 * THE TRACE FIRST, `category: "llm"` spans being the direct record of a model
 * having run. The fallback to assistant messages exists for one specific
 * executor shape and is load-bearing: a caller-supplied `HostExecutor` reports
 * a transcript and NO span channel, so counting only spans would read every
 * one of its runs as "nothing happened" — turning a guard against vacuous
 * passes into a generator of false failures on the surface most likely to have
 * this problem in the first place.
 *
 * So spans win when there are any, and messages answer when there are none.
 * Neither is a count of *turns*; both are a count of evidence that a model ran
 * at all, which is the only question being asked.
 */
export function countModelInvocations(args: {
  spans?: ReadonlyArray<{ category?: string }> | undefined;
  messages?: ReadonlyArray<{ role?: string }> | undefined;
}): number {
  const spans = args.spans ?? [];
  if (spans.length > 0) {
    return spans.filter((span) => span.category === "llm").length;
  }
  return (args.messages ?? []).filter((message) => message.role === "assistant")
    .length;
}
