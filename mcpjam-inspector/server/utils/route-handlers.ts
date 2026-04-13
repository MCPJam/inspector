/**
 * Shared route handler functions for resources, prompts, and tools.
 *
 * Pure operations come from the SDK's dedicated operations entrypoint, while
 * inspector-specific listTools adds toolsMetadata and tokenCount.
 *
 * Used by both web/ and mcp/ route sets.
 */

import type { MCPClientManager } from "@mcpjam/sdk";
import {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
  listTools as listToolsBase,
} from "@mcpjam/sdk/operations";
import { countToolsTokens } from "./tokenizer-helpers.js";

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
  params: { serverId: string; modelId?: string; cursor?: string },
) {
  const result = await listToolsBase(manager, {
    serverId: params.serverId,
    cursor: params.cursor,
  });

  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);

  const tokenCount = params.modelId
    ? await countToolsTokens(result.tools, params.modelId)
    : undefined;

  return {
    ...result,
    toolsMetadata,
    tokenCount,
  };
}
