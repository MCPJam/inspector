/**
 * Cross-layer constants for the MCPJam agent's platform MCP server
 * connection.
 *
 * The agent connects to the MCPJam platform MCP worker (mcp.mcpjam.com)
 * under the synthetic id below. The standard hosted widget pipeline resolves
 * widget HTML by Convex-registered server id, which this server doesn't
 * have — so the client routes widget-content fetches for this id to the
 * agent's companion endpoint, which `resources/read`s the `ui://` resource
 * over an ephemeral authed connection to the worker. The id reaches the
 * client as `_serverId` on streamed tool results (stamped by the chat
 * engine for every MCP server). Keep both sides on this one module so they
 * can't drift.
 */

/**
 * Manager key for the platform MCP server in the agent route — and
 * therefore the `_serverId` the client sees on its tool results. Not a
 * Convex id.
 */
export const MCPJAM_PLATFORM_SERVER_ID = "mcpjam-platform";

/** Companion endpoint that reads `ui://` widget resources from the worker. */
export const MCPJAM_AGENT_WIDGET_CONTENT_PATH =
  "/api/web/mcpjam-agent/widget-content";
