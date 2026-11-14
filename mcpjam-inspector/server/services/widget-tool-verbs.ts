import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { McpAppBrowserHarness } from "../utils/mcp-app-browser-harness.js";

export const WIDGET_TOOL_VERBS = ["widget_tools", "widget_call_tool"];

/** Fixed verbs let every engine discover a view rendered during its turn. */
export function buildWidgetToolVerbs(
  harness: () => McpAppBrowserHarness,
): ToolSet {
  return {
    widget_tools: Object.assign(
      tool({
        description:
          "List the tools exposed by the currently displayed MCP App. Use its viewId when calling a tool.",
        inputSchema: z.object({}),
        execute: async (_input, { abortSignal }) =>
          (await harness().viewTools.list(abortSignal)) ?? {
            viewId: null,
            tools: [],
          },
      }),
      { _toolOrigin: "builtin", needsApproval: false },
    ),
    widget_call_tool: Object.assign(
      tool({
        description:
          "Call a tool in the displayed MCP App using the viewId and tool name returned by widget_tools.",
        inputSchema: z.object({
          viewId: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()).default({}),
        }),
        execute: async (input, { abortSignal }) =>
          harness().viewTools.call(
            input.viewId,
            input.name,
            input.arguments,
            abortSignal,
          ),
      }),
      { _toolOrigin: "builtin", needsApproval: false },
    ),
  };
}
