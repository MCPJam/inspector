import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config";

export type ExecutionConfig = {
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  /**
   * Host-level opt-in for progressive MCP tool discovery
   * (`search_mcp_tools` / `load_mcp_tools`). Mirrors
   * `useChatSession.options.progressiveToolDiscovery` but flows through
   * `ExecutionConfig` so multi-model chat / playground surfaces can
   * forward the host's `HostConfigV2.progressiveToolDiscovery` field
   * without adding a parallel top-level option. `undefined` ⇒ backend
   * auto policy.
   */
  progressiveToolDiscovery?: boolean;
  /** See HostConfigInputV2.respectToolVisibility. */
  respectToolVisibility?: boolean;
  /** Host-level policy for MCP tool-result content/resource model visibility. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /** Host-level human-facing MCP tool-result image rendering mode. */
  mcpToolResultImageRendering?: "none" | "panel" | "inline";
  /**
   * Catalog ids of host-managed built-in tools (e.g. ["web_search"]). Sourced
   * from HostConfigV2.builtInToolIds. Forwarded into the chat-v2 POST body so
   * the server can resolve them into AI SDK tools via the built-in registry.
   * `undefined` / `[]` ⇒ no built-ins attached.
   */
  builtInToolIds?: string[];
};
