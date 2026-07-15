// The persistent widget-surface host (portal-based) relocated to
// @mcpjam/widget-react (Tier B Phase 3d-ii-c). Re-exported here so existing
// `./mcp-apps/widget-surface-host` import sites (thread.tsx, ui-playground) are
// unchanged. Wrap `<WidgetSurfaceHost>` in `<InspectorWidgetHostProvider>` so
// the relocated renderer can read the host (see ./use-widget-host.tsx).
export {
  WidgetSurfaceHost,
  WidgetSurfaceHostProvider,
} from "@mcpjam/widget-react";
