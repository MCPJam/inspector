import type { ModelMessage } from "@ai-sdk/provider-utils";

export interface SerializedModelRequestTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ResolvedModelRequestPayload {
  system: string;
  tools: Record<string, SerializedModelRequestTool>;
  messages: ModelMessage[];
}

/**
 * Fold host-executed built-in tools into a tool map the CLIENT assembled.
 *
 * Only for the Raw view's SYNTHESIZED request — the one it shows for a
 * reopened session, where no `request_payload` was ever streamed and the map
 * is built from currently-connected MCP servers. Built-ins are advertised by
 * the server from the host's config and so never appear in that map; without
 * this, a host whose whole capability is the browser renders `"tools": {}`
 * beside a conversation in which the model had just driven one.
 *
 * BUILT-INS LOSE A COLLISION HERE, which is the opposite of the server's rule
 * — and deliberately so. `prepareChatV2` merges built-ins LAST, dropping the
 * same-named MCP tool with a warning; the client cannot see that warning, and
 * a preview that quietly showed the built-in where the real request might
 * carry either would be asserting something it cannot know. Keeping the MCP
 * entry means the preview only ever differs from the request in a case the
 * server has already logged as a misconfiguration.
 *
 * Never applied to a live payload: that one carries the truth already.
 */
export function withBuiltInToolDefinitions(
  tools: Record<string, SerializedModelRequestTool>,
  builtIns: readonly SerializedModelRequestTool[] | undefined,
): Record<string, SerializedModelRequestTool> {
  if (!builtIns || builtIns.length === 0) return tools;
  return {
    ...Object.fromEntries(builtIns.map((tool) => [tool.name, tool])),
    ...tools,
  };
}
