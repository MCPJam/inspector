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
      if (text.trim()) return text;
    }
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
}

/** Assemble an {@link IterationTranscript} from runner per-iteration data. */
export function buildIterationTranscript(
  input: BuildTranscriptInput,
): IterationTranscript {
  const finalAssistantMessage =
    input.finalAssistantMessage ??
    extractFinalAssistantMessage(messagesOf(input.trace));
  return {
    toolCalls: input.toolCalls,
    toolErrors: extractToolErrors(input.trace),
    ...(finalAssistantMessage !== undefined ? { finalAssistantMessage } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}
