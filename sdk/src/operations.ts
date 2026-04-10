/**
 * Pure MCP operations and lifecycle helpers.
 *
 * Each operation is a thin wrapper around MCPClientManager methods that
 * normalizes inputs/outputs (default empty arrays, stringify prompt arguments,
 * etc.) without introducing any framework-specific dependencies.
 */

import { MCPClientManager } from "./mcp-client-manager/index.js";
import type { MCPServerConfig } from "./mcp-client-manager/index.js";

// ── Param types ─────────────────────────────────────────────────────

export interface ListResourcesParams {
  serverId: string;
  cursor?: string;
}

export interface ReadResourceParams {
  serverId: string;
  uri: string;
}

export interface ListPromptsParams {
  serverId: string;
  cursor?: string;
}

export interface ListPromptsMultiParams {
  serverIds: string[];
}

export interface GetPromptParams {
  serverId: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ListToolsParams {
  serverId: string;
  cursor?: string;
}

export interface WithEphemeralClientOptions {
  /** Override the serverId (default: "__ephemeral__") */
  serverId?: string;
  /** Client name reported to the MCP server (default: "mcpjam-sdk") */
  clientName?: string;
  /** Request timeout in ms (default: 30_000) */
  timeout?: number;
}

// ── Resources ───────────────────────────────────────────────────────

export async function listResources(
  manager: MCPClientManager,
  params: ListResourcesParams,
) {
  const result = await manager.listResources(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined,
  );
  return {
    resources: result.resources ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function readResource(
  manager: MCPClientManager,
  params: ReadResourceParams,
) {
  const content = await manager.readResource(params.serverId, {
    uri: params.uri,
  });
  return { content };
}

// ── Prompts ─────────────────────────────────────────────────────────

export async function listPrompts(
  manager: MCPClientManager,
  params: ListPromptsParams,
) {
  const result = await manager.listPrompts(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined,
  );
  return {
    prompts: result.prompts ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function listPromptsMulti(
  manager: MCPClientManager,
  params: ListPromptsMultiParams,
) {
  const promptsByServer: Record<string, unknown[]> = {};
  const errors: Record<string, string> = {};

  await Promise.all(
    params.serverIds.map(async (serverId) => {
      try {
        const { prompts } = await manager.listPrompts(serverId);
        promptsByServer[serverId] = prompts ?? [];
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors[serverId] = errorMessage;
        promptsByServer[serverId] = [];
      }
    }),
  );

  const payload: Record<string, unknown> = { prompts: promptsByServer };
  if (Object.keys(errors).length > 0) {
    payload.errors = errors;
  }
  return payload;
}

export async function getPrompt(
  manager: MCPClientManager,
  params: GetPromptParams,
) {
  const promptArguments = params.arguments
    ? Object.fromEntries(
        Object.entries(params.arguments).map(([key, value]) => [
          key,
          String(value),
        ]),
      )
    : undefined;

  const content = await manager.getPrompt(params.serverId, {
    name: params.name,
    arguments: promptArguments,
  });
  return { content };
}

// ── Tools ───────────────────────────────────────────────────────────

export async function listTools(
  manager: MCPClientManager,
  params: ListToolsParams,
) {
  const result = await manager.listTools(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined,
  );
  return {
    tools: result.tools ?? [],
    nextCursor: result.nextCursor,
  };
}

// ── Lifecycle Helpers ───────────────────────────────────────────────

export async function withEphemeralClient<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: WithEphemeralClientOptions,
): Promise<T> {
  const serverId = options?.serverId ?? "__ephemeral__";
  const manager = new MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 30_000,
      defaultClientName: options?.clientName ?? "mcpjam-sdk",
      lazyConnect: true,
    },
  );

  try {
    await manager.connectToServer(serverId, config);
    return await fn(manager, serverId);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
      // Best effort cleanup for the ephemeral connection lifecycle.
    }
  }
}

export async function withDisposableManager<T>(
  managerOrPromise: MCPClientManager | Promise<MCPClientManager>,
  fn: (manager: MCPClientManager) => Promise<T>,
): Promise<T> {
  const manager = await managerOrPromise;
  try {
    return await fn(manager);
  } finally {
    await manager.disconnectAllServers();
  }
}
