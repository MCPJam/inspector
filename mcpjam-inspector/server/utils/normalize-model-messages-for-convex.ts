import type { ModelMessage } from "@ai-sdk/provider-utils";

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
      if (out.output === undefined && out.result !== undefined) {
        out.output = out.result;
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
