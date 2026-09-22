import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { UIMessageChunk } from "ai";
import { hasUnresolvedToolCalls } from "@/shared/http-tool-calls";
import {
  hasUnresolvedToolCall,
  spliceMrtrToolResult,
  type MrtrEngineResume,
} from "./mrtr-hosted-chat.js";
import {
  buildFinishChunk,
  emitToolOutput,
  type ChunkWriter,
} from "./chat-stream-chunks.js";
import { logger } from "./logger.js";

function readToolOutput(
  message: ModelMessage,
  toolCallId: string,
): unknown {
  if (message.role !== "tool" || !Array.isArray((message as any).content)) {
    return undefined;
  }
  const part = (message as any).content.find(
    (candidate: any) =>
      candidate?.type === "tool-result" &&
      candidate.toolCallId === toolCallId,
  );
  return part?.result ?? part?.output;
}

/**
 * Direct AI-SDK counterpart of the emulated engine's continuation pre-phase.
 * Resolves and splices the suspended tool result before `streamText` sees the
 * conversation. Returning false means the turn remains paused and no model
 * request may be sent.
 */
export async function resumeScopeStepUpBeforeDirectTurn(input: {
  writer: ChunkWriter;
  messageHistory: ModelMessage[];
  resume?: MrtrEngineResume;
}): Promise<boolean> {
  if (!input.resume) return true;
  const { toolCallId } = input.resume;
  if (!hasUnresolvedToolCall(input.messageHistory, toolCallId)) {
    logger.warn(
      "[scope-step-up] direct resume has no matching unresolved tool call",
      { toolCallId },
    );
    input.writer.write(buildFinishChunk({ finishReason: "stop" }));
    return false;
  }

  const resolution = await input.resume.resolve(
    (chunk: UIMessageChunk) => input.writer.write(chunk),
  );
  if (resolution.kind !== "complete" && resolution.kind !== "recover") {
    input.writer.write(buildFinishChunk({ finishReason: "stop" }));
    return false;
  }
  if (
    !spliceMrtrToolResult(
      input.messageHistory,
      toolCallId,
      resolution.toolResultMessage,
    )
  ) {
    input.writer.write(buildFinishChunk({ finishReason: "stop" }));
    return false;
  }

  emitToolOutput(input.writer, {
    toolCallId,
    output: readToolOutput(resolution.toolResultMessage, toolCallId),
  });
  if (hasUnresolvedToolCalls(input.messageHistory)) {
    input.writer.write(buildFinishChunk({ finishReason: "stop" }));
    return false;
  }
  return true;
}

export function isSuspendedScopeStepUpOutputChunk(
  chunk: UIMessageChunk,
  toolCallId: string | undefined,
): boolean {
  if (!toolCallId) return false;
  const candidate = chunk as unknown as {
    type?: unknown;
    toolCallId?: unknown;
  };
  return (
    candidate.toolCallId === toolCallId &&
    typeof candidate.type === "string" &&
    (candidate.type.startsWith("tool-output") ||
      candidate.type === "tool-error")
  );
}
