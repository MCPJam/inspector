// Tier B — `WidgetHost` contract re-export shim.
//
// As of Phase 3d-i, the ENTIRE `WidgetHost` dependency-inversion contract lives
// in `@mcpjam/widget-react`. This module is a pure compatibility shim: it
// re-exports the contract types so existing `./widget-host` import sites (the
// renderer cluster + the `use-widget-host.ts` adapter) are unchanged, and keeps
// the two inspector-sourced VALUE re-exports the renderer still calls
// (`extractMethod`, `stableStringifyJson`) until they relocate with the renderer
// in 3d-ii.
//
// There is no local contract here anymore — `use-widget-host.ts` builds the host
// from the inspector's stores/resolvers and returns it typed as the package
// contract, so any source-shape drift fails typecheck there.
//
// See ./widget-host.design.md for the phased plan.

export type {
  // the seam
  WidgetHost,
  // environment / resolvers / services
  WidgetHostEnvironment,
  WidgetHostEnvironmentInputs,
  WidgetHostResolvers,
  WidgetHostServices,
  FetchWidgetContentRequest,
  FetchWidgetContentResponse,
  ListResourcesResult,
  // resolved profile shapes
  ResolvedHostCapabilities,
  ResolvedHostInfo,
  ResolvedHostStyle,
  ResolvedMcpAppsCapabilities,
  ResolvedOpenAiAppsCapabilities,
  EffectiveCompatRuntime,
  // environment data types
  ThemeMode,
  ChatboxHostStyle,
  DeviceCapabilities,
  DeviceType,
  SafeAreaInsets,
  ProjectHostContextDraft,
  // primitives
  CspMode,
  DisplayMode,
  UiProtocol,
  OpenAiAppsCapabilities,
  // surface
  WidgetSurfaceInfo,
  WidgetSurfaceKind,
  // instrumentation
  WidgetDebugSink,
  WidgetDebugInfo,
  WidgetGlobals,
  WidgetSandboxInfo,
  WidgetSandboxApplied,
  WidgetLifecycleEvent,
  WidgetMount,
  CspViolation,
  UiLogEvent,
  // chrome injection
  WidgetModalProps,
  WidgetHostComponents,
} from "@mcpjam/widget-react";

// `extractMethod` is a pure JSON-RPC message parser the renderer uses for
// traffic-log wiring; re-exported through the boundary so the renderer's call
// sites stay verbatim while it imports zero `@/stores/*` (Tier-B guard). It
// relocates with the traffic-log utilities in 3d-ii.
export { extractMethod } from "@/stores/traffic-log-store";

// `stableStringifyJson` is read off `host.resolvers`, but `mcp-apps-renderer.tsx`
// also calls it from MODULE scope (`getPersistentSurfaceId`) where no host
// instance exists. Re-export the pure canonicalizer so that call site imports it
// from the boundary instead of `@/lib/client-config` (Tier-B guard). Same fn as
// `resolvers.stableStringifyJson`. Relocates in 3d-ii.
export { stableStringifyJson } from "@/lib/client-config";
