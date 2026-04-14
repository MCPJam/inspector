import {
  collectConnectedServerSnapshot,
  serializeServerSnapshot,
  type MCPClientManager,
} from "@mcpjam/sdk";

type Manager = MCPClientManager;

export async function listToolsWithMetadata(
  manager: Manager,
  params: { serverId: string; modelId?: string; cursor?: string },
) {
  const result = await manager.listTools(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined,
  );
  const tools = result.tools ?? [];
  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);
  const tokenCount = params.modelId
    ? estimateTokensFromChars(JSON.stringify(tools))
    : undefined;

  return {
    tools,
    nextCursor: result.nextCursor,
    toolsMetadata,
    ...(tokenCount === undefined ? {} : { tokenCount }),
  };
}

export async function exportServerSnapshot(
  manager: Manager,
  serverId: string,
  target: string,
  options: { mode?: "raw" | "stable" } = {},
) {
  const snapshot = await collectConnectedServerSnapshot(
    manager,
    serverId,
    target,
  );
  return serializeServerSnapshot(snapshot, options);
}

function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}
