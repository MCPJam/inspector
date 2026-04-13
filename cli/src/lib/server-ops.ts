import type { MCPClientManager } from "@mcpjam/sdk";

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
) {
  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] =
    await Promise.all([
      manager.listTools(serverId),
      manager.listResources(serverId),
      manager.listPrompts(serverId),
      manager.listResourceTemplates(serverId).catch(() => ({
        resourceTemplates: [],
      })),
    ]);

  return {
    target,
    exportedAt: new Date().toISOString(),
    initInfo: manager.getInitializationInfo(serverId) ?? null,
    capabilities: manager.getServerCapabilities(serverId) ?? null,
    tools: (toolsResult.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
    toolsMetadata: manager.getAllToolsMetadata(serverId),
    resources: (resourcesResult.resources ?? []).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    })),
    resourceTemplates: (resourceTemplatesResult.resourceTemplates ?? []).map(
      (template) => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        description: template.description,
        mimeType: template.mimeType,
      }),
    ),
    prompts: (promptsResult.prompts ?? []).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  };
}

function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4);
}
