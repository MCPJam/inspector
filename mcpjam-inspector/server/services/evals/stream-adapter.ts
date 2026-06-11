/**
 * Translate AI SDK `streamText.fullStream` chunks → `EvalStreamEvent`
 * shapes for the eval streaming runners.
 *
 * Engine consolidation PR 5a (`~/mcpjam-docs/unification.md`). The
 * local-AI-SDK streaming runner (`streamIterationWithAiSdk`) used to
 * inline a `for await (const part of result.fullStream)` switch on
 * chunk types to emit `text_delta` / `tool_call` / `tool_result` /
 * `step_finish` events. PR 5a rewires the runner onto
 * `runDirectChatTurn` (PR 4a) and lifts that switch into a named
 * adapter so the same translation can be applied to other future
 * stream consumers (PR 5b will use a similar pattern when
 * `streamIterationViaBackend` adopts the to-be-extended
 * `runAssistantTurn` event surface).
 *
 * Pure refactor — the emitted event shapes are byte-identical to the
 * pre-PR-5a inline switch. Snapshot tests in
 * `stream-adapter.test.ts` lock the contract.
 *
 * Trace-snapshot events (`trace_snapshot`) are NOT emitted from here.
 * They fire from the runner's per-step / per-turn / failure paths via
 * `buildTraceSnapshotEvent` because they carry runner-specific state
 * (recordedSpans, activePromptInputMessages, conversationMessages) the
 * adapter doesn't see.
 */

import type { streamText } from "ai";
import type { EvalStreamEvent } from "@/shared/eval-stream-events";

/** Single emit shape that this module produces. Subset of `EvalStreamEvent`. */
export type FullStreamAdapterEvent = Extract<
  EvalStreamEvent,
  | { type: "text_delta" }
  | { type: "tool_call" }
  | { type: "tool_result" }
  | { type: "step_finish" }
>;

export interface FullStreamAdapterContext {
  /** Emit callback — typically the eval runner's `StreamEmit`. */
  emit: (event: FullStreamAdapterEvent) => void;
  /**
   * Read the current step number. Used as the `step_finish.stepNumber`
   * field. The runner owns the counter (it's also used to gate trace
   * span emission and SSE snapshot stepIndex) so the adapter reads
   * rather than tracks it.
   */
  getStepIndex: () => number;
}

type FullStream = ReturnType<typeof streamText>["fullStream"];

/**
 * Drives `fullStream` to completion, emitting `EvalStreamEvent` shapes
 * for each chunk. Returns when the stream closes; throws only if the
 * stream itself throws. The helper does NOT call `consumeStream()` —
 * iterating `fullStream` consumes it directly.
 *
 * Caller is responsible for awaiting `result.response` / `result.steps`
 * / `result.totalUsage` AFTER this returns for the final assembly.
 */
export async function consumeFullStreamAsEvalEvents(
  fullStream: FullStream,
  ctx: FullStreamAdapterContext,
): Promise<void> {
  for await (const part of fullStream) {
    switch (part.type) {
      case "text-delta":
        ctx.emit({ type: "text_delta", content: part.text });
        break;
      case "tool-call":
        ctx.emit({
          type: "tool_call",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          args: (part.input ?? {}) as Record<string, unknown>,
        });
        break;
      case "tool-result":
        ctx.emit({
          type: "tool_result",
          toolCallId: part.toolCallId,
          result: part.output,
          isError: false,
        });
        break;
      case "tool-error":
        ctx.emit({
          type: "tool_result",
          toolCallId: part.toolCallId,
          result: part.error,
          isError: true,
        });
        break;
      case "finish-step":
        ctx.emit({
          type: "step_finish",
          stepNumber: ctx.getStepIndex(),
          usage: {
            inputTokens: part.usage?.inputTokens ?? 0,
            outputTokens: part.usage?.outputTokens ?? 0,
          },
        });
        break;
      // Other chunk types (text-start, text-end, finish, error, raw,
      // file, source, …) are not part of the eval event vocabulary —
      // the runner consumes terminal state via `result.response` /
      // `result.totalUsage` / `result.finishReason` after this returns.
    }
  }
}
