/**
 * Payload economics for the agent Playground surface.
 *
 * This module exists because the whole POINT of the surface is raw values —
 * an agent debugging its own MCP server needs the arguments it sent and the
 * result it got back, not a prose summary. `user-testing.ts` deliberately
 * flattens tool payloads to text ("a caller who needs the raw shape has the
 * app"); here the caller IS the app, so the shape is the deliverable.
 *
 * That makes bounding a first-class concern rather than an afterthought. A
 * tool result can be a megabyte of base64, and this surface is consumed by
 * models that pay per token for every byte they are handed. So every payload
 * that leaves here goes through `boundJson` (`payload-bounds.ts`): scrubbed of
 * protocol annotations and secrets, depth-capped, and, when its JSON is over a
 * ceiling, shortened INSIDE the value. It keeps its JSON type, so a field such
 * as `isError` stays a field.
 *
 * Truncation is always ANNOUNCED: `truncated: true`, with `truncatedFields`
 * naming each cut. A silently shortened tool result is worse than an omitted
 * one: an agent reading it would conclude the server returned the short value
 * and debug the wrong thing.
 */

import type { SecretScrubber } from "../../utils/secrets/secret-scrubber";
import { boundJson, type TruncatedField } from "./payload-bounds";

/** Serialized ceiling for ONE tool call's input or output, with its cuts. */
export const MAX_TOOL_PAYLOAD_CHARS = 16_000;
/** Serialized ceiling for ONE projected message's content, with its cuts. */
export const MAX_MESSAGE_PAYLOAD_CHARS = 24_000;
/** Serialized ceiling for one page of projected messages. */
export const MAX_MESSAGE_PAGE_CHARS = 96_000;

/** A public record's truncation fields: both, or neither. */
function announceCuts(fields: TruncatedField[]): {
  truncated?: true;
  truncatedFields?: TruncatedField[];
} {
  return fields.length > 0 ? { truncated: true, truncatedFields: fields } : {};
}

// ── Tool-call joining ───────────────────────────────────────────────────────

/** One tool call as the public surface reports it. */
export interface PublicToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: "ok" | "error";
  output?: unknown;
  errorMessage?: string;
  truncated?: true;
  /** Each cut, with its path under `input` or `output`. */
  truncatedFields?: TruncatedField[];
}

type EngineToolCall = { toolCallId: string; toolName: string; input: unknown };
type EngineToolResult = {
  toolCallId: string;
  toolName?: string;
  output: unknown;
};

/**
 * Join the engine's `toolCalls` and `toolResults` by `toolCallId`.
 *
 * The engine returns them as two flat arrays (`RunAssistantTurnResult`), which
 * is the right shape for the persistence layer and the wrong one for a
 * debugging client — correlating them is exactly the work the caller should
 * not have to redo. Joining here also lets the surface report a call that
 * produced NO result, which is the interesting case: a tool that hung until
 * the wall clock fired leaves a call with no matching result, and dropping it
 * would hide the very failure the agent is looking for.
 */
