import type { TraceMessage } from "./trace-viewer-adapter";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";

export type EvalStreamState = {
  messages: TraceMessage[];
  tokensUsed: number;
  toolCallCount: number;
  currentTurnIndex: number;
};

export const initialEvalStreamState: EvalStreamState = {
  messages: [],
  tokensUsed: 0,
  toolCallCount: 0,
  currentTurnIndex: 0,
};

export function reduceEvalStreamEvent(
  state: EvalStreamState,
  event: EvalStreamEvent,
): EvalStreamState {
  switch (event.type) {
    case "turn_start": {
      return {
        ...state,
        currentTurnIndex: event.turnIndex,
        messages: [
          ...state.messages,
          { role: "user", content: event.prompt },
        ],
      };
    }

    case "text_delta": {
      const messages = [...state.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && typeof last.content === "string") {
        messages[messages.length - 1] = {
          ...last,
          content: last.content + event.content,
        };
      } else {
        messages.push({ role: "assistant", content: event.content });
      }
      return { ...state, messages };
    }

    case "tool_call": {
      const messages = [...state.messages];
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            args: event.args,
          },
        ],
      });
      return {
        ...state,
        messages,
        toolCallCount: state.toolCallCount + 1,
      };
    }

    case "tool_result": {
      const messages = [...state.messages];
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: event.toolCallId,
            result: event.result,
            isError: event.isError,
          },
        ],
      });
      return { ...state, messages };
    }

    case "step_finish": {
      const usage = event.usage;
      if (!usage) return state;
      return {
        ...state,
        tokensUsed:
          state.tokensUsed + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      };
    }

    case "turn_finish": {
      return {
        ...state,
        currentTurnIndex: event.turnIndex,
      };
    }

    default:
      return state;
  }
}
