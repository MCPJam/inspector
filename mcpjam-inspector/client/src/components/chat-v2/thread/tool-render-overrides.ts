import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export interface ToolRenderOverride {
  serverId?: string;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
  /**
   * Try the live MCP Apps fetch path before falling back to
   * `cachedWidgetHtmlUrl`. Used by in-flow session revisit so the widget
   * re-renders against the active host's current CSP / bridge state when the
   * server is still reachable, while still surviving server disconnect by
   * falling back to the cached snapshot HTML.
   *
   * When unset (the default), the cached path is taken whenever
   * `cachedWidgetHtmlUrl` is present — matching the original offline-replay
   * semantics used by the Views tab and persisted eval traces.
   */
  liveFetchPreferred?: boolean;
  toolOutput?: unknown;
  initialWidgetState?: unknown;
  resourceUri?: string;
  toolMetadata?: Record<string, unknown>;
  widgetCsp?: McpUiResourceCsp | null;
  widgetPermissions?: McpUiResourcePermissions | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
}
