// The `WidgetHost` dependency-inversion contract — OWNED by the package.
//
// The package defines the React context + hook seam (`./widget-host-context`)
// over this contract; the inspector supplies the concrete host through
// `<WidgetHostProvider>` using its `use-widget-host.ts` adapter. The interactive
// renderer reads the host via `useWidgetHost()` once it relocates here (3d-ii).
//
// These types are STRUCTURAL replicas of the inspector shapes (the profile/store
// systems stay in the inspector by design, so the package can't import them).
// Drift-safety is enforced by the inspector's `use-widget-host.ts` adapter:
// it builds the host from the real stores/resolvers and returns it typed as this
// contract, so any source-shape drift fails typecheck there.
//
// Fold-in status: 3c seeded `surface`. 3d-i-a adds `surface` (completed),
// `debug`, and `components`. 3d-i-b folds in `environment`, `resolvers`, and
// `services` (the fn-heavy + profile-derived slices).

import type { ComponentType, ReactNode } from "react";
import type {
  McpUiHostCapabilities,
  McpUiHostContext,
  McpUiResourceCsp,
  McpUiResourcePermissions,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  MCPPrompt,
  MCPResourceTemplate,
  SandboxCspPolicy,
  SandboxPermissionsPolicy,
} from "@mcpjam/sdk/browser";

// --- Primitives --------------------------------------------------------------

/** Sandbox CSP-mode selection. Mirrors the inspector ui-playground-store. */
export type CspMode = "permissive" | "widget-declared";

/** Widget display-mode union (SEP HostDisplayMode). */
export type DisplayMode = "inline" | "pip" | "fullscreen";

/** JSON-RPC protocol tag for traffic logging. */
export type UiProtocol = "mcp-apps" | "openai-apps";

/**
 * OpenAI Apps compat capability flags (the `window.openai.*` surface to inject).
 * Structural mirror of the inspector's `InjectedOpenAiCompatCapabilities`.
 */
export interface OpenAiAppsCapabilities {
  callTool?: boolean;
  sendFollowUpMessage?: boolean;
  setWidgetState?: boolean;
  requestDisplayMode?: "all" | "fullscreen-only" | "none";
  notifyIntrinsicHeight?: boolean;
  openExternal?: boolean;
  setOpenInAppUrl?: boolean;
  requestModal?: boolean;
  uploadFile?: boolean;
  selectFiles?: boolean;
  getFileDownloadUrl?: boolean;
  requestCheckout?: boolean;
  requestClose?: boolean;
}

// --- Environment data types --------------------------------------------------

/** usePreferencesStore theme mode. */
export type ThemeMode = "light" | "dark";

/** Host-style id (the inspector's `ChatboxHostStyle`). */
export type ChatboxHostStyle = string;

export interface DeviceCapabilities {
  hover: boolean;
  touch: boolean;
}

export type DeviceType = "fill" | "mobile" | "tablet" | "desktop" | "custom";

export interface SafeAreaInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** useHostContextStore draftHostContext. */
export type ProjectHostContextDraft = Record<string, unknown>;

// --- Resolved profile shapes -------------------------------------------------
//
// The profile system (client-config-v2 / client-styles) stays in the inspector;
// these are the structural shapes its resolvers PRODUCE, typed to what the
// renderer reads. The adapter assigns the real resolver results, which are
// assignable to these (drift caught there).

/** resolveEffectiveHostCapabilities — vendor-trait host caps (sandbox composed separately). */
export type ResolvedHostCapabilities = Omit<McpUiHostCapabilities, "sandbox">;

/** resolveHostInfo. */
export type ResolvedHostInfo = Record<string, unknown> | undefined;

/** Required form of the OpenAI Apps compat surface. */
export type ResolvedOpenAiAppsCapabilities = Required<OpenAiAppsCapabilities>;

/** resolveEffectiveCompatRuntime result. */
export type EffectiveCompatRuntime =
  | { injected: false }
  | { injected: true; capabilities: ResolvedOpenAiAppsCapabilities };

/** resolveEffectiveMcpAppsCapabilities — the resolved MCP-Apps capability matrix. */
export type ResolvedMcpAppsCapabilities = {
  availableDisplayModes: ("inline" | "fullscreen" | "pip")[];
  toolInputPartial: boolean;
  toolCancelled: boolean;
  hostContextChanged: boolean;
  resourceTeardown: boolean;
  toolInfo: boolean;
  openLinks: boolean;
  serverTools: boolean;
  serverResources: boolean;
  logging: boolean;
  updateModelContext: boolean;
  message: boolean;
  sandboxPermissions: boolean;
  cspFrameDomains: boolean;
  cspBaseUriDomains: boolean;
  resourcePrefersBorder: boolean;
  downloadFile: boolean;
  requestTeardown: boolean;
  widgetDisplayModeRequests: "accept" | "user-initiated-only" | "decline";
};

