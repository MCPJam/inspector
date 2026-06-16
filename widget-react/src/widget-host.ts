// The `WidgetHost` dependency-inversion contract — OWNED by the package.
//
// Tier B Phase 3c lands the boundary, not the renderer: the package defines the
// React context + hook seam (`./widget-host-context`) over this contract, and
// the inspector supplies the concrete host through `<WidgetHostProvider>` using
// its existing `use-widget-host.ts` adapter. The interactive renderer cluster
// reads the host via `useWidgetHost()` once it relocates here in 3d.
//
// This shape is intentionally a SEED. 3d folds in the remaining slices from the
// inspector's in-place contract — `environment` (raw ambient inputs),
// `resolvers` (bound config/style fns), `services` (widget-content fetch + MCP
// transport), `debug?` (the 1:1 instrumentation sink), and `components?`
// (injected modal chrome) — as the code that needs them moves in. Keeping it
// minimal here is deliberate: 3c proves the package boundary is mechanically
// correct, not that it moves meaningful LOC.

/**
 * Which surface the widget is mounted on. Collapses the inspector's
 * `useIsChatboxSurface` / `useWidgetSurface` signals into one descriptor.
 */
export type WidgetSurfaceKind =
  | "chat"
  | "playground"
  | "chatbox"
  | "standalone";

/**
 * Per-surface identity + routing the renderer reads ambiently today. A subset
 * of the inspector's `WidgetSurfaceInfo`; 3d folds in the remaining fields
 * (`persistentSurfaceHost`, `playgroundCspMode`).
 */
export interface WidgetSurfaceInfo {
  kind: WidgetSurfaceKind;
  /** SANDBOX_ORIGIN (VITE_MCPJAM_SANDBOX_ORIGIN); "" when unset. */
  sandboxOrigin: string;
  /** useWebManagedServers — route widget-content through /api/web. */
  webManagedServers: boolean;
}

/**
 * The host the inspector injects and the widget runtime consumes. 3d expands
 * this with `environment`, `resolvers`, `services`, `debug?`, `components?`.
 */
export interface WidgetHost {
  surface: WidgetSurfaceInfo;
}
