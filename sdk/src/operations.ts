/**
 * Pure MCP operations and lifecycle helpers.
 *
 * Each operation is a thin wrapper around MCPClientManager methods that
 * normalizes inputs/outputs (default empty arrays, stringify prompt arguments,
 * etc.) without introducing any framework-specific dependencies.
 */

import { MCPClientManager } from "./mcp-client-manager/index.js";
import type {
  ListToolsResult,
  MCPPrompt,
  MCPResource,
  MCPResourceTemplate,
  MCPServerConfig,
  RpcLogger,
} from "./mcp-client-manager/index.js";
import { isMethodUnavailableError } from "./mcp-client-manager/index.js";

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

export interface ListAllToolsParams {
  serverId: string;
}

export interface ListAllToolsResult {
  tools: ListToolsResult["tools"];
  toolsMetadata: Record<string, unknown>;
}

export interface ListAllResourcesParams {
  serverId: string;
}

export interface ListAllResourcesResult {
  resources: MCPResource[];
}

export interface ListAllPromptsParams {
  serverId: string;
}

export interface ListAllPromptsResult {
  prompts: MCPPrompt[];
}

export interface ListAllResourceTemplatesParams {
  serverId: string;
}

export interface ListAllResourceTemplatesResult {
  resourceTemplates: MCPResourceTemplate[];
  unsupported?: boolean;
}

const MAX_PAGINATION_PAGES = 1000;

export interface WithEphemeralClientOptions {
  /** Override the serverId (default: "__ephemeral__") */
  serverId?: string;
  /** Client name reported to the MCP server (default: "mcpjam-sdk") */
  clientName?: string;
  /** Request timeout in ms (default: 30_000) */
  timeout?: number;
  /** Optional RPC logger for request/response tracing. */
  rpcLogger?: RpcLogger;
}

// ── Resources ───────────────────────────────────────────────────────