/**
 * getHostStyleOrDefault / DEFAULT_HOST_STYLE result — typed to the renderer's
 * AUDITED reads only: `.mcp.{resolveStyleVariables,fontCss,platform}` and
 * `.chatUi.resolveChatBackground` (+ `.id`). The real `HostStyleDefinition` has
 * more (the full profile/chat-ui graph); the adapter assigns it (assignable to
 * this minimal surface), so the package never replicates that graph.
 */
export interface ResolvedHostStyle {
  id: string;
  mcp: {
    resolveStyleVariables: (theme: "light" | "dark") => McpUiStyles;
    fontCss: string;
    platform: "web" | "desktop" | "mobile";
  };
  chatUi: {
    resolveChatBackground: (theme: "light" | "dark") => string;
  };
}

// --- Surface -----------------------------------------------------------------

/**
 * Which surface the widget is mounted on. Collapses the inspector's
 * `useIsChatboxSurface` / `useWidgetSurface` signals into one descriptor.
 */
export type WidgetSurfaceKind =
  | "chat"
  | "playground"
  | "chatbox"
  | "standalone";

/** Per-surface identity + routing the renderer reads ambiently. */
export interface WidgetSurfaceInfo {
  kind: WidgetSurfaceKind;
  /** usePersistentWidgetSurfaceHost — persistent resource-scoped surfaces. */
  persistentSurfaceHost: boolean;
  /** useWebManagedServers — route widget-content through /api/web. */
  webManagedServers: boolean;
  /**
   * HOSTED_MODE (the inspector's `@/lib/config` flag): the app runs against
   * the hosted backend (web-managed servers, no local file APIs). The renderer
   * + sandboxed iframe read this to pick hosted vs. local proxy/file paths and
   * to gate upload/download/resource-template features.
   */
  hostedMode: boolean;
  /** SANDBOX_ORIGIN (VITE_MCPJAM_SANDBOX_ORIGIN); "" when unset. */
  sandboxOrigin: string;
  /**
   * Playground CSP-mode selection (useUIPlaygroundStore.mcpAppsCspMode) — an
   * INPUT, not the effective mode. The renderer derives the effective sandbox
   * CSP mode from `kind` + this + the per-widget `minimalMode` prop (kept as an
   * input because `minimalMode` is per-instance).
   */
  playgroundCspMode: CspMode;
}

// --- Instrumentation ---------------------------------------------------------
//
// The debug sink is intentionally 1:1 with the inspector's widget-debug-store +
// traffic-log addLog. A non-inspector host can omit `debug` entirely and lose
// only the Sandbox/Network debug panels.

export interface WidgetMount {
  index: number;
  reason: string;
  at: number;
}

export interface CspViolation {
  directive: string;
  effectiveDirective?: string;
  blockedUri: string;
  sourceFile?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
  timestamp: number;
}

export interface WidgetLifecycleEvent {
  kind:
    | "sandbox-proxy-ready"
    | "widget-content-requested"
    | "widget-content-ready"
    | "widget-content-error"
    | "widget-content-invalid-mimetype"
    | "bridge-connect-start"
    | "bridge-connect-ready"
    | "bridge-connect-error"
    | "bridge-connect-skipped"
    | "app-initialized";
  status: "ok" | "error" | "pending";
  message?: string;
  timestamp: number;
}

export interface WidgetSandboxApplied {
  sandboxAttrs?: string[];
  allowFeatures?: Record<string, string>;
  cspDirectives?: Record<string, string[]>;
  permissive: boolean;
  hostPolicyApplied: boolean;
  restrictTo?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  cspMode?: "host-default" | "declared" | "relaxed";
  permissions?: {
    camera?: {};
    microphone?: {};
    geolocation?: {};
    clipboardWrite?: {};
  };
}

export interface WidgetSandboxInfo {
  mode: CspMode;
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
  permissions?: {
    camera?: {};
    microphone?: {};
    geolocation?: {};
    clipboardWrite?: {};
  };
  headerString?: string;
  violations: CspViolation[];
  widgetDeclared?: {
    connect_domains?: string[];
    resource_domains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  } | null;
}

