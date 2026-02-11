export interface ToolRenderOverride {
  serverId?: string;
  isOffline?: boolean;
  cachedWidgetHtmlUrl?: string;
  initialWidgetState?: unknown;
  resourceUri?: string;
  toolMetadata?: Record<string, unknown>;
}
