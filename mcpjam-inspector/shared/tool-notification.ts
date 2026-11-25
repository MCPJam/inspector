/**
 * What an MCP server sends while a tool call runs: `notifications/progress`
 * and `notifications/message`. The chat stream carries each as a transient
 * part keyed by the tool call it belongs to, so the card of the running call
 * can show them. Live only: neither is part of the call's result.
 */
export const TOOL_NOTIFICATION_PART_TYPE = "data-tool-notification" as const;

/** A log record keeps its text short: it is shown on a card, not stored. */
export const TOOL_NOTIFICATION_TEXT_MAX = 500;

export type ToolNotification =
  | {
      toolCallId: string;
      kind: "progress";
      progress: number;
      total?: number;
      message?: string;
    }
  | {
      toolCallId: string;
      kind: "log";
      level: string;
      logger?: string;
      text: string;
    };

export interface ToolNotificationDataPart {
  type: typeof TOOL_NOTIFICATION_PART_TYPE;
  data: ToolNotification;
  transient?: boolean;
}

/** A log record's `data` as one line of text: a string as it is, anything else as JSON. */
export function logDataText(data: unknown): string {
  let text: string;
  if (typeof data === "string") text = data;
  else {
    try {
      text = JSON.stringify(data) ?? String(data);
    } catch {
      text = String(data);
    }
  }
  return text.length > TOOL_NOTIFICATION_TEXT_MAX
    ? `${text.slice(0, TOOL_NOTIFICATION_TEXT_MAX)}…`
    : text;
}

export function isToolNotificationDataPart(
  value: unknown,
): value is ToolNotificationDataPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (part.type !== TOOL_NOTIFICATION_PART_TYPE) return false;
  const data = part.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object" || typeof data.toolCallId !== "string")
    return false;
  return data.kind === "progress"
    ? typeof data.progress === "number"
    : data.kind === "log" &&
        typeof data.level === "string" &&
        typeof data.text === "string";
}
