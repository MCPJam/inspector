/**
 * Shared export logic used by both local (/api/mcp) and hosted (/api/web) routes.
 *
 * Pure function: (manager, serverId) → export payload.
 */

import type { MCPClientManager } from "@mcpjam/sdk";

type Manager = InstanceType<typeof MCPClientManager>;

export async function exportServer(manager: Manager, serverId: string) {
  const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
    manager.listTools(serverId),
    manager.listResources(serverId),
    manager.listPrompts(serverId),
  ]);

  const tools = toolsResult.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));

  const resources = resourcesResult.resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
  }));

  const prompts = promptsResult.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments,
  }));

  return {
    serverId,
    exportedAt: new Date().toISOString(),
    tools,
    resources,
    prompts,
  };
}