export interface WidgetGlobals {
  theme: "light" | "dark";
  displayMode: "inline" | "pip" | "fullscreen";
  maxHeight?: number;
  maxWidth?: number;
  locale?: string;
  safeArea?: {
    insets: { top: number; bottom: number; left: number; right: number };
  };
  timeZone?: string;
  deviceCapabilities?: { hover: boolean; touch: boolean };
  safeAreaInsets?: { top: number; bottom: number; left: number; right: number };
  userAgent?: {
    device: { type: string };
    capabilities: { hover: boolean; touch: boolean };
  };
}

export interface WidgetDebugInfo {
  toolCallId: string;
  toolName: string;
  protocol: "openai-apps" | "mcp-apps";
  widgetState: unknown;
  globals: WidgetGlobals;
  prefersBorder?: boolean;
  updatedAt: number;
  csp?: WidgetSandboxInfo;
  applied?: WidgetSandboxApplied;
  hostProfileId?: string;
  hostInfo?: { name: string; version: string } | null;
  lifecycle: WidgetLifecycleEvent[];
  mounts: WidgetMount[];
  modelContext?: {
    content?: unknown[];
    structuredContent?: Record<string, unknown>;
    updatedAt: number;
  } | null;
  widgetHtml?: string;
  injectedOpenAiCompat?: boolean;
  injectedOpenAiCompatCapabilities?: OpenAiAppsCapabilities;
}

export interface UiLogEvent {
  id: string;
  /** toolCallId */
  widgetId: string;
  serverId: string;
  serverName?: string;
  direction: "host-to-ui" | "ui-to-host";
  protocol: UiProtocol;
  method: string;
  timestamp: string;
  message: unknown;
}

/** Diagnostics sink — 1:1 with widget-debug-store + traffic-log addLog. */
export interface WidgetDebugSink {
  recordMount: (toolCallId: string, reason: string) => void;
  setWidgetDebugInfo: (
    toolCallId: string,
    info: Partial<Omit<WidgetDebugInfo, "toolCallId" | "updatedAt">>,
  ) => void;
  setWidgetState: (toolCallId: string, state: unknown) => void;
  setWidgetGlobals: (
    toolCallId: string,
    globals: Partial<WidgetGlobals>,
  ) => void;
  setWidgetCsp: (
    toolCallId: string,
    csp: Omit<WidgetSandboxInfo, "violations">,
  ) => void;
  addCspViolation: (toolCallId: string, violation: CspViolation) => void;
  clearCspViolations: (toolCallId: string) => void;
  setWidgetModelContext: (
    toolCallId: string,
    context: {
      content?: unknown[];
      structuredContent?: Record<string, unknown>;
    } | null,
  ) => void;
  setWidgetHtml: (
    toolCallId: string,
    html: string,
    injectedOpenAiCompat?: boolean,
    injectedOpenAiCompatCapabilities?: OpenAiAppsCapabilities,
  ) => void;
  setSandboxApplied: (
    toolCallId: string,
    applied: WidgetSandboxApplied,
    hostProfileId?: string,
    hostInfo?: { name: string; version: string } | null,
  ) => void;
  appendLifecycle: (
    toolCallId: string,
    event: WidgetLifecycleEvent,
  ) => void;
  /** useTrafficLogStore.addLog */
  addTrafficLog: (event: Omit<UiLogEvent, "id" | "timestamp">) => void;
}

// --- Chrome injection (optional) ---------------------------------------------
//
// The package owns widget lifecycle + bridge; the inspector injects the modal
// CHROME (its design-system <Dialog>) + billing/checkout via `components.Modal`,
// which receives children/state/callbacks only.

export interface WidgetModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

/**
 * Checkout chrome injection (Agentic Commerce / ACP). The package owns the
 * `requestCheckout` lifecycle but not the inspector's checkout UI; the inspector
 * injects its `CheckoutDialogV2` via `components.Checkout`. `session` is the raw
 * ACP checkout-session payload the widget supplied — opaque to the package, so
 * it is typed `unknown` and the inspector adapter narrows it to its own
 * `CheckoutSession` shape.
 */
