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
};
