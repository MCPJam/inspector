import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { readToolResultServerId } from "@/lib/tool-result-utils";
import { readMcpToolOriginServerId } from "@/shared/mcp-tool-origin-metadata";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { currentTelemetryActor } from "@/lib/telemetry-context";
import { isHarnessActivityToolName } from "@/components/chat-v2/thread/harness-tool-steps";

export type ToolCallSource = "chat" | "tools_tab";

const FIRST_TOOL_CALL_KEY_PREFIX = "mcpjam-first-tool-call-completed";

// A streamed message is finished more than once when client tools continue
// the turn, so one call id can arrive several times. Repeats come from the
// same turn, so only recent ids need remembering.
const MAX_REPORTED_TOOL_CALL_IDS = 500;
const reportedToolCallIds = new Set<string>();

/**
 * True for this browser's first completed tool call for the signed-in actor,
 * false after. Without storage there is no way to know, so it reports false
 * rather than claiming every call as the first.
 */
function claimFirstToolCall(): boolean {
  const key = `${FIRST_TOOL_CALL_KEY_PREFIX}:${currentTelemetryActor() ?? "anonymous"}`;
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    // Storage can be unavailable in sandboxed or privacy-restricted contexts.
    return false;
  }
}

export function trackToolCallCompleted({
  source,
  isError,
  toolCallId,
}: {
  source: ToolCallSource;
  isError: boolean;
  toolCallId?: string;
}): void {
  if (toolCallId !== undefined) {
    if (reportedToolCallIds.has(toolCallId)) return;
    reportedToolCallIds.add(toolCallId);
    if (reportedToolCallIds.size > MAX_REPORTED_TOOL_CALL_IDS) {
      // A Set iterates in insertion order, so the first id is the oldest.
      const oldest = reportedToolCallIds.values().next().value;
      if (oldest !== undefined) reportedToolCallIds.delete(oldest);
    }
  }
  track("tool_call_completed", {
    location: source,
    source,
    is_error: isError,
    first_for_user: claimFirstToolCall(),
    hosted: HOSTED_MODE,
  });
}

function outputIsError(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { isError?: unknown }).isError === true
  );
}

/**
 * Whether a chat tool call went to a connected MCP server, the same evidence
 * the tool card uses to pick its server. Harness built-ins such as `bash`
 * carry none of it, and the event measures calls to the user's server.
 */
function isMcpServerToolCall(
  part: ToolUIPart | DynamicToolUIPart,
  toolServerMap: ToolServerMap,
): boolean {
  const origin =
    readMcpToolOriginServerId(part.callProviderMetadata) ??
    (part.state === "output-available"
      ? readToolResultServerId(part.output)
      : undefined);
  if (origin) return true;
  // A connected server can expose a tool named like a built-in (`bash`), so
  // the name alone does not show which one ran.
  const toolName = getToolName(part);
  if (isHarnessActivityToolName(toolName)) return false;
  return Boolean(toolServerMap[toolName]);
}

/** One event per finished MCP server tool call in a streamed assistant message. */
export function trackChatToolCallsCompleted(
  message: UIMessage,
  toolServerMap: ToolServerMap,
): void {
  // Runs inside the stream's finish handler; a malformed message must not
  // break the turn for the sake of analytics.
  if (!Array.isArray(message?.parts)) return;
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    if (part.state !== "output-available" && part.state !== "output-error") {
      continue;
    }
    if (!isMcpServerToolCall(part, toolServerMap)) continue;
    trackToolCallCompleted({
      source: "chat",
      toolCallId: part.toolCallId,
      isError:
        part.state === "output-error" ||
        (part.state === "output-available" && outputIsError(part.output)),
    });
  }
}