export interface WidgetCheckoutProps {
  session: unknown;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolve the widget's checkout promise with the successful result. */
  onComplete: (result: unknown) => void;
  /** Reject the widget's checkout promise with a non-UI error. */
  onError: (error: string) => void;
  onCancel: () => void;
  onCallTool: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface WidgetHostComponents {
  Modal?: ComponentType<WidgetModalProps>;
  Checkout?: ComponentType<WidgetCheckoutProps>;
}

// --- Environment -------------------------------------------------------------

/**
 * Per-`serverId` resolved host environment — the deferred `resolveEnvironment`
 * target. Currently unused by the renderer (Phase 1b reads the raw `environment`
 * inputs + `resolvers` instead); kept on the contract for the eventual fold-in.
 */
export interface WidgetHostEnvironment {
  hostInfo: ResolvedHostInfo;
  hostCapabilities: ResolvedHostCapabilities;
  mcpAppsCapabilities: ResolvedMcpAppsCapabilities;
  injectOpenAiCompat: boolean;
  openAiCompatCapabilities?: ResolvedOpenAiAppsCapabilities;
  supportsWidgetRendering: boolean;
  theme: string;
  hostStyle: ResolvedHostStyle;
  baseHostContext: McpUiHostContext;
}

/**
 * Minimal structural projection of `mcpProfile.apps.sandbox` (the host-policy
 * sandbox overrides the renderer reads directly). The full `HostConfigMcpProfileV1`
 * is bound inside the inspector adapter's resolvers and never enters the public
 * surface; only these read-by-the-renderer fields are projected here. `csp` is
 * the SDK `SandboxCspPolicy` plus the inspector-only `cspDirectives` escape hatch.
 */
export interface WidgetHostProfileSandbox {
  csp?: SandboxCspPolicy & { cspDirectives?: Record<string, string[]> };
  permissions?: SandboxPermissionsPolicy;
  sandboxAttrs?: string[];
  allowFeatures?: Record<string, string>;
}

/**
 * Raw ambient ENV inputs the renderer reads (Phase 1b). The inspector's
 * use-widget-host adapter supplies these from its stores/contexts; these are
 * structural mirrors of the inspector store/context shapes.
 *
 * The active MCP profile (`HostConfigMcpProfileV1`) is NOT exposed as a typed
 * object — it is bound inside the adapter's resolvers (3d-iii). The renderer
 * instead reads `profileKey` (a reactivity hash) plus the minimal structural
 * projections it actually inspects (`profileSandbox`, `profileHostInfo`).
 */
export interface WidgetHostEnvironmentInputs {
  themeMode: ThemeMode;
  sharedHostStyle: ChatboxHostStyle;
  chatboxHostStyle: ChatboxHostStyle | null;
  chatboxHostTheme: "light" | "dark" | null;
  hostCapabilitiesOverride: Record<string, unknown> | undefined;
  /**
   * Stable hash of the active MCP profile. The profile object is bound in the
   * adapter's resolvers; the renderer keys its capability memos on this so they
   * recompute when the profile changes without the profile type leaking here.
   */
  profileKey: string;
  /** `mcpProfile.apps.sandbox` projection (host-policy sandbox overrides). */
  profileSandbox: WidgetHostProfileSandbox | undefined;
  /** `mcpProfile.apps.uiInitialize.hostInfo` projection (AppBridge identity override). */
  profileHostInfo: { name?: unknown; version?: unknown } | undefined;
  draftHostContext: ProjectHostContextDraft;
  isPlaygroundActive: boolean;
  playgroundLocale: string;
  playgroundTimeZone: string;
  playgroundDisplayMode: DisplayMode;
  playgroundCapabilities: DeviceCapabilities;
  playgroundSafeAreaInsets: SafeAreaInsets;
  playgroundDeviceType: DeviceType;
}

// --- Resolvers ---------------------------------------------------------------

/**
 * Resolver / projection fns the renderer calls. The inspector's use-widget-host
 * adapter binds them to the real client-config-v2 / client-styles /
 * client-config implementations; typed structurally so the package owns no
 * inspector code. Drift is caught where the adapter assigns the real fns.
 */
// The profile-dependent resolvers no longer take a `profile` argument — the
// inspector adapter binds the active `HostConfigMcpProfileV1` into them, so the
// profile type stays out of the public surface. `profileKey` drives the
// renderer's recompute reactivity.
export interface WidgetHostResolvers {
  resolveEffectiveCompatRuntime: (args: {
    hostStyle: ChatboxHostStyle | string | null | undefined;
  }) => EffectiveCompatRuntime;
  resolveEffectiveMcpAppsCapabilities: (args: {
    hostStyle: ChatboxHostStyle | string | null | undefined;
  }) => ResolvedMcpAppsCapabilities;
  resolveEffectiveHostCapabilities: (args: {
    hostStyle: string | null | undefined;
    hostCapabilitiesOverride?: Record<string, unknown>;
  }) => ResolvedHostCapabilities;
  resolveHostInfo: () => ResolvedHostInfo;
  getHostStyleOrDefault: (id: string | null | undefined) => ResolvedHostStyle;
  DEFAULT_HOST_STYLE: ResolvedHostStyle;
  extractHostTheme: (
    hostContext?: Record<string, unknown>,
  ) => "light" | "dark" | undefined;
  extractHostDisplayMode: (
    hostContext?: Record<string, unknown>,
  ) => DisplayMode | undefined;
  extractHostDisplayModes: (
    hostContext?: Record<string, unknown>,
  ) => DisplayMode[];
  clampDisplayModeToAvailableModes: (
    displayMode: DisplayMode | undefined,
    availableDisplayModes: DisplayMode[],
  ) => DisplayMode;
  stableStringifyJson: (value: unknown) => string;
}

// --- Services ----------------------------------------------------------------

export interface FetchWidgetContentRequest {
  serverId: string;
  resourceUri: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  toolResponseMetadata?: Record<string, unknown> | null;
  initialWidgetState?: unknown;
  toolId: string;
  toolName: string;
  theme: string;
  cspMode: CspMode;
  injectOpenAiCompat: boolean;
  openAiCompatCapabilities?: ResolvedOpenAiAppsCapabilities;
  template?: string;
  viewMode?: string;
  viewParams?: Record<string, unknown>;
  forceWebEndpoint?: boolean;
}

export interface FetchWidgetContentResponse {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  permissive?: boolean;
  mimeTypeWarning?: string;
  mimeTypeValid?: boolean;
  prefersBorder?: boolean;
  injectedOpenAiCompat?: boolean;
  injectedOpenAiCompatCapabilities?: ResolvedOpenAiAppsCapabilities;
}

// A `type` alias (not interface) on purpose: the inspector api's
// `ListResourcesResult` is a type alias, so it carries an implicit index
// signature and stays assignable to the MCP bridge handler's index-signature
// target. An interface here would break that assignability.
export type ListResourcesResult = {
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  }>;
  nextCursor?: string;
};

