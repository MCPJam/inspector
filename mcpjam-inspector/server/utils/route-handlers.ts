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

const TIMINGS = process.env.MCPJAM_LOCAL_CHATBOX_TIMINGS === "1";

/**
 * Inspector-enriched listTools: adds toolsMetadata and optional tokenCount
 * on top of the SDK's pure listTools.
 */
export async function listTools(
  manager: Manager,
  params: { serverId: string; modelId?: string; cursor?: string },
) {
  const t0 = TIMINGS ? Date.now() : 0;

  const result = await listToolsBase(manager, {
    serverId: params.serverId,
    cursor: params.cursor,
  });

  const toolsMetadata = manager.getAllToolsMetadata(params.serverId);

  const t1 = TIMINGS ? Date.now() : 0;
  const tokenCount = params.modelId
    ? await countToolsTokens(result.tools, params.modelId)
    : undefined;
  const t2 = TIMINGS ? Date.now() : 0;

  if (TIMINGS) {
    console.log(
      `[chatbox-timings] tools/list serverId=${params.serverId} hasModelId=${!!params.modelId} toolCount=${result.tools.length} tokenCountMs=${t2 - t1} totalMs=${t2 - t0}`,
    );
  }

  return {
    ...result,
    toolsMetadata,
    tokenCount,
  };
}
