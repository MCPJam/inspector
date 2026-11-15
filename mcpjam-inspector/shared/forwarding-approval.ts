import type { UIMessage } from "ai";
export const FORWARDING_TOOL_PREFIX = "mcpjam-forwarding:";
const APPROVAL_PREFIX = "mjfg1:";
export function forwardingApprovalId(
  executionId: string,
  owner: unknown,
  approvalId: string,
): string {
  return APPROVAL_PREFIX + JSON.stringify({ executionId, owner, approvalId });
}
export function readForwardingApprovalId(
  value: string,
): { executionId: string; owner: unknown; approvalId: string } | null {
  if (!value.startsWith(APPROVAL_PREFIX) || value.length > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(value.slice(APPROVAL_PREFIX.length));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("executionId" in parsed) ||
      typeof parsed.executionId !== "string" ||
      !("owner" in parsed) ||
      !("approvalId" in parsed) ||
      typeof parsed.approvalId !== "string"
    )
      return null;
    return {
      executionId: parsed.executionId,
      owner: parsed.owner,
      approvalId: parsed.approvalId,
    };
  } catch {
    return null;
  }
}
export function isForwardingApprovalId(value: string): boolean {
  return value.startsWith(APPROVAL_PREFIX);
}
export function withoutForwardingGateParts<T extends UIMessage>(
  messages: T[],
): T[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter(
      (part) =>
        !(
          "toolCallId" in part &&
          typeof part.toolCallId === "string" &&
          part.toolCallId.startsWith(FORWARDING_TOOL_PREFIX)
        ),
    ),
  }));
}

/** Gate cards are authorization evidence, never model tool calls. */
export function stripForwardingRequestBody(body: string): string {
  try {
    const value: unknown = JSON.parse(body);
    if (
      !value ||
      typeof value !== "object" ||
      !("messages" in value) ||
      !Array.isArray(value.messages)
    )
      return body;
    let changed = false;
    const messages = value.messages.map((message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("parts" in message) ||
        !Array.isArray(message.parts)
      )
        return message;
      const parts = message.parts.filter((part: unknown) => {
        const gate =
          !!part &&
          typeof part === "object" &&
          "toolCallId" in part &&
          typeof part.toolCallId === "string" &&
          part.toolCallId.startsWith(FORWARDING_TOOL_PREFIX);
        changed ||= gate;
        return !gate;
      });
      return { ...message, parts };
    });
    return changed ? JSON.stringify({ ...value, messages }) : body;
  } catch {
    return body;
  }
}
