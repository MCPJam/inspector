import type {
  CallToolResult,
  InputRequiredResult,
  Tool,
} from "@modelcontextprotocol/server";
import { checkToolArgs } from "../conformance-tool-args.js";
import { answerCase } from "./case-call.js";
import type { CaseCall } from "./case-call.js";
import { isInputStep } from "./definition-types.js";
import type { MockSavedAnswer } from "./definition-types.js";
import type { TaskCreated } from "./mock-server.js";
import type { MockObserver } from "./mock-observer.js";
import { checkStructuredOutput } from "./output-schema.js";
import { chooseCase, finishCase } from "./saved-answers.js";

/** A refusal a model reads, as a real server's own input check gives it. */
export function toolErrorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export interface SelfAnswerCall {
  /** The tool as the mock lists it. */
  tool: Tool | undefined;
  name: string;
  answer: MockSavedAnswer;
  input: Record<string, unknown>;
  /** Whether the real server also lists a tool of this name, to fall back to. */
  realHasTool: boolean;
  observer?: MockObserver;
  /** What running a case's steps needs from the call. Without it a case answers with its result only. */
  caseCall?: CaseCall;
  /** Whether this connection can be asked a question: only a 2026-07-28 caller can, since a 2025-era mock keeps no session. */
  canAsk?: boolean;
}

/**
 * A call to a tool the mock answers itself: the input is checked against the
 * listed schema, then the first matching saved case answers, and its result
 * must fit the tool's output schema. Returns `undefined` only when no saved
 * case matched and the real server has the tool, so the caller forwards the
 * call. A case with steps runs them first; one that runs as a task answers
 * with the task handle, and one that asks a question stops with the
 * questions (2026-07-28). Throws a saved case's protocol error. Each call
 * reports once.
 */
export async function answerItself(
  call: SelfAnswerCall
): Promise<CallToolResult | InputRequiredResult | TaskCreated | undefined> {
  const { name, answer, input, observer } = call;
  const verdict = checkToolArgs(call.tool?.inputSchema, input);
  if (verdict.verdict === "invalid") {
    observer?.({ tool: name, source: "saved", refusal: "invalid_input" });
    return toolErrorResult(
      `Input validation error: invalid arguments for tool ${name}: ${verdict.message}. Fix the arguments and call it again.`
    );
  }
  const found = chooseCase(answer, input);
  if (!found) {
    // A tool the real server also has is forwarded; an added tool has nothing
    // to fall to, so it says which input found no answer.
    if (call.realHasTool) return undefined;
    observer?.({ tool: name, source: "unmatched" });
    return toolErrorResult(
      `No saved answer for ${name} matches ${JSON.stringify(input)}. Add a case whose "when" fits this input.`
    );
  }
  const report = (refusal?: "invalid_output" | "input_unavailable") =>
    observer?.({
      tool: name,
      source: "saved",
      caseIndex: found.caseIndex,
      catchAll: found.chosen.when === undefined,
      ...(refusal && { refusal }),
    });
  const { chosen } = found;
  if (chosen.steps?.some(isInputStep) && !call.canAsk) {
    report("input_unavailable");
    return toolErrorResult(
      `The saved answer for ${name} asks the client a question, which needs protocol revision 2026-07-28 (earlier revisions need a session, and a mock keeps none). Connect with 2026-07-28, or save an answer without ask, askUrl or sample steps.`
    );
  }
  let refusal: "invalid_output" | undefined;
  const finish = (replies: Record<string, unknown>) => {
    const result = finishCase(chosen, input, replies);
    const output = checkStructuredOutput(call.tool?.outputSchema, result);
    if (output.ok) return result;
    refusal = "invalid_output";
    return toolErrorResult(
      `The saved answer for ${name} does not match its output schema: ${output.message}. Fix the saved result, or the output schema.`
    );
  };
  // A protocol error is thrown by `finishCase`; it still counts as a saved answer.
  try {
    if (call.caseCall && (chosen.steps || chosen.task)) {
      return await answerCase(chosen, input, call.caseCall, finish);
    }
    return finish({});
  } finally {
    report(refusal);
  }
}
