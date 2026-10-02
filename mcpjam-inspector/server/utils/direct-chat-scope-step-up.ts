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
  emitToolInput,
  emitToolOutput,
  type ChunkWriter,
} from "./chat-stream-chunks.js";
import { logger } from "./logger.js";

/**
 * Answers an inherited, unresolved tool call that a mid-session sign-in
 * suspended, with the model-facing text; `undefined` leaves the call alone.
 */
export type SettleSuspendedToolCall = (call: {
  toolCallId: string;
  toolName: string;
}) => string | undefined | Promise<string | undefined>;

/**
 * Whether a request ends with a new user message rather than re-driving a
 * suspended turn. A cancel the client splices into the user's next message
 * is settled with the history instead of driven as a resume leg, so
 * the message runs; a bare cancel keeps the step-up re-drive path.
 */
export function endsWithNewUserMessage(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as { role?: unknown } | undefined;
  return last?.role === "user";
}

/**
 * History settlement for the direct AI-SDK engine.
 *
 * A conversation can come back with a call still unresolved because the user
 * sent another message instead of signing in. `streamText` refuses such a
 * history outright (`MissingToolResultsError`), so the turn would fail before
 * the model saw the new message. Each call `settle` recognizes is answered
 * with its text instead, never run, and re-introduced on this response so the
 * client can attach the answer (when a `writer` is given; the emulated engine
 * emits through its own result path). Returns the inserted tool messages.
 */
export async function settleSuspendedHistoryToolCalls(input: {
  writer?: ChunkWriter;
  messageHistory: ModelMessage[];
  settle: SettleSuspendedToolCall;
}): Promise<ModelMessage[]> {
  const resolved = new Set<string>();
  for (const message of input.messageHistory) {
    if (message?.role !== "tool" || !Array.isArray((message as any).content)) {
      continue;
    }
    for (const part of (message as any).content) {
      if (part?.type === "tool-result" && typeof part.toolCallId === "string") {
        resolved.add(part.toolCallId);
      }
    }
  }

  const answers: Array<{ index: number; message: ModelMessage }> = [];
  for (const [index, message] of input.messageHistory.entries()) {
    if (
      message?.role !== "assistant" ||
      !Array.isArray((message as any).content)
    ) {
      continue;
    }
    const content: unknown[] = [];
    for (const part of (message as any).content) {
      if (
        part?.type !== "tool-call" ||
        typeof part.toolCallId !== "string" ||
        typeof part.toolName !== "string" ||
        part.providerExecuted === true ||
        resolved.has(part.toolCallId)
      ) {
        continue;
      }
      const text = await input.settle({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
      });
      if (text === undefined) continue;
      resolved.add(part.toolCallId);
      const output = { type: "error-text", value: text };
      content.push({
        type: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output,
      });
      if (input.writer) {
        emitToolInput(input.writer, {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input ?? {},
        });
        emitToolOutput(input.writer, { toolCallId: part.toolCallId, output });
      }
    }
    if (content.length > 0) {
      answers.push({
        index,
        message: { role: "tool", content } as unknown as ModelMessage,
      });
    }
  }
  // Back to front, so earlier indices stay valid while splicing.
  for (const { index, message } of [...answers].reverse()) {
    input.messageHistory.splice(index + 1, 0, message);
  }
  return answers.map(({ message }) => message);
}

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
  /**
   * Answers inherited calls a sign-in suspended. Applied only on a turn that
   * resumes nothing: a resume names its call, and a sibling still pending is
   * the client's to drive next.
   */
  settleSuspendedToolCall?: SettleSuspendedToolCall;
}): Promise<boolean> {
  if (!input.resume) {
    if (input.settleSuspendedToolCall) {
      await settleSuspendedHistoryToolCalls({
        writer: input.writer,
        messageHistory: input.messageHistory,
        settle: input.settleSuspendedToolCall,
      });
    }
    return true;
  }
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
