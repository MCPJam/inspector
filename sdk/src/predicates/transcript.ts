/**
 * Adapter: build the stable {@link IterationTranscript} the predicate evaluator
 * consumes from the data an eval runner already has per iteration — the trace
 * (messages + spans), the tool calls, and token usage.
 *
 * Tool-error classification (content-error vs protocol-error) is delegated to
 * `extractToolErrors` so it stays in lockstep with the runner's existing
 * `traceIndicatesToolExecutionFailure` gate.
 */

import { extractToolErrors } from "../eval-tool-execution.js";
import type { EvalTraceInput } from "../eval-reporting-types.js";
import type {
  IterationTranscript,
  RenderObservationSummary,
  ToolErrorRecord,
  TranscriptToolCall,
  TranscriptUsage,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Text of the last assistant message in a message list, if any. */
export function extractFinalAssistantMessage(
  messages: unknown,
): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== "assistant") continue;
    // The chronologically last assistant message *is* the final message. If it
    // carries no text (tool-call-only or whitespace), there is no final
    // assistant text — return undefined rather than falling through to an
    // earlier turn, which would make `responseContains` / `responseMatches` /
    // `finalAssistantMessageNonEmpty` judge the wrong turn.
    const content = msg.content;
    if (typeof content === "string") {
      return content.trim() ? content : undefined;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          isRecord(part) && part.type === "text" ? String(part.text ?? "") : "",
        )
        .join("");
      return text.trim() ? text : undefined;
    }
    return undefined;
  }
  return undefined;
}

function messagesOf(trace: EvalTraceInput | undefined): unknown {
  if (trace == null || typeof trace === "string") return undefined;
  if (Array.isArray(trace)) return trace;
  if (isRecord(trace)) return trace.messages;
  return undefined;
}

export interface BuildTranscriptInput {
  trace?: EvalTraceInput;
  toolCalls: TranscriptToolCall[];
  usage?: TranscriptUsage;
  /** Override the message-derived final assistant text when the runner has it. */
  finalAssistantMessage?: string;
  /** Widget render observation summaries, when the runner captured any. */
  renderObservations?: RenderObservationSummary[];
  /**
   * Tool errors the runner observed outside the trace. A model-free pinned
   * tool call has no trace for `extractToolErrors` to read, so its failures
   * (content-error / protocol-error) must be passed explicitly — otherwise
   * `noToolErrors` would pass falsely. Merged with trace-derived errors.
   */
  toolErrors?: ToolErrorRecord[];
}

/** Assemble an {@link IterationTranscript} from runner per-iteration data. */
export function buildIterationTranscript(
  input: BuildTranscriptInput,
): IterationTranscript {
  const finalAssistantMessage =
    input.finalAssistantMessage ??
    extractFinalAssistantMessage(messagesOf(input.trace));
  const toolErrors = [
    ...extractToolErrors(input.trace),
    ...(input.toolErrors ?? []),
  ];
  return {
    toolCalls: input.toolCalls,
    toolErrors,
    ...(finalAssistantMessage !== undefined ? { finalAssistantMessage } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.renderObservations && input.renderObservations.length > 0
      ? { renderObservations: input.renderObservations }
      : {}),
  };
}
