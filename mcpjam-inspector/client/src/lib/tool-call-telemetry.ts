import { isToolUIPart, type UIMessage } from "ai";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { currentTelemetryActor } from "@/lib/telemetry-context";

export type ToolCallSource = "chat" | "tools_tab";

const FIRST_TOOL_CALL_KEY_PREFIX = "mcpjam-first-tool-call-completed";

// A streamed message is finished more than once when client tools continue
// the turn, so one call id can arrive several times.
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

/** One event per finished tool call in a streamed assistant message. */
export function trackChatToolCallsCompleted(message: UIMessage): void {
  // Runs inside the stream's finish handler; a malformed message must not
  // break the turn for the sake of analytics.
  if (!Array.isArray(message?.parts)) return;
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue;
    if (part.state !== "output-available" && part.state !== "output-error") {
      continue;
    }
    trackToolCallCompleted({
      source: "chat",
      toolCallId: part.toolCallId,
      isError:
        part.state === "output-error" ||
        (part.state === "output-available" && outputIsError(part.output)),
    });
  }
}