/**
 * Widget content fetch + MCP transport. The inspector binds these to
 * `fetchMcpAppsWidgetContent` + the MCP resource/prompt apis.
 * `listResourceTemplates` is HOST-OWNED — the inspector applies the
 * HOSTED_MODE / web-managed guard before calling the raw api.
 */
export interface WidgetHostServices {
  fetchWidgetContent: (
    req: FetchWidgetContentRequest,
  ) => Promise<FetchWidgetContentResponse>;
  // Mirrors the inspector api fn (returns `Promise<any>`); the bridge handler
  // treats the resource payload opaquely.
  readResource: (
    serverId: string,
    uri: string,
    opts?: { forceHosted?: boolean },
  ) => Promise<any>;
  listResources: (
    serverId: string,
    cursor?: string,
    opts?: { forceHosted?: boolean },
  ) => Promise<ListResourcesResult>;
  listPrompts: (
    serverId: string,
    opts?: { forceHosted?: boolean },
  ) => Promise<MCPPrompt[]>;
  listResourceTemplates: (serverId: string) => Promise<MCPResourceTemplate[]>;
  /**
   * Session-authenticated `fetch` (the inspector's `authFetch`): attaches the
   * hosted bearer/session token for inspector API paths. Used by the widget
   * file-upload bridge (`openai:uploadFile`); plain static/cached fetches use
   * the global `fetch` directly.
   */
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

// --- The seam ----------------------------------------------------------------

export interface WidgetHost {
  /**
   * Resolved per-server environment — the deferred fully-pre-resolved target.
   * OPTIONAL: the renderer reads the raw `environment` inputs + `resolvers`
   * instead. 3d-iii already removed the `HostConfigMcpProfileV1` type from the
   * public surface (the profile is bound inside the adapter's resolvers);
   * collapsing `environment` + `resolvers` entirely into this is a later step.
   */
  resolveEnvironment?: (serverId: string | undefined) => WidgetHostEnvironment;
  /** Raw ambient ENV inputs (Phase 1b); supplied by the inspector adapter. */
  environment: WidgetHostEnvironmentInputs;
  /** Bound resolver/projection fns (Phase 1b); bound by the inspector adapter. */
  resolvers: WidgetHostResolvers;
  services: WidgetHostServices;
  surface: WidgetSurfaceInfo;
  debug?: WidgetDebugSink;
  components?: WidgetHostComponents;
}
