/**
 * Cross-layer constants for the MCPJam agent's built-in widget tools.
 *
 * The agent's `show_servers` built-in renders through the standard MCP Apps
 * pipeline, but its widget HTML is the platform widget bundle served by the
 * agent's own companion endpoint — not a Convex-registered server. The
 * client routes the HTML fetch on the synthetic server id below
 * (`fetch-widget-content.ts`); the server stamps the same id into the tool
 * result (`built-in-tools/mcpjam-show-servers.ts`). Keep them in this one
 * module so the two sides can't drift.
 */

/**
 * Synthetic server id carried as `_serverId` on widget-backed built-in tool
 * results. Not a Convex id — it exists only to route widget-content fetches
 * to the agent's companion endpoint.
 */
export const MCPJAM_PLATFORM_SERVER_ID = "mcpjam-platform";

/**
 * Resource URI of the show-servers view in the shared platform widget
 * bundle. Source of truth: `mcp/src/shared/platform-widgets.ts`
 * (`PLATFORM_WIDGET_RESOURCE_URIS.servers`) — a server-side test asserts
 * this literal stays in lockstep.
 */
export const SHOW_SERVERS_RESOURCE_URI = "ui://mcpjam/show-servers.html";

/** Companion endpoint that serves the platform widget bundle HTML. */
export const MCPJAM_AGENT_WIDGET_CONTENT_PATH =
  "/api/web/mcpjam-agent/widget-content";
