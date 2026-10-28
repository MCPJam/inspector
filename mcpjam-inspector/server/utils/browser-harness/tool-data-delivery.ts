/**
 * Delivers a tool call's input and result to a mounted widget and reports what
 * happened to them, so a widget that cannot use its data is never counted as
 * rendered just because it painted.
 *
 * Apps notifications carry no acknowledgment. A result therefore counts as
 * rejected when it fails the schema the widget's Apps SDK parses
 * `ui/notifications/tool-result` with: an SDK widget drops such a notification
 * without a word, and its frame still paints. The result is sent anyway, as a
 * real host would send it, so the screenshot and console show the widget's own
 * reaction.
 *
 * Bundled into the harness page with host-page.ts and imported by the Node
 * harness, so it must stay free of Node-only and DOM-only imports.
 */
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";

export interface ToolDataDelivery {
  /**
   * What happened to the tool result. Absent when there was none to send, or
   * when the sends had not settled by the render deadline.
   */
  result?: "accepted" | "rejected" | "send_failed";
  /** One sentence per failed check or send, recorded as console errors. */
  problems: string[];
}

/**
 * The two AppBridge sends. Declared as methods so the bridge's narrower
 * parameter types still assign: a rejected result is sent unchanged.
 */
export interface ToolDataBridge {
  sendToolInput(params: { arguments: Record<string, unknown> }): Promise<void>;
  sendToolResult(params: unknown): Promise<void>;
}

const MAX_DETAIL_CHARS = 300;
/** Least time the sends get, so a handshake that used up the render budget
 *  still has its already-issued sends judged instead of timed out. */
const MIN_SETTLE_MS = 250;

/** Send the input, then the result. Never rejects: a failure is a problem. */
export async function deliverToolData(
  bridge: ToolDataBridge,
  data: { toolInput?: Record<string, unknown>; toolOutput?: unknown },
): Promise<ToolDataDelivery> {
  const problems: string[] = [];
  if (data.toolInput) {
    try {
      await bridge.sendToolInput({ arguments: data.toolInput });
    } catch (error) {
      problems.push(
        `The tool input could not be sent to the widget (${errorDetail(error)}).`,
      );
    }
  }
  if (data.toolOutput === undefined) return { problems };

  const parsed = mcpAppToolResultSchema.safeParse(data.toolOutput);
  let result: ToolDataDelivery["result"] = parsed.success
    ? "accepted"
    : "rejected";
  if (!parsed.success) {
    problems.push(
      `The widget rejected this tool result because it does not match the MCP Apps tool result format (${issueDetail(parsed.error.issues)}).`,
    );
  }
  try {
    await bridge.sendToolResult(data.toolOutput);
  } catch (error) {
    if (result === "accepted") result = "send_failed";
    problems.push(
      `The tool result could not be sent to the widget (${errorDetail(error)}).`,
    );
  }
  return { result, problems };
}

/** Wait for a delivery started at handshake time, within the render budget. */
export async function settleToolData(
  delivery: Promise<ToolDataDelivery>,
  remainingMs: number,
): Promise<ToolDataDelivery> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ToolDataDelivery>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          problems: [
            "The tool data was still being sent to the widget when the render timed out.",
          ],
        }),
      Math.max(remainingMs, MIN_SETTLE_MS),
    );
  });
  try {
    return await Promise.race([delivery, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Schema paths and expectations only: an issue never carries payload values. */
function issueDetail(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  const [first] = issues;
  if (!first) return "unknown schema issue";
  const path = first.path.map(String).join(".") || "result";
  const detail = `${path}: ${first.message.replace(/^Invalid input: /, "")}`;
  const more = issues.length > 1 ? ` and ${issues.length - 1} more` : "";
  return `${bounded(detail)}${more}`;
}

/** Reads `message` structurally: a send that fails inside the widget's frame
 *  throws an Error from that frame's realm, which `instanceof Error` misses. */
function errorDetail(error: unknown): string {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : String(error);
  return bounded(message);
}

function bounded(text: string): string {
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}…`
    : text;
}