export function joinToolCalls(
  toolCalls: readonly EngineToolCall[],
  toolResults: readonly EngineToolResult[],
  /**
   * Materialized project secrets this turn delivered. Supplied, their values
   * are replaced with `[secret:NAME]` in the LIVE response.
   *
   * The persistence path is scrubbed separately, at `buildIngestBody` — one
   * pass over the serialized body. This is the other half: what this function
   * returns goes straight back to the caller over HTTP and never passes through
   * that pass, so scrubbing only there would keep the value out of the
   * transcript while handing it to whoever made the request.
   */
  scrubber?: SecretScrubber,
): PublicToolCall[] {
  const resultsById = new Map<string, EngineToolResult>();
  for (const result of toolResults) {
    // FIRST result wins. A duplicate id is a protocol violation upstream; the
    // first is the one the model actually consumed for its next step.
    if (!resultsById.has(result.toolCallId)) {
      resultsById.set(result.toolCallId, result);
    }
  }
  return toolCalls.map((call) => {
    const result = resultsById.get(call.toolCallId);
    // `boundJson` scrubs the structured value BEFORE it cuts anything. Cutting
    // first could keep part of a credential that straddled the cut, and no
    // needle matches a fragment: partial is not safe, it is a shorter secret.
    const input = boundJson(call.input, MAX_TOOL_PAYLOAD_CHARS, {
      scrubber,
      field: "input",
    });
    if (!result) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: input.value,
        status: "error" as const,
        // Not "the tool failed" — "no result reached us". The distinction
        // matters: an aborted turn and a tool that returned an error payload
        // lead an agent to different next moves.
        errorMessage:
          "No tool result was recorded for this call (the turn ended first).",
        ...announceCuts(input.truncatedFields),
      };
    }
    const output = boundJson(
      readToolOutput(result.output),
      MAX_TOOL_PAYLOAD_CHARS,
      { scrubber, field: "output" },
    );
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName ?? result.toolName ?? "unknown",
      input: input.value,
      // Read off the whole result, before bounding, so no cut can hide it.
      status: isErrorOutput(result.output)
        ? ("error" as const)
        : ("ok" as const),
      output: output.value,
      ...announceCuts([...input.truncatedFields, ...output.truncatedFields]),
    };
  });
}

/**
 * Unwrap the AI SDK's tool-output envelope.
 *
 * `ToolResultPart.output` is a tagged union (`{type: "json", value}`,
 * `{type: "text", value}`, `{type: "error-json", value}`, …) rather than the
 * raw MCP result. Callers want the value; the tag is already reported through
 * `status`. An unrecognized shape is passed through verbatim rather than
 * dropped — a future SDK tag should degrade to "you get the envelope", not to
 * "the output vanished".
 */
function readToolOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const record = output as { type?: unknown; value?: unknown };
  if (typeof record.type === "string" && "value" in record) {
    return record.value;
  }
  return output;
}

/** The AI SDK's error tags, plus an MCP `isError` result envelope. */
function isErrorOutput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const record = output as { type?: unknown; value?: unknown };
  if (record.type === "error-json" || record.type === "error-text") return true;
  const value = "value" in record ? record.value : output;
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as { isError?: unknown }).isError === true,
  );
}

// ── Message projection ──────────────────────────────────────────────────────

/** One stored message as the public detail read reports it. */
export interface PublicMessage {
  index: number;
  role: string;
  content: unknown;
  truncated?: true;
  /** Each cut, with its path under `content`. */
  truncatedFields?: TruncatedField[];
}

/**
 * Project stored transcript messages into the public detail shape.
 *
 * INDEXES ARE THE CONTRACT. Trace spans reference messages positionally, so
 * `index` is the absolute position in the stored transcript — never the
 * position within the returned page. Renumbering per page would break the
 * one join this read exists to enable.
 *
 * The page stops before the message that would take its JSON past
 * MAX_MESSAGE_PAGE_CHARS, but always holds at least one, so paging moves on.
 * That one is bounded too: its content and cut list fit
 * MAX_MESSAGE_PAYLOAD_CHARS. A page can hold fewer messages than it was
 * given, and the caller pages on from the number it returns.
 */
export function projectMessages(
  messages: readonly unknown[],
  offset: number,
): PublicMessage[] {
  const page: PublicMessage[] = [];
  // The page's JSON: its brackets, each message, and the commas between.
  let pageChars = 2;
  for (const [position, message] of messages.entries()) {
    const projected = projectMessage(message, offset + position);
    const added = JSON.stringify(projected).length + (page.length > 0 ? 1 : 0);
    if (page.length > 0 && pageChars + added > MAX_MESSAGE_PAGE_CHARS) break;
    page.push(projected);
    pageChars += added;
  }
  return page;
}

function projectMessage(message: unknown, index: number): PublicMessage {
  const record =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
  const bounded = boundJson(
    record.content ?? record.parts ?? message,
    MAX_MESSAGE_PAYLOAD_CHARS,
    { field: "content" },
  );
  return {
    index,
    role: typeof record.role === "string" ? record.role : "unknown",
    content: bounded.value,
    ...announceCuts(bounded.truncatedFields),
  };
}
