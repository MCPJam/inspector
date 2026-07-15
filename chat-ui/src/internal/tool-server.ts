import type { ToolServerMap } from "../types";

/**
 * Resolve the server id for a tool from a name→server map. Ported from the
 * inspector's `@/lib/apis/mcp-tools-api` (the read-only/trace paths only need
 * this lookup, not the full MCP tools API).
 */
export function getToolServerId(
  toolName: string,
  map: ToolServerMap,
): string | undefined {
  return map[toolName];
}
