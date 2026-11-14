import type { MCPClientManager } from "../mcp-client-manager/index.js";
import type { MCPAppsResourceReadOutcome } from "./types.js";

export async function readUiResources(
  manager: Pick<MCPClientManager, "readResource">,
  serverId: string,
  resourceUris: string[],
  uiTools: Array<{ name: string; resourceUri: string }>,
  listedUiResourceUris: Set<string>,
  signal?: AbortSignal
): Promise<MCPAppsResourceReadOutcome[]> {
  return Promise.all(
    resourceUris.map(async (uri) => {
      signal?.throwIfAborted();
      try {
        const result = await manager.readResource(
          serverId,
          { uri },
          { signal }
        );
        return {
          uri,
          referencedByTools: uiTools
            .filter((tool) => tool.resourceUri === uri)
            .map((tool) => tool.name),
          listed: listedUiResourceUris.has(uri),
          result,
        };
      } catch (error) {
        signal?.throwIfAborted();
        return {
          uri,
          referencedByTools: uiTools
            .filter((tool) => tool.resourceUri === uri)
            .map((tool) => tool.name),
          listed: listedUiResourceUris.has(uri),
          error,
        };
      }
    })
  );
}
