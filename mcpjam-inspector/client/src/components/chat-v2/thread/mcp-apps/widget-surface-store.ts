// The persistent widget-surface zustand store relocated to @mcpjam/widget-react
// (Tier B Phase 3d-ii-c). Re-exported here so existing
// `./mcp-apps/widget-surface-store` import sites are unchanged.
export {
  useWidgetSurfaceStore,
  getRenderableSurfaceEntries,
  type WidgetSurfaceId,
  type WidgetSurfaceRecord,
} from "@mcpjam/widget-react";
