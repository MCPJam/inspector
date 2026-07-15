// The interactive MCP-Apps / OpenAI-Apps widget renderer relocated to
// @mcpjam/widget-react (Tier B Phase 3d-ii-c). Re-exported here so existing
// `./mcp-apps/mcp-apps-renderer` import sites (widget-replay + the persistent
// surface host) are unchanged. The renderer reads its host through the package
// `useWidgetHost()` context — mount it under `<InspectorWidgetHostProvider>`
// (see ./use-widget-host.tsx).
export {
  MCPAppsRenderer,
  MCPAppsRendererSurface,
  type MCPAppsRendererProps,
} from "@mcpjam/widget-react";
