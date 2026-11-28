import { redactSensitiveValue } from "@mcpjam/sdk";
import type { RecordedAppOpening } from "@mcpjam/sdk/platform";
import { MAX_TOOL_PAYLOAD_CHARS } from "./chat-session-payloads.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedArguments(input: unknown): Record<string, unknown> | undefined {
  const args = record(input);
  if (!args || JSON.stringify(args).length > MAX_TOOL_PAYLOAD_CHARS) return;
  const stack = [{ value: args as unknown, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (!value || typeof value !== "object") continue;
    if (depth >= 32) return;
    for (const child of Object.values(value)) {
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return record(redactSensitiveValue(args));
}

/** Project one opening call from the scoped transcript, before the message
 * projection removes protocol keys. Its surrounding calls establish which
 * other model actions would need to be replayed. */
export function projectRecordedAppOpening(
  messages: readonly unknown[],
  toolCallId: string,
): RecordedAppOpening | undefined {
  let promptIndex = -1;
  let toolCallIds: string[] = [];
  let opening: RecordedAppOpening | undefined;
  for (const item of messages) {
    const message = record(item);
    if (message?.role === "user") {
      if (opening) break;
      promptIndex += 1;
      toolCallIds = [];
      continue;
    }
    if (promptIndex < 0 || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const item of message.content) {
      const part = record(item);
      if (part?.type !== "tool-call" || typeof part.toolCallId !== "string") continue;
      if (toolCallIds.length >= 64) return;
      toolCallIds.push(part.toolCallId);
      if (part.toolCallId === toolCallId) {
        if (opening) return;
        opening = { promptIndex, toolCallIds, arguments: boundedArguments(part.input) };
      }
    }
  }
  return opening;
}
