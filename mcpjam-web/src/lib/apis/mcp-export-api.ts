import type { MCPClientManager } from "@mcpjam/sdk/browser";

export async function exportServerApi(
  manager: MCPClientManager,
  serverId: string,
) {
  const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
    manager.listTools(serverId),
    manager.listResources(serverId),
    manager.listPrompts(serverId),
  ]);

  return {
    serverId,
    exportedAt: new Date().toISOString(),
    tools: toolsResult.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
    resources: resourcesResult.resources.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    })),
    prompts: promptsResult.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  };
}
