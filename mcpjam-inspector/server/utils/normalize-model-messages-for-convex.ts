import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * Convex streamText validates Message[] strictly. Persisted or provider-shaped
 * traces often omit toolCallId on tool-call / tool-result parts (e.g. only
 * toolName: "invocation"), which breaks validation and surfaces as
 * AI_InvalidPromptError. Repair IDs in-order so each tool-result pairs with
 * the preceding assistant tool-call round-trip.
 */
/**
 * The `type`s `modelMessageSchema` accepts on a tool-result `output`.
 */
const TOOL_OUTPUT_TYPES = new Set([
  "text",
  "json",
  "error-text",
  "error-json",
  "content",
]);

/**
 * Coerce a tool-result payload into the `{ type, value }` union the schema
 * requires, or `undefined` when there is nothing to coerce.
 *
 * `json` is the wrapper for an unknown payload because it accepts any JSON
 * value; `text` would reject anything but a string.
 *
 * This exists because the repair it replaces assigned `result` straight onto
 * `output`, which traded a missing key for a malformed one — the schema
 * rejects a bare payload exactly as it rejects an absent `output`, so a
 * v4-shaped message still failed. It failed invisibly, too: the offending
 * index lives in the part of the log Convex truncates.
 */
function toToolResultOutput(
  payload: unknown,
): { type: string; value: unknown } | undefined {
  if (payload === undefined) return undefined;
  if (
    payload !== null &&
    typeof payload === "object" &&
    TOOL_OUTPUT_TYPES.has(
      (payload as { type?: unknown }).type as string,
    ) &&
    "value" in payload
  ) {
    const typed = payload as { type: string; value: unknown };
    // `value: undefined` serializes away, leaving `{"type":"json"}`, which
    // fails the same check a missing `output` does. Land it on null.
    return typed.value === undefined ? { ...typed, value: null } : typed;
  }
  return { type: "json", value: payload };
}

export function normalizeModelMessagesForConvex(
  messages: ModelMessage[],
): ModelMessage[] {
  let serial = 0;
  const nextId = () => `mcpjam-synth-${serial++}`;

  const pendingToolCallIds: string[] = [];

  const normalizePart = (
    part: unknown,
    role: "assistant" | "tool",
  ): unknown => {
    if (!part || typeof part !== "object") return part;
    const p = part as Record<string, unknown>;
    const type = p.type;

    if (role === "assistant" && type === "tool-call") {
      const out = { ...p };
      let toolCallId =
        typeof out.toolCallId === "string" && out.toolCallId.length > 0
          ? out.toolCallId
          : undefined;
      if (!toolCallId) {
        toolCallId = nextId();
        out.toolCallId = toolCallId;
      }
      pendingToolCallIds.push(toolCallId);
      if (out.args === undefined && out.input === undefined) {
        out.args = {};
      }
      return out;
    }

    if (role === "tool" && type === "tool-result") {
      const out = { ...p };
      let toolCallId =
        typeof out.toolCallId === "string" && out.toolCallId.length > 0
          ? out.toolCallId
          : undefined;
      if (!toolCallId) {
        toolCallId = pendingToolCallIds.shift() ?? nextId();
        out.toolCallId = toolCallId;
      } else {
        const idx = pendingToolCallIds.indexOf(toolCallId);
        if (idx >= 0) {
          pendingToolCallIds.splice(idx, 1);
        }
      }
      // `result` is the AI SDK v4 spelling and still reaches this point from
      // older traces and replayed transcripts. Both keys go through the same
      // coercion so a malformed `output` is repaired rather than trusted.
      const output =
        toToolResultOutput(out.output) ?? toToolResultOutput(out.result);
      if (output) {
        out.output = output;
      }
      return out;
    }

    return part;
  };

  return messages.map((msg) => {
    if (msg.role === "assistant") {
      const m = msg as { content?: unknown };
      if (!Array.isArray(m.content)) return msg;
      return {
        ...msg,
        content: m.content.map((part) => normalizePart(part, "assistant")),
      } as ModelMessage;
    }
    if (msg.role === "tool") {
      const m = msg as { content?: unknown };
      if (!Array.isArray(m.content)) return msg;
      return {
        ...msg,
        content: m.content.map((part) => normalizePart(part, "tool")),
      } as ModelMessage;
    }
    if (msg.role === "user") {
      const m = msg as { content?: unknown };
      const c = m.content;
      if (
        Array.isArray(c) &&
        c.length === 1 &&
        c[0] &&
        typeof c[0] === "object" &&
        (c[0] as { type?: string }).type === "text" &&
        typeof (c[0] as { text?: string }).text === "string"
      ) {
        return {
          ...msg,
          content: (c[0] as { text: string }).text,
        } as ModelMessage;
      }
    }
    return msg;
  });
}
