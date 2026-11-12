import type { MCPClientManager } from "@mcpjam/sdk";
import { getToolVisibility } from "@mcpjam/sdk/widget-runtime";

/** Find a declaration across pages, preserving opaque cursor semantics. */
export async function findCurrentTool(
  manager: Pick<MCPClientManager, "listTools">,
  serverId: string,
  toolName: string,
  options?: { cacheMode: "bypass" },
) {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const params = cursor !== undefined ? { cursor } : undefined;
    const { tools, nextCursor } = options
      ? await manager.listTools(serverId, params, options)
      : await manager.listTools(serverId, params);
    const match = tools.find((tool) => tool.name === toolName);
    if (match) return match;
    // Opaque tokens may be empty or repeat; the page budget bounds the lookup.
    if (typeof nextCursor !== "string") break;
    cursor = nextCursor;
  }
  return undefined;
}

/** App dispatch requires a fresh declaration, never an earlier metadata cache. */
export async function currentAppToolVisibility(
  manager: Pick<MCPClientManager, "listTools">,
  serverId: string,
  toolName: string,
) {
  const tool = await findCurrentTool(manager, serverId, toolName, { cacheMode: "bypass" });
  if (!tool) throw new Error(`Tool "${toolName}" is no longer available`);
  return getToolVisibility(tool._meta);
}
