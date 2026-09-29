/**
 * A deterministic language model for local-runner tests — no network, no
 * provider, no spend.
 *
 * A script decides each generation from what the model was actually sent:
 * the latest user text, and whether the previous step's tool results are
 * already in the conversation. So a test states "when asked to delete, call
 * delete_note, then summarize", and what is asserted downstream is what a
 * real runner, a real MCP server and the real graders did with that.
 */

import { MockLanguageModelV3 } from "ai/test";

export type ScriptedStep =
  | { text: string }
  | {
      toolCalls: Array<{
        toolName: string;
        input?: Record<string, unknown>;
        /** Sent verbatim instead of `input` — e.g. malformed JSON. */
        rawInput?: string;
      }>;
    }
  | { error: unknown };

export type ScriptContext = {
  /** Text of the most recent user message. */
  userText: string;
  /** Every user message's text, oldest first. */
  userTexts: string[];
  /** True once a tool result follows the latest user message. */
  afterToolResult: boolean;
  /** Tool-result texts after the latest user message. */
  toolResults: string[];
  /** The model id the factory was asked for. */
  modelId: string;
  /** How many generations this model instance has served before this one. */
  callIndex: number;
};

type PromptMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string; output?: unknown }>;
};

function textOf(message: PromptMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function toolResultTexts(message: PromptMessage): string[] {
  if (typeof message.content === "string") return [];
  return message.content
    .filter((part) => part.type === "tool-result")
    .map((part) => JSON.stringify(part.output ?? null));
}

let toolCallCounter = 0;

export function scriptedModel(
  modelId: string,
  script: (context: ScriptContext) => ScriptedStep
): MockLanguageModelV3 & { prompts: PromptMessage[][] } {
  let callIndex = 0;
  const prompts: PromptMessage[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt as unknown as PromptMessage[];
      prompts.push(prompt);
      let lastUser = -1;
      prompt.forEach((message, index) => {
        if (message.role === "user") lastUser = index;
      });
      const after = prompt.slice(lastUser + 1);
      const toolResults = after
        .filter((message) => message.role === "tool")
        .flatMap(toolResultTexts);
      const step = script({
        userText: lastUser >= 0 ? textOf(prompt[lastUser]!) : "",
        userTexts: prompt
          .filter((message) => message.role === "user")
          .map(textOf),
        afterToolResult: toolResults.length > 0,
        toolResults,
        modelId,
        callIndex: callIndex++,
      });
      if ("error" in step) throw step.error;
      const usage = {
        inputTokens: {
          total: 3,
          noCache: 3,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      };
      if ("toolCalls" in step) {
        return {
          content: step.toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: `call_${++toolCallCounter}`,
            toolName: call.toolName,
            input: call.rawInput ?? JSON.stringify(call.input ?? {}),
          })),
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: step.text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
  return Object.assign(model, { prompts });
}

/**
 * The common script: call the named tool once for the latest prompt, then
 * answer with a summary of what came back.
 */
export function callThenAnswer(
  pick: (
    context: ScriptContext
  ) => { toolName: string; input?: Record<string, unknown> } | null
): (context: ScriptContext) => ScriptedStep {
  return (context) => {
    if (context.afterToolResult) {
      return { text: `Done: ${context.toolResults.join(" ")}` };
    }
    const call = pick(context);
    return call
      ? { toolCalls: [call] }
      : { text: `No tool needed for: ${context.userText}` };
  };
}
