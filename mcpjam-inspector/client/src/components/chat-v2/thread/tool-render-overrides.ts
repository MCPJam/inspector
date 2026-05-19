import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";

export interface ToolRenderOverride {
  serverId?: string;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
  toolOutput?: unknown;
  initialWidgetState?: unknown;
  resourceUri?: string;
  toolMetadata?: Record<string, unknown>;
  widgetCsp?: McpUiResourceCsp | null;
  widgetPermissions?: McpUiResourcePermissions | null;
  widgetPermissive?: boolean;
  prefersBorder?: boolean;
  /**
   * Persisted compat-runtime flag for cached/offline replay — the
   * cached HTML blob was captured with this flag's value, and the
   * renderer uses it as the authoritative reload-key for the cached
   * branch (live host flag is ignored when HTML is frozen).
   */
  injectedOpenAiCompat?: boolean;
}
