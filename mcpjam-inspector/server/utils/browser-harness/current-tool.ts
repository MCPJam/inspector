import type { MCPClientManager } from "@mcpjam/sdk";

/** Find a declaration across pages, preserving opaque cursor semantics. */
export async function findCurrentTool(
  manager: Pick<MCPClientManager, "listTools">,
  serverId: string,
  toolName: string,
) {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const { tools, nextCursor } = await manager.listTools(
      serverId,
      cursor !== undefined ? { cursor } : undefined,
    );
    const match = tools.find((tool) => tool.name === toolName);
    if (match) return match;
    // Opaque tokens may be empty or repeat; the page budget bounds the lookup.
    if (typeof nextCursor !== "string") break;
    cursor = nextCursor;
  }
  return undefined;
}
