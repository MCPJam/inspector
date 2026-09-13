/**
 * Guards against vacuous passes: a trial where the model never ran made no
 * forbidden call either, so the tool matcher can pass it. This only asks
 * whether there was any activity at all; exemptions are generous because a
 * false positive fails a run that was fine.
 */

/** A fact about the surface, not about the trace. @see assessAgentActivity */
export interface AgentActivityToolSurface {
  /** How many MCP tools the iteration actually advertised to the model. */
  mcpTools: number;
  /** Whether a browser tool policy was resolved for this case. */
  browserTools: boolean;
}

export interface AgentActivityInput {
  /** All steps are pinned tool calls; exempt because zero model runs is expected. */
  modelFree: boolean;
  /** Exempt: for a negative test, doing nothing can be the correct answer. */
  isNegativeTest: boolean;
  expectedToolCalls: number;
  toolSurface: AgentActivityToolSurface;
  toolCalls: number;
  /** Evidence a model ran. @see countModelInvocations */
  modelInvocations: number;
}

export type AgentActivityExemption =
  | "model_free"
  | "negative_test"
  | "no_tool_expected"
  | "no_tool_surface";

export type AgentActivityAssessment =
  | { status: "active" }
  | { status: "exempt"; reason: AgentActivityExemption }
  | { status: "no_agent_activity"; detail: string };

/**
 * Fires only when a case expected work (tool calls or a browser policy) and
 * shows zero tool calls and zero model invocations. A model that ran but
 * chose no tool is a real answer, so it does not fire.
 */
export function assessAgentActivity(
  input: AgentActivityInput,
): AgentActivityAssessment {
  if (input.modelFree) return { status: "exempt", reason: "model_free" };
  if (input.isNegativeTest) {
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
 * Counts `llm` spans, falling back to assistant messages: a caller-supplied
 * `HostExecutor` reports a transcript but no spans, and counting only spans
 * would read all its runs as "nothing happened".
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