export async function listResources(
  manager: MCPClientManager,
  params: ListResourcesParams
) {
  const result = await manager.listResources(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined
  );
  return {
    resources: result.resources ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function readResource(
  manager: MCPClientManager,
  params: ReadResourceParams
) {
  const content = await manager.readResource(params.serverId, {
    uri: params.uri,
  });
  return { content };
}

// ── Prompts ─────────────────────────────────────────────────────────

export async function listPrompts(
  manager: MCPClientManager,
  params: ListPromptsParams
) {
  const result = await manager.listPrompts(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined
  );
  return {
    prompts: result.prompts ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function listPromptsMulti(
  manager: MCPClientManager,
  params: ListPromptsMultiParams
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
    })
  );

  const payload: Record<string, unknown> = { prompts: promptsByServer };
  if (Object.keys(errors).length > 0) {
    payload.errors = errors;
  }
  return payload;
}

export async function getPrompt(
  manager: MCPClientManager,
  params: GetPromptParams
) {
  const promptArguments = params.arguments
    ? Object.fromEntries(
        Object.entries(params.arguments).map(([key, value]) => [
          key,
          String(value),
        ])
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
  params: ListToolsParams
) {
  const result = await manager.listTools(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined
  );
  return {
    tools: result.tools ?? [],
    nextCursor: result.nextCursor,
  };
}

export async function listAllTools(
  manager: MCPClientManager,
  params: ListAllToolsParams
): Promise<ListAllToolsResult> {
  const tools = await drainPaginatedList<
    Awaited<ReturnType<typeof listTools>>["tools"][number],
    Awaited<ReturnType<typeof listTools>>
  >(
    async (cursor) => listTools(manager, { serverId: params.serverId, cursor }),
    "tools/list",
    (page) => page.tools ?? []
  );

  const toolsMetadata: Record<string, unknown> = {};
  for (const tool of tools) {
    const metadata = tool._meta;
    if (metadata !== undefined) {
      toolsMetadata[tool.name] = metadata;
    }
  }

  return { tools, toolsMetadata };
}

export async function listAllResources(
  manager: MCPClientManager,
  params: ListAllResourcesParams
): Promise<ListAllResourcesResult> {
  const resources = await drainPaginatedList<
    Awaited<ReturnType<typeof listResources>>["resources"][number],
    Awaited<ReturnType<typeof listResources>>
  >(
    async (cursor) =>
      listResources(manager, { serverId: params.serverId, cursor }),
    "resources/list",
    (page) => page.resources ?? []
  );

  return { resources };
}

export async function listAllPrompts(
  manager: MCPClientManager,
  params: ListAllPromptsParams
): Promise<ListAllPromptsResult> {
  const prompts = await drainPaginatedList<
    Awaited<ReturnType<typeof listPrompts>>["prompts"][number],
    Awaited<ReturnType<typeof listPrompts>>
  >(
    async (cursor) =>
      listPrompts(manager, { serverId: params.serverId, cursor }),
    "prompts/list",
    (page) => page.prompts ?? []
  );

  return { prompts };
}

export async function listAllResourceTemplates(
  manager: MCPClientManager,
  params: ListAllResourceTemplatesParams
): Promise<ListAllResourceTemplatesResult> {
  let unsupported = false;
  const resourceTemplates = await drainPaginatedList<
    MCPResourceTemplate,
    {
      resourceTemplates: MCPResourceTemplate[];
      nextCursor?: string;
    }
  >(
    async (cursor) => {
      let result;
      try {
        result = await manager.listResourceTemplates(
          params.serverId,
          cursor ? { cursor } : undefined
        );
      } catch (error) {
        if (
          isMethodUnavailableError(error, "resources/templates") ||
          isUnsupportedMethodError(error, "resources/templates")
        ) {
          unsupported = true;
          return {
            resourceTemplates: [] as MCPResourceTemplate[],
            nextCursor: undefined,
          };
        }
        throw error;
      }
      return {
        resourceTemplates: result.resourceTemplates ?? [],
        nextCursor: result.nextCursor,
      };
    },
    "resources/templates/list",
    (page) => page.resourceTemplates ?? []
  );

  return unsupported
    ? { resourceTemplates, unsupported: true }
    : { resourceTemplates };
}

// ── Lifecycle Helpers ───────────────────────────────────────────────

export async function withEphemeralClient<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: WithEphemeralClientOptions
): Promise<T> {
  const serverId = options?.serverId ?? "__ephemeral__";
  const manager = new MCPClientManager(
    {},
    {
      defaultTimeout: options?.timeout ?? 30_000,
      defaultClientName: options?.clientName ?? "mcpjam-sdk",
      lazyConnect: true,
      ...(options?.rpcLogger ? { rpcLogger: options.rpcLogger } : {}),
    }
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
  fn: (manager: MCPClientManager) => Promise<T>
): Promise<T> {
  const manager = await managerOrPromise;
  try {
    return await fn(manager);
  } finally {
    try {
      await manager.disconnectAllServers();
    } catch {
      // Best effort cleanup for the disposable manager lifecycle.
    }
  }
}

async function drainPaginatedList<TItem, TPage extends { nextCursor?: string }>(
  fetchPage: (cursor?: string) => Promise<TPage>,
  methodName: string,
  pickItems: (page: TPage) => TItem[]
): Promise<TItem[]> {
  const items: TItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pagesFetched = 0;

  for (;;) {
    pagesFetched += 1;
    if (pagesFetched > MAX_PAGINATION_PAGES) {
      throw new Error(
        `Exceeded ${MAX_PAGINATION_PAGES} pages while draining ${methodName}.`
      );
    }

    const page = await fetchPage(cursor);
    items.push(...pickItems(page));

    const nextCursor =
      typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (!nextCursor) {
      break;
    }

    if (seenCursors.has(nextCursor)) {
      throw new Error(
        `Detected repeated cursor "${nextCursor}" while draining ${methodName}.`
      );
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return items;
}

function isUnsupportedMethodError(error: unknown, method: string): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lower = message.toLowerCase();
  const normalizedMethod = method.toLowerCase();

  return (
    lower.includes(normalizedMethod) &&
    (lower.includes("not found") ||
      lower.includes("not implemented") ||
      lower.includes("unsupported") ||
      lower.includes("unavailable") ||
      lower.includes("does not support"))
  );
}
