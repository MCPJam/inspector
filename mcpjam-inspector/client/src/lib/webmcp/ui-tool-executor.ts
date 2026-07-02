/**
 * Client-side fulfillment for WebMCP UI tool calls streamed back by the
 * server (which registered them as no-execute AI SDK tools).
 *
 * Called first from each chat surface's `useChat.onToolCall`; returns `false`
 * for names that aren't ours so the app-tool and server-tool paths run
 * unchanged. Dispatch is gated on registry membership / the per-session
 * shipped-name set — never the `ui_` prefix alone — so a genuine server tool
 * named `ui_something` falls through untouched.
 */

import { useUiToolsRegistry, type UiToolResult } from "./ui-tools-registry";

export interface HandleUiToolCallOptions {
  toolName: string;
  toolCallId: string;
  input: unknown;
  addToolOutput: (output: {
    tool: string;
    toolCallId: string;
    output: UiToolResult;
  }) => void;
  /**
   * Fired BEFORE `execute` when the resolved tool is flagged `mayNavigate` —
   * the seam where a route-bound surface hands the conversation off to the
   * side panel before the route commits. Best-effort: a throwing callback
   * must never block the tool output (the stream would hang).
   */
  onNavigationToolCall?: (toolName: string) => void;
}

/**
 * Returns `true` when the call was ours and an output was supplied (success
 * or error), `false` when the name doesn't belong to the UI tool layer and
 * the caller should fall through to its other handlers.
 */
export async function handleUiToolCall(
  opts: HandleUiToolCallOptions,
): Promise<boolean> {
  const { toolName, toolCallId, input, addToolOutput } = opts;
  const registry = useUiToolsRegistry.getState();
  const def = registry.resolve(toolName);

  if (!def) {
    // The name was advertised to the server in an earlier snapshot but the
    // tool is gone (HMR teardown, unmount). An output MUST still be
    // supplied or the paused server stream waits forever — same rule as
    // closed app iframes in the app-tool path.
    if (registry.wasShipped(toolName)) {
      addToolOutput({
        tool: toolName,
        toolCallId,
        output: {
          content: [
            {
              type: "text",
              text: `UI tool "${toolName}" is no longer available.`,
            },
          ],
          isError: true,
        },
      });
      return true;
    }
    return false;
  }

  if (def.mayNavigate) {
    try {
      opts.onNavigationToolCall?.(toolName);
    } catch {
      // Handoff is best-effort; the tool output must still be delivered.
    }
  }

  let output: UiToolResult;
  try {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    output = await def.execute(args);
  } catch (error) {
    output = {
      content: [
        {
          type: "text",
          text: `UI tool failed: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        },
      ],
      isError: true,
    };
  }
  addToolOutput({ tool: toolName, toolCallId, output });
  return true;
}
