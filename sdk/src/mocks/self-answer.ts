import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { CallAnswer } from "./mock-server.js";
import { answerCase } from "./case-call.js";
import type { CaseCall } from "./case-call.js";
import { checkToolArgs } from "../conformance-tool-args.js";
import type { MockSavedAnswer } from "./definition-types.js";
import { MockAnswerError } from "./model-answers.js";
import type { MockModelAnswerer } from "./model-answers.js";
import type { MockObserver } from "./mock-observer.js";
import { chooseCase, finishCase } from "./saved-answers.js";

/** A refusal a model reads, as a real server's own input check gives it. */
function toolErrorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export interface SelfAnswerCall {
  /** The tool as the mock lists it. */
  tool: Tool | undefined;
  name: string;
  answer: MockSavedAnswer | { from: "model"; instructions?: string };
  input: Record<string, unknown>;
  /** Whether the real server also lists a tool of this name, to fall back to. */
  realHasTool: boolean;
  serverName: string;
  serverInstructions?: string;
  observer?: MockObserver;
  modelAnswerer?: MockModelAnswerer;
  signal?: AbortSignal;
  /** What a case with steps or a task needs from the call; without it those parts are refused. */
  caseCall?: CaseCall;
}

/**
 * A call to a tool the mock answers itself: the input is checked against the
 * listed schema, then a saved case or a model answers. Returns `undefined`
 * only when no saved case matched and the real server has the tool, so the
 * caller makes the ordinary real call. Throws a saved case's protocol error.
 */
export async function answerItself(
  call: SelfAnswerCall
): Promise<CallAnswer | undefined> {
  const { name, answer, input, observer } = call;
  const source = answer.from;
  const verdict = checkToolArgs(call.tool?.inputSchema, input);
  if (verdict.verdict === "invalid") {
    observer?.({
      type: "answered",
      tool: name,
      source,
      outcome: "invalid_input",
    });
    return toolErrorResult(
      `Input validation error: invalid arguments for tool ${name}: ${verdict.message}. Fix the arguments and call it again.`
    );
  }
  if (answer.from === "model") {
    return answerWithModel(call, answer.instructions);
  }
  const found = chooseCase(answer, input);
  if (found) {
    observer?.({
      type: "answered",
      tool: name,
      source,
      caseIndex: found.caseIndex,
      outcome: "case",
    });
    // A case with steps or a task is run; a plain one is just filled.
    return (found.chosen.steps || found.chosen.task) && call.caseCall
      ? answerCase(found.chosen, input, call.caseCall)
      : finishCase(found.chosen, input);
  }
  observer?.({ type: "unmatched", tool: name, arguments: input });
  // A tool the real server also has falls through to it; an added tool has
  // nothing to fall to, so it says which input found no answer.
  if (call.realHasTool) return undefined;
  observer?.({ type: "answered", tool: name, source, outcome: "no_match" });
  return toolErrorResult(
    `No saved answer for ${name} matches ${JSON.stringify(input)}. Add a case whose "when" fits this input.`
  );
}

async function answerWithModel(
  call: SelfAnswerCall,
  instructions: string | undefined
): Promise<CallToolResult> {
  const { name, observer } = call;
  if (!call.modelAnswerer || !call.tool) {
    return toolErrorResult(
      `This mock answers ${name} with a model, and the place it runs does not offer one. Save answers for it instead, or run the mock on MCPJam.`
    );
  }
  try {
    const { result, outcome } = await call.modelAnswerer({
      tool: call.tool,
      ...(instructions !== undefined && { instructions }),
      serverName: call.serverName,
      ...(call.serverInstructions !== undefined && {
        serverInstructions: call.serverInstructions,
      }),
      arguments: call.input,
      signal: call.signal,
    });
    observer?.({ type: "answered", tool: name, source: "model", outcome });
    return result;
  } catch (error) {
    if (!(error instanceof MockAnswerError)) throw error;
    observer?.({
      type: "answered",
      tool: name,
      source: "model",
      outcome: "refused",
    });
    return toolErrorResult(error.message);
  }
}
