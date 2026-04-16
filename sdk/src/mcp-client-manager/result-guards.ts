import {
  type CallToolResult,
  type CreateTaskResult,
} from "@modelcontextprotocol/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isEmbeddedResource(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.uri === "string" &&
    ("text" in value || "blob" in value || "_meta" in value)
  );
}

function isCallToolContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return (
        typeof value.data === "string" && typeof value.mimeType === "string"
      );
    case "resource":
      return isEmbeddedResource(value.resource);
    default:
      return false;
  }
}

export function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    isRecord(value) &&
    Array.isArray(value.content) &&
    value.content.every(isCallToolContentBlock)
  );
}

export function assertCallToolResult(
  value: unknown,
  context = "MCP tool call result"
): CallToolResult {
  if (!isCallToolResult(value)) {
    throw new TypeError(`${context} was not a valid CallToolResult.`);
  }
  return value;
}

export function isCreateTaskResult(
  value: unknown
): value is CreateTaskResult {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = (value as { task?: unknown }).task;
  return (
    !!task &&
    typeof task === "object" &&
    typeof (task as { taskId?: unknown }).taskId === "string"
  );
}
