/**
 * Shared route handler functions for resources, prompts, and tools.
 *
 * Pure operations re-exported from @mcpjam/sdk, plus inspector-specific
 * listTools enrichment (toolsMetadata + tokenCount).
 *
 * Used by both web/ and mcp/ route sets.
 */

// Re-export pure operations from SDK — no behavioral changes
export {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
} from "@mcpjam/sdk";

import type { MCPClientManager } from "@mcpjam/sdk";
import { listTools as listToolsBase } from "@mcpjam/sdk";
import { countToolsTokens } from "./tokenizer-helpers.js";

type Manager = InstanceType<typeof MCPClientManager>;

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
