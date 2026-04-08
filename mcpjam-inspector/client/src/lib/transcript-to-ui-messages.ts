import { type UIMessage } from "@ai-sdk/react";
import { generateId } from "ai";

/**
 * Convert a persisted transcript blob (array of message objects from the
 * backend chat ingestion) into UIMessage[] suitable for the AI SDK useChat hook.
 *
 * The transcript format is the "session trace" produced by
 * buildSessionTraceMessages in chatIngestion/common.ts. Each entry has at least
 * { role, content } where content may be a string or an array of parts.
 */

interface TranscriptPart {
  type?: string;
  text?: string;
  value?: string;
  content?: string;
  [key: string]: unknown;
}

interface TranscriptMessage {
  id?: string;
  role?: string;
  content?: string | TranscriptPart[];
  [key: string]: unknown;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: TranscriptPart) => {
      if (typeof part === "string") return part;
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if (typeof part.value === "string") return part.value;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter((t: string) => t.length > 0)
    .join("\n");
}

function convertParts(content: unknown): UIMessage["parts"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const parts: UIMessage["parts"] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }

    const partType = part?.type;
    if (partType === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (partType === "tool-call") {
      parts.push({
        type: "tool-invocation",
        toolInvocation: {
          state: "result" as const,
          toolCallId: part.toolCallId ?? part.id ?? generateId(),
          toolName: part.toolName ?? "unknown",
          args: part.args ?? part.input ?? {},
          result: part.result ?? {},
        },
      } as any);
    } else if (partType === "tool-result") {
      // Tool results are typically already captured via tool-call results
      // in the AI SDK format, so we skip standalone tool-result parts.
    } else if (typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (typeof part.value === "string") {
      parts.push({ type: "text", text: part.value });
    }
  }

  if (parts.length === 0) {
    parts.push({ type: "text", text: extractTextContent(content) });
  }

  return parts;
}

export function transcriptToUIMessages(transcript: unknown[]): UIMessage[] {
  if (!Array.isArray(transcript)) return [];

  const messages: UIMessage[] = [];
  for (const raw of transcript) {
    const msg = raw as TranscriptMessage;
    if (!msg || typeof msg !== "object") continue;

    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;

    // Skip tool-only messages (role=tool) -- they are inlined into assistant parts
    const uiRole =
      role === "system"
        ? ("system" as const)
        : role === "user"
          ? ("user" as const)
          : ("assistant" as const);

    messages.push({
      id: msg.id ?? generateId(),
      role: uiRole,
      parts: convertParts(msg.content),
    } as UIMessage);
  }

  return messages;
}
