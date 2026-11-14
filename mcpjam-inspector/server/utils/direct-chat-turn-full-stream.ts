/**
 * Part-by-part consumption of a direct turn, for callers that translate the
 * stream while it arrives (the local eval runner's SSE). The headless consumer
 * in `direct-chat-turn.ts` drains with `consumeStream()` and never sees a part.
 */

import type { ModelMessage, streamText } from "ai";
import type { PersistedTurnTrace } from "./chat-ingestion";
import type {
  DirectChatTurnHeadlessResult,
  RunDirectChatTurnHandle,
} from "./direct-chat-turn";
import { capRequestPayloadsForPersist } from "./live-chat-trace-stream";

type FullStream = ReturnType<typeof streamText>["fullStream"];

/** One `fullStream` part, exactly as the AI SDK produced it. */
export type DirectFullStreamPart =
  FullStream extends AsyncIterable<infer Part> ? Part : never;

export type DirectChatTurnFullStreamResult = DirectChatTurnHeadlessResult & {
  /** The model id the provider reported serving, when it reported one. */
  upstreamModel: string | undefined;
};

/** The turn's trace from the engine's own accumulator, for both consumers. */
export function buildDirectChatTurnTrace(
  handle: RunDirectChatTurnHandle,
  finishReason: DirectChatTurnHeadlessResult["finishReason"],
): PersistedTurnTrace {
  return {
    turnId: handle.traceTurn.turnId,
    promptIndex: handle.traceTurn.promptIndex,
    startedAt: handle.traceTurn.turnStartedAt,
    endedAt: Date.now(),
    spans: [...handle.traceContext.recordedSpans],
    requestPayloads: capRequestPayloadsForPersist(
      handle.traceContext.recordedRequestPayloads,
    ),
    usage: handle.traceTurn.turnUsage,
    finishReason: finishReason ?? undefined,
    modelId: handle.modelId,
  };
}

/**
 * Drives a `runDirectChatTurn` handle to completion, handing every
 * `fullStream` part to `onPart` as it arrives, then reads the terminal
 * promises. A stream that exposes no parts is drained with `consumeStream()`.
 *
 * A throw propagates as the stream raised it. The headless consumer swaps in
 * the stream's own error instead; here the typed `error` part has already
 * reached `onPart`, which is where a caller that classifies failures reads it.
 * The abort listener is removed either way.
 */
export async function consumeDirectChatTurnFullStream(
  handle: RunDirectChatTurnHandle,
  onPart: (part: DirectFullStreamPart) => void,
): Promise<DirectChatTurnFullStreamResult> {
  try {
    const fullStream = handle.result.fullStream;
    if (
      fullStream &&
      typeof fullStream === "object" &&
      Symbol.asyncIterator in fullStream
    ) {
      for await (const part of fullStream) onPart(part);
    } else {
      await handle.result.consumeStream();
    }
    const response = await handle.result.response;
    // Every step's messages. In AI SDK 7 `response` is the final step's, so
    // `response.messages` would drop the earlier tool calls and results.
    const responseMessages = await handle.result.responseMessages;
    const steps = await handle.result.steps;
    const totalUsage = await handle.result.totalUsage;
    const finishReason = await handle.result.finishReason;
    const modelId = (response as { modelId?: unknown } | undefined)?.modelId;
    return {
      messages: Array.isArray(responseMessages)
        ? (responseMessages as ModelMessage[])
        : [],
      steps,
      totalUsage,
      finishReason,
      upstreamModel: typeof modelId === "string" ? modelId : undefined,
      spans: handle.traceContext.recordedSpans,
      turnTrace: buildDirectChatTurnTrace(handle, finishReason),
      aborted: handle.isAborted(),
    };
  } finally {
    handle.cleanup();
  }
}
