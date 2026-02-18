/**
 * Shared route handler functions for resources, prompts, and tools.
 *
 * Pure functions: (manager, params) → result.
 * No Hono context, no c.json(), no error formatting.
 *
 * Used by both web/ and mcp/ route sets, following the prepareChatV2() pattern.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import { countToolsTokens } from "./tokenizer-helpers.js";

type Manager = InstanceType<typeof MCPClientManager>;

// ── Resources ────────────────────────────────────────────────────────

export async function listResources(
  manager: Manager,
  params: { serverId: string; cursor?: string },
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
  manager: Manager,
  params: { serverId: string; uri: string },
) {
  const content = await manager.readResource(params.serverId, {
    uri: params.uri,
  });
  return { content };
}

// ── Prompts ──────────────────────────────────────────────────────────

export async function listPrompts(
  manager: Manager,
  params: { serverId: string; cursor?: string },
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
  manager: Manager,
  params: { serverIds: string[] },
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
  manager: Manager,
  params: {
    serverId: string;
    name: string;
    arguments?: Record<string, unknown>;
  },
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

// ── Tools ────────────────────────────────────────────────────────────

export async function listTools(
  manager: Manager,
  params: { serverId: string; modelId?: string; cursor?: string },
) {
  const result = await manager.listTools(
    params.serverId,
    params.cursor ? { cursor: params.cursor } : undefined,
  );

  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);

  const tokenCount = params.modelId
    ? await countToolsTokens(result.tools, params.modelId)
    : undefined;

  return {
    ...result,
    toolsMetadata,
    tokenCount,
    nextCursor: result.nextCursor,
  };
}
