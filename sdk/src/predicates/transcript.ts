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
  TranscriptCapture,
  TranscriptCaptureState,
  TranscriptToolCall,
  TranscriptToolCallTiming,
  TranscriptToolInventoryEntry,
  TranscriptToolResult,
  TranscriptUsage,
} from "./types.js";

/**
 * Caps on the evidence channels, so one pathological iteration cannot inflate
 * every persisted transcript.
 *
 * The text cap is a STORAGE cap and nothing else: `size.bytes` is measured on
 * the untruncated part before this applies, so a budget check still grades
 * what the server actually returned. Row caps mark the capture `partial` when
 * they bite, which is what stops a check from reading a truncated list as the
 * whole story.
 */
export const MAX_TOOL_RESULT_TEXT_CHARS = 64_000;
export const MAX_TOOL_RESULT_ROWS = 200;
export const MAX_TOOL_CALL_TIMING_ROWS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Text of the last assistant message in a message list, if any. */
export function extractFinalAssistantMessage(
  messages: unknown
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
          isRecord(part) && part.type === "text" ? String(part.text ?? "") : ""
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

/**
 * Count user turns in a message list.
 *
 * Returns `undefined` — not 0 — when the trace carries no readable messages,
 * so `turnCountUnder` can fail closed. Zero is a real reading (an iteration
 * that never got a user message); "we could not look" is not.
 */
function countUserTurns(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) return undefined;
  let count = 0;
  for (const message of messages) {
    if (isRecord(message) && message.role === "user") count += 1;
  }
  return count;
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
  /**
   * User turns for the iteration, when the caller already counted them.
   * Otherwise derived from the trace's user-role messages.
   */
  turnCount?: number;
  /**
   * Observed tool results, when the caller captured them.
   *
   * ABSENT is not the same as EMPTY, and the difference decides whether a
   * result-shaped check reports a scored absence or an error. A caller that
   * did not look passes nothing here and gets `capture.toolResults: "absent"`;
   * a caller that looked and saw none passes `[]` with
   * `resultsCaptured: true`.
   */
  toolResults?: TranscriptToolResult[];
  /** True when the caller actually looked for results. See {@link toolResults}. */
  resultsCaptured?: boolean;
  /** Observed per-call durations. Same absent-vs-empty rule. */
  toolCallTimings?: TranscriptToolCallTiming[];
  /** True when the caller actually looked for timings. */
  timingsCaptured?: boolean;
  /**
   * The tools advertised to the model this iteration, as the runner had them.
   * Absent ⇒ declaration-comparing checks report `status: "error"`.
   */
  toolInventory?: TranscriptToolInventoryEntry[];
}

/**
 * Per-turn signals the runner captured for a single prompt turn. The runner
 * already groups tool calls / assistant message / render observations by turn
 * (`promptSummaries`); this is the slice handed to per-turn check evaluation.
 */
export interface TurnTranscriptInput {
  /** Tool calls observed during this turn only. */
  toolCalls: TranscriptToolCall[];
  /** This turn's assistant message text, if any. */
  finalAssistantMessage?: string;
  /** Tool errors observed during this turn only. */
  toolErrors?: ToolErrorRecord[];
  /** Widget render observations recorded during this turn only. */
  renderObservations?: RenderObservationSummary[];
  /** Token usage for this turn, if measured (rarely available per-turn). */
  usage?: TranscriptUsage;
}

/**
 * Assemble a turn-scoped {@link IterationTranscript} from per-turn signals.
 * Unlike {@link buildIterationTranscript} there is no trace to parse — the
 * runner supplies already-extracted per-turn data. Feeding this slice to the
 * existing `evaluatePredicates` makes "the final message", "the first tool",
 * "calls to X" all resolve to the turn, with no change to the evaluator core.
 */
export function buildTurnTranscript(
  input: TurnTranscriptInput
): IterationTranscript {
  return {
    toolCalls: input.toolCalls,
    toolErrors: input.toolErrors ?? [],
    ...(input.finalAssistantMessage !== undefined
      ? { finalAssistantMessage: input.finalAssistantMessage }
      : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.renderObservations && input.renderObservations.length > 0
      ? { renderObservations: input.renderObservations }
      : {}),
  };
}

/**
 * Cap a result's stored text WITHOUT touching its measured size.
 *
 * `truncated` marks the text; `size.bytes` keeps whatever the caller measured
 * on the whole part. A reader that grades the stored length instead would
 * report every oversized result as exactly the cap.
 */
function capResultText(result: TranscriptToolResult): TranscriptToolResult {
  if (
    typeof result.text !== "string" ||
    result.text.length <= MAX_TOOL_RESULT_TEXT_CHARS
  ) {
    return result;
  }
  return {
    ...result,
    text: result.text.slice(0, MAX_TOOL_RESULT_TEXT_CHARS),
    truncated: true,
  };
}

/**
 * How completely one channel was captured.
 *
 * Three states, because they are three different facts: nobody looked
 * (`absent`), we looked and the rows are all here (`complete`), we looked and
 * the cap bit (`partial`). Only `complete` licenses reading "no rows" as
 * "nothing happened".
 */
function stateFor(
  captured: boolean | undefined,
  rows: readonly unknown[] | undefined,
  cap: number
): TranscriptCaptureState {
  if (rows === undefined && captured !== true) return "absent";
  return (rows?.length ?? 0) > cap ? "partial" : "complete";
}

/** Assemble an {@link IterationTranscript} from runner per-iteration data. */
export function buildIterationTranscript(
  input: BuildTranscriptInput
): IterationTranscript {
  const finalAssistantMessage =
    input.finalAssistantMessage ??
    extractFinalAssistantMessage(messagesOf(input.trace));
  const toolErrors = [
    ...extractToolErrors(input.trace),
    ...(input.toolErrors ?? []),
  ];
  const turnCount = input.turnCount ?? countUserTurns(messagesOf(input.trace));
  const capture: TranscriptCapture = {
    toolResults: stateFor(
      input.resultsCaptured,
      input.toolResults,
      MAX_TOOL_RESULT_ROWS
    ),
    toolCallTimings: stateFor(
      input.timingsCaptured,
      input.toolCallTimings,
      MAX_TOOL_CALL_TIMING_ROWS
    ),
    toolInventory: input.toolInventory === undefined ? "absent" : "complete",
  };
  return {
    toolCalls: input.toolCalls,
    toolErrors,
    ...(finalAssistantMessage !== undefined ? { finalAssistantMessage } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...(input.renderObservations && input.renderObservations.length > 0
      ? { renderObservations: input.renderObservations }
      : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(input.toolResults
      ? {
          toolResults: input.toolResults
            .slice(0, MAX_TOOL_RESULT_ROWS)
            .map(capResultText),
        }
      : {}),
    ...(input.toolCallTimings
      ? {
          toolCallTimings: input.toolCallTimings.slice(
            0,
            MAX_TOOL_CALL_TIMING_ROWS
          ),
        }
      : {}),
    ...(input.toolInventory ? { toolInventory: input.toolInventory } : {}),
    capture,
  };
}
