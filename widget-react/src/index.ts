// @mcpjam/widget-react — interactive widget runtime (Tier B).
//
// Phase 3c public surface: the `WidgetHost` context/hook seam. The inspector
// imports these to wrap the widget subtree and feed its concrete host; the
// renderer cluster joins this barrel in 3d.

export {
  WidgetHostProvider,
  useWidgetHost,
  type WidgetHostProviderProps,
} from "./widget-host-context";
export type {
  WidgetHost,
  // primitives
  CspMode,
  DisplayMode,
  UiProtocol,
  OpenAiAppsCapabilities,
  // environment data types
  ThemeMode,
  ChatboxHostStyle,
  DeviceCapabilities,
  DeviceType,
  SafeAreaInsets,
  ProjectHostContextDraft,
  // resolved profile shapes
  ResolvedHostCapabilities,
  ResolvedHostInfo,
  ResolvedOpenAiAppsCapabilities,
  EffectiveCompatRuntime,
  ResolvedMcpAppsCapabilities,
  ResolvedHostStyle,
  // surface
  WidgetSurfaceInfo,
  WidgetSurfaceKind,
  // environment / resolvers / services
  WidgetHostEnvironment,
  WidgetHostEnvironmentInputs,
  WidgetHostResolvers,
  WidgetHostServices,
  FetchWidgetContentRequest,
  FetchWidgetContentResponse,
  ListResourcesResult,
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
} from "./widget-host";
