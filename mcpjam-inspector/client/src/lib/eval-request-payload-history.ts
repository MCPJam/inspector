import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";
import type {
  ResolvedModelRequestPayload,
  SerializedModelRequestTool,
} from "@/shared/model-request-payload";

type EvalTraceLike = {
  messages?: ResolvedModelRequestPayload["messages"] | null;
  spans?: EvalTraceSpan[] | null;
} | null;

type TranscriptRange = {
  startIndex: number;
  endIndex: number;
};

function getTranscriptRange(
  startIndex?: number,
  endIndex?: number,
): TranscriptRange | null {
  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex! < 0 ||
    endIndex! < startIndex!
  ) {
    return null;
  }

  return {
    startIndex: startIndex!,
    endIndex: endIndex!,
  };
}

/**
 * Reconstruct the exact model input for a recorded LLM span:
 * all transcript messages up to, but not including, the first assistant reply
 * contained within the span's message range.
 */
function getLlmInputMessages(
  messages: ResolvedModelRequestPayload["messages"],
  startIndex?: number,
  endIndex?: number,
): ResolvedModelRequestPayload["messages"] {
  const range = getTranscriptRange(startIndex, endIndex);
  if (!range) {
    return [];
  }

  const slice = messages.slice(range.startIndex, range.endIndex + 1);
  if (slice.length === 0) {
    return [];
  }

  let firstAssistantInSlice = -1;
  for (let index = 0; index < slice.length; index += 1) {
    if (slice[index]?.role === "assistant") {
      firstAssistantInSlice = index;
      break;
    }
  }

  if (firstAssistantInSlice < 0) {
    return messages.slice(0, range.endIndex + 1);
  }

  const absoluteFirstAssistant = range.startIndex + firstAssistantInSlice;
  if (absoluteFirstAssistant === 0) {
    return [];
  }

  return messages.slice(0, absoluteFirstAssistant);
}

function cloneSerializedTools(
  tools: Record<string, SerializedModelRequestTool>,
): Record<string, SerializedModelRequestTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      {
        ...tool,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? { ...tool.inputSchema }
            : tool.inputSchema,
      },
    ]),
  );
}

export function buildEvalRequestPayloadHistory(options: {
  trace: EvalTraceLike;
  systemPrompt?: string;
  tools?: Record<string, SerializedModelRequestTool>;
}): LiveChatTraceRequestPayloadEntry[] {
  const messages = options.trace?.messages;
  const spans = options.trace?.spans;
  if (!Array.isArray(messages) || messages.length === 0 || !Array.isArray(spans)) {
    return [];
  }

  const orderedLlmSpans = spans
    .filter(
      (span) =>
        span.category === "llm" &&
        typeof span.messageStartIndex === "number" &&
        typeof span.messageEndIndex === "number" &&
        span.messageStartIndex >= 0 &&
        span.messageEndIndex >= span.messageStartIndex,
    )
    .sort((left, right) => {
      const promptDelta = (left.promptIndex ?? 0) - (right.promptIndex ?? 0);
      if (promptDelta !== 0) {
        return promptDelta;
      }

      const stepDelta = (left.stepIndex ?? 0) - (right.stepIndex ?? 0);
      if (stepDelta !== 0) {
        return stepDelta;
      }

      const startDelta = left.startMs - right.startMs;
      if (startDelta !== 0) {
        return startDelta;
      }

      const endDelta = left.endMs - right.endMs;
      if (endDelta !== 0) {
        return endDelta;
      }

      return left.id.localeCompare(right.id);
    });

  if (orderedLlmSpans.length === 0) {
    return [];
  }

  const seenPromptSteps = new Set<string>();
  const resolvedTools = cloneSerializedTools(options.tools ?? {});
  const resolvedSystemPrompt = options.systemPrompt ?? "";
  const history: LiveChatTraceRequestPayloadEntry[] = [];

  for (const span of orderedLlmSpans) {
    const promptIndex = span.promptIndex ?? 0;
    const stepIndex = span.stepIndex ?? 0;
    const promptStepKey = `${promptIndex}:${stepIndex}`;
    if (seenPromptSteps.has(promptStepKey)) {
      continue;
    }

    const inputMessages = getLlmInputMessages(
      messages,
      span.messageStartIndex,
      span.messageEndIndex,
    );
    if (inputMessages.length === 0) {
      continue;
    }

    seenPromptSteps.add(promptStepKey);
    history.push({
      turnId: `eval-turn-${promptIndex + 1}`,
      promptIndex,
      stepIndex,
      payload: {
        system: resolvedSystemPrompt,
        tools: cloneSerializedTools(resolvedTools),
        messages: [...inputMessages],
      },
    });
  }

  return history;
}
