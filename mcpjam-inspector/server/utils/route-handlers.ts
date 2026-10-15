/**
 * Shared route handler functions for resources, prompts, and tools.
 *
 * Pure operations come from the SDK's dedicated operations entrypoint, while
 * inspector-specific listTools adds toolsMetadata and tokenCount.
 *
 * Used by both web/ and mcp/ route sets.
 */

import type { CacheMode, MCPClientManager } from "@mcpjam/sdk";
import {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
  listTools as listToolsBase,
} from "@mcpjam/sdk/operations";
import {
  countToolsTokens,
  mapModelIdToTokenizerBackend,
} from "./tokenizer-helpers.js";

type Manager = InstanceType<typeof MCPClientManager>;

export {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
};

/**
 * Inspector-enriched listTools: adds toolsMetadata and optional tokenCount
 * on top of the SDK's pure listTools.
 */
export async function listTools(
  manager: Manager,
  params: {
    serverId: string;
    modelId?: string;
    cursor?: string;
    cacheMode?: CacheMode;
  },
) {
  const result = await listToolsBase(manager, {
    serverId: params.serverId,
    cursor: params.cursor,
    cacheMode: params.cacheMode,
  });

  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);

  const tokenizerModel = params.modelId
    ? mapModelIdToTokenizerBackend(params.modelId)
    : undefined;
  const tokenCountError =
    params.modelId && tokenizerModel === null
      ? "Could not pre-calculate tool description tokens for this model."
      : undefined;
  const tokenCount =
    params.modelId && !tokenCountError
      ? await countToolsTokens(result.tools, params.modelId)
      : undefined;

  return {
    ...result,
    toolsMetadata,
    tokenCount,
    tokenCountError,
  };
}

/**
 * `listTools` for a server set in one request. The hosted passthrough limiter
 * counts requests per session token, so a client listing every server one by
 * one met it on large workspaces (PLB-158). Each entry is what the
 * single-server call returns. A server that fails does not fail the batch:
 * its throw is handed back in `failures`, as thrown, for the route to answer
 * the way it answers a single-server failure.
 */
export async function listToolsMulti(
  manager: Manager,
  params: {
    serverIds: string[];
    modelId?: string;
    cacheMode?: CacheMode;
  },
) {
  const results: Record<string, Awaited<ReturnType<typeof listTools>>> = {};
  const failures: Record<string, unknown> = {};

  await Promise.all(
    params.serverIds.map(async (serverId) => {
      try {
        results[serverId] = await listTools(manager, {
          serverId,
          modelId: params.modelId,
          cacheMode: params.cacheMode,
        });
      } catch (error) {
        failures[serverId] = error;
      }
    }),
  );

  return Object.keys(failures).length > 0 ? { results, failures } : { results };
}
