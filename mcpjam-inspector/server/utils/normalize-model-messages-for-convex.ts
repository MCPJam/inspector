import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * Build the `{ type, value }` envelope `modelMessageSchema` requires on a
 * tool-result `output`, or `undefined` when there is nothing to build one
 * from.
 *
 * The schema is stricter than the type tag alone suggests, and each rule below
 * is one it enforces: `json` and `error-json` take any JSON value including
 * null, `text` and `error-text` require a string, and `content` requires
 * an array. An envelope whose value contradicts its own type is rejected
 * exactly like a missing `output`, so preserving one because its tag looked
 * familiar just moves the failure.
 *
 * A payload that is not a valid envelope keeps its data and is re-declared as
 * `json`, the only type that accepts an arbitrary value.
 *
 * Exported because the trace-snapshot sink needs the same answer: its messages
 * are persisted without passing through this normalizer, and two spellings of
 * this rule is how they drift apart.
 */
export function toModelMessageToolOutput(
  payload: unknown,
): { type: string; value: unknown } | undefined {
  if (payload === undefined) return undefined;
  if (payload !== null && typeof payload === "object" && "value" in payload) {
    const envelope = payload as { type?: unknown; value: unknown };
    const { type, value } = envelope;
    if (type === "json" || type === "error-json") {
      // `undefined` serializes away and fails like a missing key; null does not.
      return value === undefined
        ? { ...envelope, type, value: null }
        : (envelope as { type: string; value: unknown });
    }
    if (
      ((type === "text" || type === "error-text") &&
        typeof value === "string") ||
      (type === "content" && Array.isArray(value))
    ) {
      return envelope as { type: string; value: unknown };
    }
    if (type === "text" || type === "error-text" || type === "content") {
      // Recognized tag, value the schema will not accept under it. Keep the
      // payload and re-declare it rather than nesting the whole envelope.
      return { type: "json", value: value ?? null };
    }
  }
  return { type: "json", value: payload };
}

/**
 * Convex streamText validates Message[] strictly. Persisted or provider-shaped
 * traces often omit toolCallId on tool-call / tool-result parts (e.g. only
 * toolName: "invocation"), which breaks validation and surfaces as
 * AI_InvalidPromptError. Repair IDs in-order so each tool-result pairs with
 * the preceding assistant tool-call round-trip.
 */
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
        toModelMessageToolOutput(out.output) ??
        toModelMessageToolOutput(out.result);
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
