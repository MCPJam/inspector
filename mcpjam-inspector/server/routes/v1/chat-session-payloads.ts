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
 * that leaves here is:
 *
 *   1. SCRUBBED — `$`-prefixed keys and `_meta` are dropped, the same producer
 *      rule the tool-snapshot writer applies. These are transport/protocol
 *      annotations, never the caller's data, and `$`-keys in particular are
 *      what Convex refuses to store.
 *   2. DEPTH-CAPPED — beyond {@link MAX_DEPTH} a value becomes the marker
 *      string rather than recursing, so a cyclic or pathologically nested
 *      structure cannot stall the response.
 *   3. SIZE-CAPPED — measured on the SERIALIZED result, not on a field count,
 *      because size is what the caller pays for.
 *
 * Truncation is always ANNOUNCED (`truncated: true`). A silently shortened
 * tool result is worse than an omitted one: an agent reading it would
 * conclude the server returned the short value and debug the wrong thing.
 */

import type { SecretScrubber } from "../../utils/secrets/secret-scrubber";

/** Nesting beyond this is replaced by a marker rather than recursed into. */
const MAX_DEPTH = 8;
/** Serialized ceiling for ONE tool call's input or output. */
export const MAX_TOOL_PAYLOAD_CHARS = 16_000;
/** Serialized ceiling for ONE projected message. */
export const MAX_MESSAGE_PAYLOAD_CHARS = 24_000;
/** Replacement for a value that sat below {@link MAX_DEPTH}. */
const DEPTH_MARKER = "[truncated: max depth]";

/**
 * Protocol annotations the public surface never republishes.
 *
 * `_meta` is the MCP extension bag (progress tokens, `ui.*` hints, vendor
 * keys); `$`-prefixed keys are the reserved-name space. Neither is the
 * caller's own data, and both are exactly what the tool-snapshot producer
 * strips before persistence — the rule is the same one, applied at a second
 * boundary rather than restated as a new policy.
 */
function isDroppedKey(key: string): boolean {
  return key.startsWith("$") || key === "_meta";
}

/**
 * Deep-copy a JSON-ish value, dropping protocol keys and capping depth.
 *
 * Non-JSON values (functions, symbols, bigint) are dropped rather than
 * stringified: they cannot have come from an MCP wire payload, so their
 * presence means something upstream handed us a live object, and echoing a
 * stringified `[object Object]` into a public response would be noise.
 */
function scrubValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    // `bigint` is JSON-hostile (`JSON.stringify` THROWS on it, which would
    // turn one odd tool result into a 500 for the whole turn). Render it as
    // its decimal string so the caller still sees the number.
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") {
      return undefined;
    }
    return value;
  }
  if (depth >= MAX_DEPTH) return DEPTH_MARKER;
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isDroppedKey(key)) continue;
    const scrubbed = scrubValue(entry, depth + 1);
    if (scrubbed !== undefined) out[key] = scrubbed;
  }
  return out;
}

export interface BoundedPayload {
  /** The scrubbed value, or the serialized prefix when over the ceiling. */
  value: unknown;
  /** Present ONLY when the caller is seeing less than the whole payload. */
  truncated?: true;
}

/**
 * Scrub a payload and bound its serialized size.
 *
 * Over the ceiling the value is replaced by a STRING prefix rather than a
 * structurally-pruned object. A half-pruned object is a lie with the same
 * shape as the truth — a caller cannot tell which keys were dropped — whereas
 * a visibly-clipped string plus `truncated: true` is unmistakable.
 */
export function boundPayload(
  value: unknown,
  maxChars = MAX_TOOL_PAYLOAD_CHARS,
): BoundedPayload {
  if (value === undefined) return { value: undefined };
  const scrubbed = scrubValue(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(scrubbed) ?? "null";
  } catch {
    // A cycle survives the depth cap when it is shallower than MAX_DEPTH and
    // wide. Report it rather than throwing: one unserializable tool result
    // must not fail a turn that already ran and already spent.
    return { value: "[unserializable]", truncated: true };
  }
  if (serialized.length <= maxChars) return { value: scrubbed };
  return { value: `${serialized.slice(0, maxChars)}…`, truncated: true };
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
  const scrub = <T>(value: T): T =>
    scrubber ? scrubber.scrubDeep(value) : value;
  return toolCalls.map((call) => {
    const result = resultsById.get(call.toolCallId);
    // Scrubbed BEFORE bounding. This was the other way round, and the reason
    // given — deterministic truncation points, since `[secret:NAME]` is
    // usually shorter than the credential it replaces — was a real property
    // but the wrong trade.
    //
    // Bounding first cuts the serialized payload at a fixed offset, and a
    // credential STRADDLING that cut survives: the retained prefix holds only
    // part of the value, so no needle matches it and those bytes go out in a
    // response that crosses the trust boundary. Partial is not safe — it is a
    // shorter secret. Scrubbing first means the cut can only ever land inside
    // `[secret:NAME]`.
    //
    // What that costs is the consistency the old ordering bought: two runs of
    // one tool now truncate at different offsets depending on whether a secret
    // appeared. That is cosmetic, and arguably more honest — the redacted
    // payload really is shorter.
    const input = boundPayload(scrub(call.input));
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
        ...(input.truncated ? { truncated: true as const } : {}),
      };
    }
    const output = boundPayload(scrub(readToolOutput(result.output)));
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName ?? result.toolName ?? "unknown",
      input: input.value,
      status: isErrorOutput(result.output)
        ? ("error" as const)
        : ("ok" as const),
      output: output.value,
      ...(input.truncated || output.truncated
        ? { truncated: true as const }
        : {}),
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
}

/**
 * Project stored transcript messages into the public detail shape.
 *
 * INDEXES ARE THE CONTRACT. Trace spans reference messages positionally, so
 * `index` is the absolute position in the stored transcript — never the
 * position within the returned page. Renumbering per page would break the
 * one join this read exists to enable.
 */
export function projectMessages(
  messages: readonly unknown[],
  offset: number,
): PublicMessage[] {
  return messages.map((message, position) => {
    const record =
      message && typeof message === "object"
        ? (message as Record<string, unknown>)
        : {};
    const bounded = boundPayload(
      record.content ?? record.parts ?? message,
      MAX_MESSAGE_PAYLOAD_CHARS,
    );
    return {
      index: offset + position,
      role: typeof record.role === "string" ? record.role : "unknown",
      content: bounded.value,
      ...(bounded.truncated ? { truncated: true as const } : {}),
    };
  });
}
