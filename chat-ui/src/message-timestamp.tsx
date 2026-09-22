import type { UIMessage } from "@ai-sdk/react";
import { isHiddenInternalMessage } from "./internal/thread-helpers";

export const MESSAGE_TIMESTAMP_METADATA_KEY = "timestampMs" as const;

export interface MessageTurnTiming {
  promptIndex: number;
  startedAt: number;
  endedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function getMessageTimestampMs(message: UIMessage): number | undefined {
  if (!isRecord(message.metadata)) return undefined;
  const value = message.metadata[MESSAGE_TIMESTAMP_METADATA_KEY];
  return validTimestamp(value) ? value : undefined;
}

export function withMessageTimestampMetadata(
  metadata: Record<string, unknown> | undefined,
  timestampMs: number
): Record<string, unknown> {
  if (!validTimestamp(timestampMs)) return metadata ?? {};
  if (validTimestamp(metadata?.[MESSAGE_TIMESTAMP_METADATA_KEY])) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    [MESSAGE_TIMESTAMP_METADATA_KEY]: timestampMs,
  };
}

export function withMessageTimestamp(
  message: UIMessage,
  timestampMs: number
): UIMessage {
  if (getMessageTimestampMs(message) !== undefined) return message;
  const metadata = isRecord(message.metadata) ? message.metadata : undefined;
  return {
    ...message,
    metadata: withMessageTimestampMetadata(metadata, timestampMs),
  };
}

export function timestampMessageById(
  messages: UIMessage[],
  messageId: string,
  timestampMs: number
): UIMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.id !== messageId) return message;
    const timestamped = withMessageTimestamp(message, timestampMs);
    changed ||= timestamped !== message;
    return timestamped;
  });
  return changed ? next : messages;
}

/**
 * Fill missing UI-only timestamps from persisted per-turn timing rows. A turn
 * begins at its user message and owns every assistant message until the next
 * user message. Existing message metadata always wins.
 */
export function hydrateMessageTimestamps(
  messages: UIMessage[],
  timings: readonly MessageTurnTiming[] | undefined
): UIMessage[] {
  if (!timings || timings.length === 0) return messages;

  const timingByPromptIndex = new Map(
    timings.map((timing) => [timing.promptIndex, timing] as const)
  );
  let promptIndex = -1;
  let changed = false;

  const next = messages.map((message) => {
    if (isHiddenInternalMessage(message)) return message;
    if (message.role === "user") promptIndex += 1;
    if (message.role !== "user" && message.role !== "assistant") {
      return message;
    }
    if (getMessageTimestampMs(message) !== undefined) return message;

    const timing = timingByPromptIndex.get(promptIndex);
    if (!timing) return message;
    const timestampMs =
      message.role === "user" ? timing.startedAt : timing.endedAt;
    const timestamped = withMessageTimestamp(message, timestampMs);
    changed ||= timestamped !== message;
    return timestamped;
  });

  return changed ? next : messages;
}

export function formatMessageTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

export function formatMessageDateTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

export function MessageTimestamp({ message }: { message: UIMessage }) {
  const timestampMs = getMessageTimestampMs(message);
  if (timestampMs === undefined) return null;

  const date = new Date(timestampMs);
  return (
    <time
      dateTime={date.toISOString()}
      title={formatMessageDateTime(timestampMs)}
      className="inline-flex h-6 items-center px-1 text-xs leading-none tabular-nums text-muted-foreground"
    >
      {formatMessageTime(timestampMs)}
    </time>
  );
}
