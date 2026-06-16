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

export interface WidgetHostComponents {
  Modal?: ComponentType<WidgetModalProps>;
}

// --- The seam ----------------------------------------------------------------

export interface WidgetHost {
  surface: WidgetSurfaceInfo;
  debug?: WidgetDebugSink;
  components?: WidgetHostComponents;
  // 3d-i-b: `environment`, `resolvers`, `services` fold in here as the
  // fn-heavy / profile-derived slices relocate.
}
