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

  const normalizeFilePart = (part: unknown): unknown => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return part;
    }

    const filePart = part as Record<string, unknown>;
    if (filePart.type !== "file" || typeof filePart.data !== "string") {
      return part;
    }

    // Browser attachments arrive as data URLs, but Convex expects the raw
    // base64 payload and otherwise attempts to fetch the data: URI.
    const match = /^data:[^,]*;base64,([\s\S]*)$/i.exec(filePart.data);
    return match ? { ...filePart, data: match[1] } : part;
  };

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
        content: m.content.map((part) =>
          normalizeFilePart(normalizePart(part, "assistant")),
        ),
      } as ModelMessage;
    }
    if (msg.role === "tool") {
      const m = msg as { content?: unknown };
      if (!Array.isArray(m.content)) return msg;
      return {
        ...msg,
        content: m.content.map((part) =>
          normalizeFilePart(normalizePart(part, "tool")),
        ),
      } as ModelMessage;
    }
    if (msg.role === "user") {
      const m = msg as { content?: unknown };
      const c = m.content;
      const content = Array.isArray(c) ? c.map(normalizeFilePart) : c;
      if (
        Array.isArray(content) &&
        content.length === 1 &&
        content[0] &&
        typeof content[0] === "object" &&
        (content[0] as { type?: string }).type === "text" &&
        typeof (content[0] as { text?: string }).text === "string"
      ) {
        return {
          ...msg,
          content: (content[0] as { text: string }).text,
        } as ModelMessage;
      }
      if (content !== c) {
        return { ...msg, content } as ModelMessage;
      }
    }
    return msg;
  });
}
