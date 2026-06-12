/**
 * Widget-backed `show_servers` built-in — the MCP Apps surface of the
 * platform catalog's `showServersOperation`, for chat surfaces that can
 * render widgets but aren't connected to the MCPJam platform MCP worker.
 *
 * `show_servers` is deliberately NOT in `WORKSPACE_OPERATIONS` (mcpjam.ts):
 * it exists to render, so it's only advertised where the renderer can fetch
 * the platform widget bundle — today the MCPJam agent, whose companion
 * endpoint (`/api/web/mcpjam-agent/widget-content`) serves the bundle HTML.
 * Execution is the same self-dispatching `PlatformApiClient` as every other
 * workspace tool, so authority is the caller's bearer either way.
 *
 * The result is `CallToolResult`-shaped on purpose — the client then treats
 * it exactly like an MCP server widget tool, with zero frontend plumbing:
 *   - `_meta.ui.resourceUri` (+ the legacy `ui/resourceUri` key) make
 *     `detectUIType` classify the part as MCP_APPS from the streamed result
 *     alone (`part-switch.tsx` falls back to `readToolResultMeta(rawOutput)`
 *     when the surface passes no `toolsMetadata`).
 *   - `_serverId` routes the widget HTML fetch: `widget-replay.tsx` reads it
 *     via `readToolResultServerId`, and `fetch-widget-content.ts` sends the
 *     synthetic id to the agent's companion endpoint instead of the
 *     Convex-registered-server path.
 *   - `structuredContent` carries the payload tagged `widget: "servers"` —
 *     the discriminator the shared bundle's root routes views on
 *     (`mcp/src/shared/platform-widgets.ts`); a test keeps the literal in
 *     lockstep.
 */
import { tool, type ToolSet } from "ai";
import { RESOURCE_URI_META_KEY } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  showServersOperation,
  type PlatformApiClient,
  type ShowServersPayload,
} from "@mcpjam/sdk/platform";
import {
  MCPJAM_PLATFORM_SERVER_ID,
  SHOW_SERVERS_RESOURCE_URI,
} from "../../../shared/mcpjam-agent-widgets";
import { AMBIENT_PROJECT_NOTE } from "./mcpjam.js";

export const SHOW_SERVERS_TOOL_NAME = showServersOperation.name;

export interface ShowServersWidgetToolOptions {
  /** Platform API client bound to the caller's bearer (self-dispatching). */
  client: PlatformApiClient;
  /** The chat's ambient project — the default when `project` is omitted. */
  projectId: string;
  /**
   * Host's approval policy. The payload builder runs the hosted doctor
   * against each saved server (it opens connections), so this tool inherits
   * approval like the CONNECTION_OPENING workspace ops do.
   */
  requireToolApproval?: boolean;
}

/**
 * `_meta` for the streamed result: modern `ui.resourceUri` plus the legacy
 * flat key — the same pair the worker's session registrar advertises
 * (`mcp/src/tools/sessionToolRegistrar.ts` `createToolUiMeta`).
 */
const SHOW_SERVERS_TOOL_META: Record<string, unknown> = {
  ui: { resourceUri: SHOW_SERVERS_RESOURCE_URI },
  [RESOURCE_URI_META_KEY]: SHOW_SERVERS_RESOURCE_URI,
};

function summarize(payload: ShowServersPayload): string {
  const total = payload.servers.length;
  const reachable = payload.servers.filter(
    (server) => server.status === "reachable"
  ).length;
  return (
    `Rendered an interactive view of ${total} server${
      total === 1 ? "" : "s"
    } ` +
    `(${reachable} reachable) in project "${payload.project.name}". ` +
    `The user can see the full details in the widget.`
  );
}

export function buildShowServersWidgetTool(
  opts: ShowServersWidgetToolOptions
): ToolSet[string] {
  return tool({
    description: `${showServersOperation.description}${AMBIENT_PROJECT_NOTE}`,
    inputSchema: showServersOperation.inputSchema,
    needsApproval: opts.requireToolApproval === true,
    execute: async (input: Record<string, unknown>, { abortSignal }) => {
      if (abortSignal?.aborted) {
        return { error: `${showServersOperation.title} was cancelled.` };
      }
      const trimmedProject =
        typeof input.project === "string" ? input.project.trim() : "";
      const project = trimmedProject || opts.projectId;
      try {
        const payload = await showServersOperation.execute(
          { ...input, project },
          { client: opts.client, signal: abortSignal }
        );
        return {
          content: [{ type: "text", text: summarize(payload) }],
          // `widget` is the view discriminator the shared bundle routes on —
          // mirrors `tagPlatformWidgetPayload("servers", …)` in
          // mcp/src/shared/platform-widgets.ts.
          structuredContent: { ...payload, widget: "servers" },
          _meta: SHOW_SERVERS_TOOL_META,
          _serverId: MCPJAM_PLATFORM_SERVER_ID,
        };
      } catch (error) {
        if (abortSignal?.aborted) {
          return { error: `${showServersOperation.title} was cancelled.` };
        }
        const message =
          error instanceof Error && error.message.trim() ? error.message : "";
        return {
          error: message || `${showServersOperation.title} failed.`,
        };
      }
    },
  });
}
