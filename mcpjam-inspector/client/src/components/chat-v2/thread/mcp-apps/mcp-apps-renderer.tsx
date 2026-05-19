/**
 * MCPAppsRenderer - SEP-1865 MCP Apps Renderer
 *
 * Renders MCP Apps widgets using the SEP-1865 protocol:
 * - JSON-RPC 2.0 over postMessage
 * - Double-iframe sandbox architecture
 * - tools/call, resources/read, ui/message, ui/open-link support
 *
 * Uses SandboxedIframe for DRY double-iframe setup.
 */

import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  type CSSProperties,
} from "react";
import { useToolInputStreaming, type ToolState } from "./useToolInputStreaming";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useUIPlaygroundStore,
  type CspMode,
} from "@/stores/ui-playground-store";
import { X } from "lucide-react";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { useIsChatboxSurface } from "@/contexts/chatbox-surface-context";
import {
  resolveSandboxCsp,
  resolveSandboxPermissions,
} from "@mcpjam/sdk/browser";
import {
  useTrafficLogStore,
  extractMethod,
  UiProtocol,
} from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_HOST_STYLE,
  getHostStyleOrDefault,
} from "@/lib/client-styles";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/mcp-apps-utils";
import { LoggingTransport } from "./mcp-apps-logging-transport";
import { McpAppsModal } from "./mcp-apps-modal";
import {
  handleGetFileDownloadUrlMessage,
  handleUploadFileMessage,
} from "./widget-file-messages";
import { CheckoutDialogV2 } from "./checkout-dialog-v2";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
import { readToolResultMeta } from "@/lib/tool-result-utils";
import type { CheckoutSession } from "@/shared/acp-types";
import { listResources, readResource } from "@/lib/apis/mcp-resources-api";
import { listPrompts } from "@/lib/apis/mcp-prompts-api";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { useChatboxHostCapabilitiesOverride } from "@/contexts/chatbox-client-capabilities-override-context";
import { useHostContextStore } from "@/stores/client-context-store";
import {
  clampDisplayModeToAvailableModes,
  extractHostDisplayMode,
  extractHostDisplayModes,
  extractHostTheme,
} from "@/lib/client-config";
import {
  resolveEffectiveHostCapabilities,
  resolveHostInfo,
} from "@/lib/client-config-v2";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

// Default input schema for tools without metadata
const DEFAULT_INPUT_SCHEMA = { type: "object" } as const;

const SUPPRESSED_UI_LOG_METHODS = new Set(["ui/notifications/size-changed"]);
const PIP_MAX_HEIGHT = "min(40vh, 600px)";

/**
 * Origins the hosted-mode sandbox clamp must strip from any widget-
 * declared CSP. A hosted widget could otherwise declare an MCPJam
 * origin in `connectDomains` and use the user's authenticated session
 * to exfiltrate data through the iframe. Forwarded into the SDK via
 * `resolveSandboxCsp`'s `hostedClampExtraDeny` — an SDK-internal API
 * for hosted-mode origin stripping, distinct from anything the user can
 * configure (SEP-1865 host policies are allowlist-only).
 *
 * Wildcards cover all subdomains (api, staging, www, etc.) without
 * having to enumerate them. The bare-host entry catches widgets that
 * declare the apex domain directly.
 */
const MCPJAM_HOSTED_CLAMP_ORIGINS: ReadonlyArray<string> = [
  "https://*.mcpjam.com",
  "https://mcpjam.com",
];

type DisplayMode = "inline" | "pip" | "fullscreen";
type HostStyleVariables = NonNullable<
  NonNullable<McpUiHostContext["styles"]>["variables"]
>;

// SEP-1865 fixes the set of style variable keys ui/initialize accepts. Every
// HostStyleDefinition returns McpUiStyles from resolveStyleVariables, so a
// legitimate built-in's key set is exactly the SEP enum; pinning the allowlist
// to it both honors the protocol and strips any extra keys a runtime-registered
// host might smuggle in via `as any`, which the SDK would reject downstream.
const SEP_HOST_STYLE_VARIABLE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_HOST_STYLE.mcp.resolveStyleVariables("light")),
  ...Object.keys(DEFAULT_HOST_STYLE.mcp.resolveStyleVariables("dark")),
]);

function sanitizeHostStyleVariables(
  variables: unknown,
): HostStyleVariables | undefined {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return undefined;
  }

  const sanitized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (!SEP_HOST_STYLE_VARIABLE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string" || value === undefined) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0
    ? (sanitized as HostStyleVariables)
    : undefined;
}

// CSP and permissions metadata types are now imported from SDK

interface MCPAppsRendererProps {
  serverId: string;
  toolCallId: string;
  toolName: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  /**
   * Tool response `_meta`, pre-extracted by the caller from the raw
   * (still-wrapped) tool result. Required because `toolOutput` is
   * typically the *unwrapped* value (e.g. `result.value`), at which
   * point `_meta` from the wrapper is no longer reachable from the
   * value alone. Passing this explicitly preserves Apps SDK's
   * `window.openai.toolResponseMetadata` surface for widgets relying
   * on it (timestamps, source IDs, etc.).
   */
  toolResponseMetadata?: Record<string, unknown> | null;
  toolErrorText?: string;
  resourceUri: string;
  toolMetadata?: Record<string, unknown>;
  /** All tools metadata for visibility checking when widget calls tools */
  toolsMetadata?: Record<string, Record<string, unknown>>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  pipWidgetId?: string | null;
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  /** Controlled display mode - when provided, component uses this instead of internal state */
  displayMode?: DisplayMode;
  /** Callback when display mode changes - required when displayMode is controlled */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  /** Callback when widget updates model context (SEP-1865 ui/update-model-context) */
  onModelContextUpdate?: (
    toolCallId: string,
    context: {
      content?: ContentBlock[];
      structuredContent?: Record<string, unknown>;
    },
  ) => void;
  /** Callback when app declares its supported display modes during ui/initialize */
  onAppSupportedDisplayModesChange?: (modes: DisplayMode[] | undefined) => void;
  /** Whether the server is offline (for using cached content) */
  isOffline?: boolean;
  /** URL to cached widget HTML for offline rendering */
  cachedWidgetHtmlUrl?: string;
  /** Persisted CSP metadata for cached/offline replay */
  widgetCsp?: McpUiResourceCsp | null;
  /** Persisted permissions metadata for cached/offline replay */
  widgetPermissions?: McpUiResourcePermissions | null;
  /** Persisted permissive flag for cached/offline replay */
  widgetPermissive?: boolean;
  /** Persisted prefersBorder value for cached/offline replay */
  prefersBorder?: boolean;
  /**
   * Persisted widget state from a saved view or fork. When set, the
   * compat runtime seeds `window.openai.widgetState` with this value so
   * the widget boots in the same state it was when the view was saved
   * (Apps SDK parity — the legacy ChatGPTAppRenderer wired this the same
   * way).
   */
  initialWidgetState?: unknown;
  /** Minimal mode hides diagnostics and metadata surfaces */
  minimalMode?: boolean;
}

export function MCPAppsRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput,
  toolOutput,
  toolResponseMetadata,
  toolErrorText,
  resourceUri,
  toolMetadata,
  toolsMetadata,
  onSendFollowUp,
  onCallTool,
  onWidgetStateChange,
  pipWidgetId,
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  displayMode: displayModeProp,
  onDisplayModeChange,
  onRequestFullscreen,
  onExitFullscreen,
  onModelContextUpdate,
  onAppSupportedDisplayModesChange,
  isOffline,
  cachedWidgetHtmlUrl,
  widgetCsp: initialWidgetCsp,
  widgetPermissions: initialWidgetPermissions,
  widgetPermissive: initialWidgetPermissive,
  prefersBorder: initialPrefersBorder,
  initialWidgetState,
  minimalMode = false,
}: MCPAppsRendererProps) {
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const sharedHostStyle = usePreferencesStore((s) => s.hostStyle);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const hostCapabilitiesOverride = useChatboxHostCapabilitiesOverride();
  // Active hostConfig.mcpProfile from the surrounding scope (chatbox
  // session, project default, eval suite). Drives the resolver below
  // when set; undefined preserves widget-derived sandbox behavior.
  const activeMcpProfile = useActiveMcpProfile();
  const draftHostContext = useHostContextStore((s) => s.draftHostContext);
  const baseHostContext = useMemo(
    () =>
      draftHostContext &&
      typeof draftHostContext === "object" &&
      !Array.isArray(draftHostContext)
        ? draftHostContext
        : {},
    [draftHostContext],
  );

  // Get CSP mode and host style from playground store when in playground
  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const configuredHostTheme = extractHostTheme(baseHostContext);
  const resolvedTheme = isPlaygroundActive
    ? configuredHostTheme ?? chatboxHostTheme ?? themeMode
    : chatboxHostTheme ?? themeMode;
  const playgroundCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  // Chatbox surfaces (published runtime, Chatboxes → Preview, Chatboxes →
  // Sessions transcript) default to `permissive`. They are end-user-facing
  // demo surfaces where an incomplete `_meta.ui.csp` declaration on the MCP
  // server would manifest as a blank widget; the friction outweighs the
  // loss of host-side CSP enforcement. Hosts that need strict enforcement
  // can still pin it via the host config's `apps.sandbox.csp` policy,
  // applied per-resource below by `resolveSandboxCsp` regardless of this
  // default.
  //
  // Why isChatboxSurface wins over isPlaygroundActive: the Playground store
  // is persisted to localStorage and shared across browsing contexts on the
  // same origin, including the chatbox runtime iframe rendered inside the
  // Preview tab. If the user has Playground active in the inspector with
  // `mcpAppsCspMode: "widget-declared"`, that selection would otherwise
  // leak into the chatbox preview iframe and render the published runtime
  // under strict CSP — surprising and inconsistent with the published
  // chatbox runtime when opened in a top-level window.
  const isChatboxSurface = useIsChatboxSurface();
  const cspMode: CspMode =
    isChatboxSurface || minimalMode
      ? "permissive"
      : isPlaygroundActive
        ? playgroundCspMode
        : "widget-declared";

  // Get locale and timeZone from playground store when active, fallback to browser defaults
  const playgroundLocale = useUIPlaygroundStore((s) => s.globals.locale);
  const playgroundTimeZone = useUIPlaygroundStore((s) => s.globals.timeZone);
  const fallbackLocale = isPlaygroundActive
    ? playgroundLocale
    : navigator.language || "en-US";
  const fallbackTimeZone = isPlaygroundActive
    ? playgroundTimeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const locale =
    typeof draftHostContext?.locale === "string"
      ? draftHostContext.locale
      : fallbackLocale;
  const timeZone =
    typeof draftHostContext?.timeZone === "string"
      ? draftHostContext.timeZone
      : fallbackTimeZone;

  // Get displayMode from playground store when active (SEP-1865)
  const playgroundDisplayMode = useUIPlaygroundStore((s) => s.displayMode);
  const configuredDisplayMode = useMemo(
    () => extractHostDisplayMode(draftHostContext),
    [draftHostContext],
  );
  const configuredAvailableDisplayModes = useMemo(
    () => extractHostDisplayModes(draftHostContext),
    [draftHostContext],
  );

  // Get device capabilities from playground store (SEP-1865)
  const playgroundCapabilities = useUIPlaygroundStore((s) => s.capabilities);
  const deviceCapabilities = useMemo(() => {
    const configuredCapabilities =
      draftHostContext?.deviceCapabilities &&
      typeof draftHostContext.deviceCapabilities === "object" &&
      !Array.isArray(draftHostContext.deviceCapabilities)
        ? (draftHostContext.deviceCapabilities as {
            hover?: boolean;
            touch?: boolean;
          })
        : undefined;

    if (configuredCapabilities) {
      return {
        hover: configuredCapabilities.hover ?? true,
        touch: configuredCapabilities.touch ?? false,
      };
    }

    return isPlaygroundActive
      ? playgroundCapabilities
      : { hover: true, touch: false };
  }, [draftHostContext, isPlaygroundActive, playgroundCapabilities]);

  // Get safe area insets from playground store (SEP-1865)
  const playgroundSafeAreaInsets = useUIPlaygroundStore(
    (s) => s.safeAreaInsets,
  );
  const safeAreaInsets = useMemo(() => {
    const configuredSafeAreaInsets =
      draftHostContext?.safeAreaInsets &&
      typeof draftHostContext.safeAreaInsets === "object" &&
      !Array.isArray(draftHostContext.safeAreaInsets)
        ? (draftHostContext.safeAreaInsets as {
            top?: number;
            right?: number;
            bottom?: number;
            left?: number;
          })
        : undefined;

    if (configuredSafeAreaInsets) {
      return {
        top: configuredSafeAreaInsets.top ?? 0,
        right: configuredSafeAreaInsets.right ?? 0,
        bottom: configuredSafeAreaInsets.bottom ?? 0,
        left: configuredSafeAreaInsets.left ?? 0,
      };
    }

    return isPlaygroundActive
      ? playgroundSafeAreaInsets
      : { top: 0, right: 0, bottom: 0, left: 0 };
  }, [draftHostContext, isPlaygroundActive, playgroundSafeAreaInsets]);

  // Get device type from playground store for platform derivation (SEP-1865)
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);

  // Display mode: controlled (via props) or uncontrolled (internal state)
  const isControlled = displayModeProp !== undefined;
  const [internalDisplayMode, setInternalDisplayMode] = useState<DisplayMode>(
    clampDisplayModeToAvailableModes(
      configuredDisplayMode ??
        (isPlaygroundActive ? playgroundDisplayMode : "inline"),
      configuredAvailableDisplayModes,
    ),
  );
  const displayMode = isControlled ? displayModeProp : internalDisplayMode;
  const requestedDisplayMode = useMemo<DisplayMode>(() => {
    if (!isControlled) return displayMode;
    if (displayMode === "fullscreen" && fullscreenWidgetId === toolCallId)
      return "fullscreen";
    if (displayMode === "pip" && pipWidgetId === toolCallId) return "pip";
    return "inline";
  }, [displayMode, fullscreenWidgetId, isControlled, pipWidgetId, toolCallId]);
  const effectiveDisplayMode = useMemo<DisplayMode>(
    () =>
      clampDisplayModeToAvailableModes(
        requestedDisplayMode,
        configuredAvailableDisplayModes,
      ),
    [configuredAvailableDisplayModes, requestedDisplayMode],
  );
  const setDisplayMode = useCallback(
    (mode: DisplayMode) => {
      if (isControlled) {
        onDisplayModeChange?.(mode);
      } else {
        setInternalDisplayMode(mode);
      }

      // Notify parent about fullscreen state changes regardless of controlled mode
      if (mode === "fullscreen") {
        onRequestFullscreen?.(toolCallId);
      } else if (displayMode === "fullscreen") {
        onExitFullscreen?.(toolCallId);
      }
    },
    [
      isControlled,
      onDisplayModeChange,
      toolCallId,
      onRequestFullscreen,
      onExitFullscreen,
      displayMode,
    ],
  );
  const lastForcedDisplayModeRef = useRef<DisplayMode | null>(null);

  useEffect(() => {
    if (requestedDisplayMode === effectiveDisplayMode) {
      lastForcedDisplayModeRef.current = null;
      return;
    }

    if (lastForcedDisplayModeRef.current === effectiveDisplayMode) {
      return;
    }

    lastForcedDisplayModeRef.current = effectiveDisplayMode;
    setDisplayMode(effectiveDisplayMode);
  }, [effectiveDisplayMode, requestedDisplayMode, setDisplayMode]);

  const [isReady, setIsReady] = useState(false);
  const [reinitCount, setReinitCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [sandboxProxyReady, setSandboxProxyReady] = useState(false);
  const [bridgeTransportReady, setBridgeTransportReady] = useState(false);
  const isCachedReplay = !!cachedWidgetHtmlUrl;
  const [widgetCsp, setWidgetCsp] = useState<McpUiResourceCsp | undefined>(
    isCachedReplay ? undefined : (initialWidgetCsp ?? undefined),
  );
  const [widgetPermissions, setWidgetPermissions] = useState<
    McpUiResourcePermissions | undefined
  >(isCachedReplay ? undefined : (initialWidgetPermissions ?? undefined));
  const [widgetPermissive, setWidgetPermissive] = useState<boolean>(
    isCachedReplay ? true : (initialWidgetPermissive ?? false),
  );
  const [prefersBorder, setPrefersBorder] = useState<boolean>(
    initialPrefersBorder ?? true,
  );
  const [loadedCspMode, setLoadedCspMode] = useState<CspMode | null>(null);
  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, unknown>>({});
  const [modalTitle, setModalTitle] = useState("");
  const [modalTemplate, setModalTemplate] = useState<string | null>(null);

  // Checkout state
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutSession, setCheckoutSession] =
    useState<CheckoutSession | null>(null);
  const [checkoutCallId, setCheckoutCallId] = useState<number | null>(null);

  // Reset widget HTML when cachedWidgetHtmlUrl changes (e.g., different view selected)
  useEffect(() => {
    setWidgetHtml(null);
    setBridgeTransportReady(false);
    setLoadedCspMode(null);
    setLoadError(null);
    setWidgetCsp(isCachedReplay ? undefined : (initialWidgetCsp ?? undefined));
    setWidgetPermissions(
      isCachedReplay ? undefined : (initialWidgetPermissions ?? undefined),
    );
    setWidgetPermissive(
      isCachedReplay ? true : (initialWidgetPermissive ?? false),
    );
    setPrefersBorder(initialPrefersBorder ?? true);
  }, [
    cachedWidgetHtmlUrl,
    isCachedReplay,
    initialWidgetCsp,
    initialWidgetPermissions,
    initialWidgetPermissive,
    initialPrefersBorder,
  ]);

  const bridgeRef = useRef<AppBridge | null>(null);
  const hostContextRef = useRef<McpUiHostContext | null>(null);
  const isReadyRef = useRef(false);
  const lastInlineHeightRef = useRef<string>("400px");

  const onSendFollowUpRef = useRef(onSendFollowUp);
  const onCallToolRef = useRef(onCallTool);
  const onRequestPipRef = useRef(onRequestPip);
  const onExitPipRef = useRef(onExitPip);
  const setDisplayModeRef = useRef(setDisplayMode);
  const isPlaygroundActiveRef = useRef(isPlaygroundActive);
  const playgroundDeviceTypeRef = useRef(playgroundDeviceType);
  const effectiveDisplayModeRef = useRef(effectiveDisplayMode);
  const serverIdRef = useRef(serverId);
  const toolCallIdRef = useRef(toolCallId);
  const pipWidgetIdRef = useRef(pipWidgetId);
  const toolsMetadataRef = useRef(toolsMetadata);
  const onModelContextUpdateRef = useRef(onModelContextUpdate);
  const onAppSupportedDisplayModesChangeRef = useRef(
    onAppSupportedDisplayModesChange,
  );

  // Refs for values consumed inside the async fetchWidgetHtml function.
  // These change reference on every streaming chunk (AI SDK recreates part objects),
  // but we don't want to re-trigger the fetch effect for reference-only changes.
  const toolInputRef = useRef(toolInput);
  toolInputRef.current = toolInput;
  const toolOutputRef = useRef(toolOutput);
  toolOutputRef.current = toolOutput;
  const themeModeRef = useRef(themeMode);

  const {
    canRenderStreamingInput,
    signalStreamingRender,
    resetStreamingState,
  } = useToolInputStreaming({
    bridgeRef,
    isReady,
    isReadyRef,
    toolState,
    toolInput,
    toolOutput,
    toolErrorText,
    toolCallId,
    reinitCount,
  });
  const hasWidgetHtml = widgetHtml !== null;
  const widgetHtmlLength = widgetHtml?.length ?? 0;

  // Fetch widget HTML when tool is active (streaming, input ready, or output available) or CSP mode changes
  useEffect(() => {
    const isActiveToolState =
      toolState === "input-streaming" ||
      toolState === "input-available" ||
      toolState === "output-available";
    if (!isActiveToolState) return;
    // Re-fetch if CSP mode changed (widget needs to reload with new CSP policy)
    if (widgetHtml && loadedCspMode === cspMode) return;

    const fetchWidgetHtml = async () => {
      try {
        logWidgetDebug("host-to-ui", "debug/widget-content-requested", {
          cachedWidgetHtmlUrl: cachedWidgetHtmlUrl ?? null,
          cspMode,
          isOffline: !!isOffline,
          resourceUri,
          toolState: toolState ?? null,
        });
        // Use cached widget HTML whenever available (faster and works offline)
        // This is for the Views tab offline rendering
        if (cachedWidgetHtmlUrl) {
          const cachedResponse = await fetch(cachedWidgetHtmlUrl);
          if (!cachedResponse.ok) {
            throw new Error(
              `Failed to fetch cached widget HTML: ${cachedResponse.statusText}`,
            );
          }
          const html = await cachedResponse.text();
          // Reset readiness so the previous bridge's transport doesn't
          // get reused with the new HTML before its connect resolves.
          setBridgeTransportReady(false);
          setWidgetHtml(html);
          setWidgetCsp(undefined);
          setWidgetPermissions(undefined);
          setWidgetPermissive(true);
          setPrefersBorder(initialPrefersBorder ?? true);
          setLoadedCspMode(cspMode);
          setWidgetHtmlStore(toolCallId, html);
          logWidgetDebug("host-to-ui", "debug/widget-content-ready", {
            cached: true,
            cspMode,
            htmlLength: html.length,
            permissive: true,
          });
          return;
        }

        // If server is offline and no cached HTML, show helpful error
        if (isOffline) {
          const errorMessage =
            "Server is offline and this view was saved without cached HTML. " +
            "Connect the server and re-save the view to enable offline rendering.";
          setLoadError(errorMessage);
          logWidgetDebug("host-to-ui", "debug/widget-content-error", {
            error: errorMessage,
          });
          return;
        }

        const {
          html,
          csp,
          permissions,
          permissive,
          mimeTypeWarning: warning,
          mimeTypeValid: valid,
          prefersBorder,
        } = await fetchMcpAppsWidgetContent({
          serverId,
          resourceUri,
          toolInput: toolInputRef.current,
          toolOutput: toolOutputRef.current,
          // Surface `_meta` from the tool response so the compat runtime
          // can expose it as `window.openai.toolResponseMetadata`. Prefer
          // the explicit `toolResponseMetadata` prop (which the caller
          // computes from rawOutput where the `{ value, _meta }` wrapper
          // is still intact); fall back to deriving from the resolved
          // output for callers that don't pass it.
          toolResponseMetadata:
            toolResponseMetadata ??
            readToolResultMeta(toolOutputRef.current) ??
            null,
          initialWidgetState,
          toolId: toolCallId,
          toolName,
          theme: themeModeRef.current,
          cspMode,
        });

        if (!valid) {
          const errorMessage =
            warning ||
            `Invalid mimetype - SEP-1865 requires "text/html;profile=mcp-app"`;
          setLoadError(errorMessage);
          logWidgetDebug("host-to-ui", "debug/widget-content-invalid-mimetype", {
            cspMode,
            error: errorMessage,
          });
          return;
        }

        // Reset readiness so the previous bridge's transport doesn't get
        // reused with the new HTML before its connect resolves.
        setBridgeTransportReady(false);
        setWidgetHtml(html);
        setWidgetCsp(csp);
        setWidgetPermissions(permissions);
        setWidgetPermissive(permissive ?? false);
        setPrefersBorder(prefersBorder ?? true);
        setLoadedCspMode(cspMode);

        // Store widget HTML in debug store for save view feature
        setWidgetHtmlStore(toolCallId, html);

        // Update the widget debug store with CSP and permissions info
        if (csp || permissions || !permissive) {
          setWidgetCspStore(toolCallId, {
            mode: permissive ? "permissive" : "widget-declared",
            connectDomains: csp?.connectDomains || [],
            resourceDomains: csp?.resourceDomains || [],
            frameDomains: csp?.frameDomains || [],
            baseUriDomains: csp?.baseUriDomains || [],
            permissions: permissions,
            widgetDeclared: csp
              ? {
                  connectDomains: csp.connectDomains,
                  resourceDomains: csp.resourceDomains,
                  frameDomains: csp.frameDomains,
                  baseUriDomains: csp.baseUriDomains,
                }
              : null,
          });
        }
        logWidgetDebug("host-to-ui", "debug/widget-content-ready", {
          cached: false,
          cspMode,
          hasCsp: !!csp,
          hasPermissions: !!permissions,
          htmlLength: html.length,
          permissive: permissive ?? false,
          prefersBorder: prefersBorder ?? true,
        });
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to prepare widget";
        setLoadError(errorMessage);
        logWidgetDebug("host-to-ui", "debug/widget-content-error", {
          error: errorMessage,
        });
      }
    };

    fetchWidgetHtml();
    // logWidgetDebug is intentionally omitted: it has stable identity (reads
    // serverId/toolCallId via refs) and is declared after this effect.
  }, [
    toolState,
    toolCallId,
    widgetHtml,
    loadedCspMode,
    serverId,
    resourceUri,
    toolName,
    cspMode,
    isOffline,
    cachedWidgetHtmlUrl,
    initialPrefersBorder,
  ]);

  // UI logging
  const addUiLog = useTrafficLogStore((s) => s.addLog);
  const logUiEvent = useCallback(
    (payload: Parameters<typeof addUiLog>[0]) => {
      if (minimalMode) return;
      addUiLog(payload);
    },
    [addUiLog, minimalMode],
  );
  const logUiEventRef = useRef(logUiEvent);
  logUiEventRef.current = logUiEvent;
  // Stable identity so this can be safely included in any effect deps without
  // causing reruns. Reads serverId/toolCallId from refs that are kept current
  // by the ref-sync effect below.
  const logWidgetDebug = useCallback(
    (
      direction: "host-to-ui" | "ui-to-host",
      method: string,
      details: Record<string, unknown>,
    ) => {
      logUiEventRef.current({
        widgetId: toolCallIdRef.current,
        serverId: serverIdRef.current,
        direction,
        protocol: "mcp-apps",
        method,
        message: details,
      });
    },
    [],
  );

  // Widget debug store
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const setWidgetStateStore = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetCspStore = useWidgetDebugStore((s) => s.setWidgetCsp);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);
  const clearCspViolations = useWidgetDebugStore((s) => s.clearCspViolations);
  const setWidgetModelContext = useWidgetDebugStore(
    (s) => s.setWidgetModelContext,
  );
  const setWidgetHtmlStore = useWidgetDebugStore((s) => s.setWidgetHtml);

  // Clear CSP violations when CSP mode changes (stale data from previous mode)
  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      clearCspViolations(toolCallId);
    }
  }, [cspMode, loadedCspMode, toolCallId, clearCspViolations]);

  // Reset ready state and refs when CSP mode changes (widget will reinitialize)
  // This ensures tool input/output are re-sent after CSP mode switch
  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      setIsReady(false);
      isReadyRef.current = false;
      resetStreamingState();
    }
  }, [cspMode, loadedCspMode, resetStreamingState]);

  // Sync displayMode from playground store when it changes (SEP-1865)
  // Only sync when not in controlled mode (parent controls displayMode via props)
  useEffect(() => {
    if (isPlaygroundActive && !isControlled) {
      setInternalDisplayMode(
        clampDisplayModeToAvailableModes(
          configuredDisplayMode ?? playgroundDisplayMode,
          configuredAvailableDisplayModes,
        ),
      );
    }
  }, [
    configuredAvailableDisplayModes,
    configuredDisplayMode,
    isPlaygroundActive,
    playgroundDisplayMode,
    isControlled,
  ]);

  // Initialize widget debug info
  useEffect(() => {
    setWidgetDebugInfo(toolCallId, {
      toolName,
      protocol: "mcp-apps",
      // Seed from persisted state when a saved view / fork supplied one,
      // so the Debug "Widget State" tab shows the restored value on
      // first render instead of `null`. Apps SDK widgets that call
      // window.openai.setWidgetState() later will overwrite this via
      // setWidgetStateStore in the openai:setWidgetState handler below.
      widgetState: initialWidgetState ?? null,
      prefersBorder,
      globals: {
        theme: resolvedTheme,
        displayMode: effectiveDisplayMode,
        locale,
        timeZone,
        deviceCapabilities,
        safeAreaInsets,
      },
    });
  }, [
    toolCallId,
    toolName,
    setWidgetDebugInfo,
    resolvedTheme,
    effectiveDisplayMode,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    prefersBorder,
    initialWidgetState,
  ]);

  // Update globals in debug store when they change
  useEffect(() => {
    setWidgetGlobals(toolCallId, {
      theme: resolvedTheme,
      displayMode: effectiveDisplayMode,
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
    });
  }, [
    toolCallId,
    resolvedTheme,
    effectiveDisplayMode,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    setWidgetGlobals,
  ]);

  // CSS Variables for theming (SEP-1865 styles.variables)
  // These are sent via hostContext.styles.variables - the SDK should pass them through
  const effectiveHostStyle = isPlaygroundActive
    ? sharedHostStyle
    : chatboxHostStyle;
  const hostStyleDefinition = getHostStyleOrDefault(effectiveHostStyle);
  // Single source of truth for what `hostCapabilities` this view will
  // advertise. The bridge-creation effect (`new AppBridge(...)`) spreads this
  // value into the handshake, and `registerBridgeHandlers` gates each
  // chip-bound handler on the matching field — same blob drives both
  // advertise and enforce, no drift.
  //
  // Stability matters: this memo is a dep of both the bridge-construction
  // useEffect and the registerBridgeHandlers useCallback, so a fresh
  // reference per render would tear down + re-attach the bridge on every
  // commit. Both inputs are stable — `effectiveHostStyle` resolves to a
  // string|null derived from Zustand+context selectors, and
  // `hostCapabilitiesOverride` comes from a context whose Providers (see
  // ClientStyledChatTabV2 / PlaygroundTab / ChatboxChatPage) read from
  // Zustand selectors that return stable refs until the underlying field
  // mutates.
  const effectiveHostCapabilities = useMemo(
    () =>
      resolveEffectiveHostCapabilities({
        hostStyle: effectiveHostStyle,
        hostCapabilitiesOverride,
      }),
    [effectiveHostStyle, hostCapabilitiesOverride],
  );
  themeModeRef.current = resolvedTheme;
  const styleVariables = useMemo(
    () => hostStyleDefinition.mcp.resolveStyleVariables(resolvedTheme),
    [resolvedTheme, hostStyleDefinition],
  );
  const hostChatBackground = useMemo(
    () => hostStyleDefinition.chatUi.resolveChatBackground(resolvedTheme),
    [hostStyleDefinition, resolvedTheme],
  );
  const defaultFontCss = hostStyleDefinition.mcp.fontCss;
  const configuredStyles =
    baseHostContext.styles &&
    typeof baseHostContext.styles === "object" &&
    !Array.isArray(baseHostContext.styles)
      ? (baseHostContext.styles as McpUiHostContext["styles"])
      : undefined;
  // The SDK validates styles.variables against the SEP key enum, so strip
  // host-specific custom properties before they enter ui/initialize. The
  // allowlist is fixed to the SEP enum (see SEP_HOST_STYLE_VARIABLE_KEYS),
  // so this memo only depends on the inbound configured variables.
  const configuredStyleVariables = useMemo(
    () => sanitizeHostStyleVariables(configuredStyles?.variables),
    [configuredStyles?.variables],
  );
  const mergedStyleVariables = useMemo(() => {
    return {
      ...styleVariables,
      ...(configuredStyleVariables &&
      Object.keys(configuredStyleVariables).length > 0
        ? configuredStyleVariables
        : {}),
    };
  }, [configuredStyleVariables, styleVariables]);
  const mergedStyles = useMemo<McpUiHostContext["styles"]>(
    () => ({
      ...configuredStyles,
      variables: mergedStyleVariables,
      css: {
        ...configuredStyles?.css,
        fonts: configuredStyles?.css?.fonts ?? defaultFontCss,
      },
    }),
    [configuredStyles, defaultFontCss, mergedStyleVariables],
  );

  // containerDimensions (maxWidth/maxHeight) was previously sent here but
  // removed — width is now fully host-controlled.
  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      ...baseHostContext,
      theme: resolvedTheme,
      displayMode: effectiveDisplayMode,
      availableDisplayModes: configuredAvailableDisplayModes,
      locale,
      timeZone,
      platform:
        baseHostContext.platform === "web" ||
        baseHostContext.platform === "desktop" ||
        baseHostContext.platform === "mobile"
          ? baseHostContext.platform
          : hostStyleDefinition.mcp.platform,
      userAgent: navigator.userAgent,
      deviceCapabilities,
      safeAreaInsets,
      styles: mergedStyles,
      toolInfo: {
        id: toolCallId,
        tool: {
          name: toolName,
          inputSchema:
            (toolMetadata?.inputSchema as {
              type: "object";
              properties?: Record<string, object>;
              required?: string[];
            }) ?? DEFAULT_INPUT_SCHEMA,
          description: toolMetadata?.description as string | undefined,
        },
      },
    }),
    [
      baseHostContext,
      resolvedTheme,
      effectiveDisplayMode,
      configuredAvailableDisplayModes,
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
      mergedStyles,
      hostStyleDefinition,
      toolCallId,
      toolName,
      toolMetadata,
    ],
  );

  useEffect(() => {
    hostContextRef.current = hostContext;
  }, [hostContext]);

  // Resolve the effective sandbox policy ONCE, at component scope, so the
  // same value reaches three independent consumers without drift:
  //   - the AppBridge constructor below (capability handshake)
  //   - the <SandboxedIframe> below (browser-enforced CSP / Permission-Policy)
  //   - the <McpAppsModal> below (its own sandboxed iframe for view_mode=modal)
  //
  // Computing this inside the bridge useEffect (the old shape) leaked the
  // policy into ONE consumer only — the iframe got the raw resource
  // declaration and the browser ignored the host clamp, which is exactly the
  // failure the shared resolver was supposed to prevent. The resolver is the
  // single source of truth; everything that mounts untrusted UI reads from
  // here.
  //
  // `effectivePermissive` collapses to `false` whenever a host policy applies
  // — SandboxedIframe treats `permissive: true` as "skip CSP injection
  // entirely", which would silently neuter the resolver output.
  const sandboxCspPolicy = activeMcpProfile?.apps?.sandbox?.csp;
  const sandboxPermissionsPolicy =
    activeMcpProfile?.apps?.sandbox?.permissions;
  // Inspector-only emission knobs sourced directly from the profile. They
  // bypass the SEP-1865 resolver because they model browser-emission state
  // that has no spec slot (raw `sandbox=`/`allow=` tokens, CSP source
  // expressions). Passed through unchanged to <SandboxedIframe>.
  const sandboxAttrsPolicy =
    activeMcpProfile?.apps?.sandbox?.sandboxAttrs;
  const allowFeaturesPolicy =
    activeMcpProfile?.apps?.sandbox?.allowFeatures;
  const cspDirectivesPolicy =
    activeMcpProfile?.apps?.sandbox?.csp?.cspDirectives;
  // Hosted-mode clamp for cspDirectives. The resolver's
  // `hostedClampExtraDeny` strips MCPJam app/API origins from the
  // widget-declared CSP (`restrictTo` + resource declaration), but
  // cspDirectives is inspector-only — it bypasses the resolver and the
  // proxy merges its tokens AFTER the resolver output, so without a
  // mirrored clamp here a hosted profile with e.g.
  // `cspDirectives: { "connect-src": ["https://app.mcpjam.com"] }`
  // re-adds the same-origin access the clamp is meant to make
  // non-bypassable. Strip any host-bearing token that resolves to the
  // mcpjam.com namespace AND scheme-wide tokens that would otherwise
  // cover MCPJam endpoints (`*`, `https:`, `http:`, `wss:`, `ws:`); CSP
  // keyword tokens (`'unsafe-eval'`, hashes, nonces — quoted with `'…'`)
  // and safe scheme-only tokens (`data:`, `blob:`, `about:`,
  // `filesystem:`, `mediastream:`) pass through unchanged.
  const cspDirectivesEffective = useMemo(() => {
    if (!cspDirectivesPolicy) return cspDirectivesPolicy;
    if (!HOSTED_MODE) return cspDirectivesPolicy;
    const isClampBypass = (token: string) => {
      // `'self'` is a clamp bypass in hosted mode. The proxy is served
      // from the MCPJam origin and the inner srcdoc iframe carries
      // `allow-same-origin` (so its document origin = parent's =
      // MCPJam). `'self'` in the inner doc's CSP therefore resolves
      // to the MCPJam app origin, which lets an untrusted widget
      // fetch authenticated MCPJam endpoints — exactly what the clamp
      // is meant to make unreachable. Templates that need actual
      // same-origin access in production hosts (e.g. real Claude
      // where `'self'` resolves to claude.ai) should list the host
      // explicitly so the modeling is faithful in hosted mode too.
      if (token === "'self'") return true;
      if (token.startsWith("'")) return false; // other CSP keywords
      // Scheme-wide tokens that cover MCPJam-namespace origins. The
      // clamp's purpose is to keep MCPJam app/API endpoints unreachable
      // from the iframe; `https:` (and friends) covers them just as
      // effectively as naming `https://app.mcpjam.com` directly.
      // Templates that need broad access should list specific origins
      // (e.g. Claude lists `https://esm.sh`, `https://assets.claude.ai`).
      if (token === "*") return true;
      if (/^(https?|wss?):$/i.test(token)) return true;
      // Other scheme-only tokens (data:, blob:, about:, filesystem:,
      // mediastream:) don't reach MCPJam origins — let through.
      if (/^[a-z]+:$/.test(token)) return false;
      // Host-bearing token: match mcpjam.com as a host component,
      // covering MCPJAM_HOSTED_CLAMP_ORIGINS (`https://*.mcpjam.com`
      // and `https://mcpjam.com`).
      return /(?:^|[/.@])mcpjam\.com(?:[:/]|$)/i.test(token);
    };
    const out: Record<string, string[]> = {};
    for (const [k, tokens] of Object.entries(cspDirectivesPolicy)) {
      // Trim BEFORE the bypass check: an imported/saved profile can
      // carry " https:" or " https://app.mcpjam.com" with leading
      // whitespace, and the proxy's mergeDirective trims tokens before
      // emitting them — so the untrimmed string sneaks past
      // isClampBypass while the trimmed version still lands in the
      // output CSP, reintroducing the access the clamp is supposed to
      // remove. Normalize here so the filter and the proxy see the same
      // token shape.
      const clamped = tokens
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && !isClampBypass(t));
      if (clamped.length > 0) out[k] = clamped;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }, [cspDirectivesPolicy]);
  const effectiveSandbox = useMemo<{
    csp: McpUiResourceCsp | undefined;
    permissions: McpUiResourcePermissions | undefined;
    permissive: boolean;
    hostPolicyApplied: boolean;
    sandboxAttrs: string[] | undefined;
    allowFeatures: Record<string, string> | undefined;
    cspDirectives: Record<string, string[]> | undefined;
  }>(() => {
    // Detect whether the host explicitly configured CSP hardening signals.
    // Hoisted above the permissive short-circuit so the permissive branch
    // can honor host-explicit `restrictTo` instead of silently dropping it;
    // the relaxed branch below reuses the same calculation. SEP-1865 host
    // policies are allowlist-only, so `restrictTo` and the hosted clamp are
    // the only hardening levers.
    const restrictToConfigured =
      sandboxCspPolicy?.restrictTo !== undefined &&
      Object.values(sandboxCspPolicy.restrictTo).some(
        (list) => Array.isArray(list) && list.length > 0,
      );
    // cspDirectives is an inspector-only emission knob, but a populated
    // value is still an explicit "I want this CSP shape" signal. The
    // permissive shortcut below bypasses the proxy's `buildCSP(csp,
    // cspDirectives)` path (it builds its own fixed permissive CSP), so
    // without treating cspDirectives as hardening the configured
    // directives get silently dropped on the chatbox/preview surfaces
    // where host profiles are most meant to apply.
    //
    // Only count entries that contribute at least one token that would
    // survive the proxy's mergeDirective filter (trim, plus `;,\n\r"<>`
    // rejection — kept in lockstep with the predicate in
    // sandbox-proxy.html). An entry like `{ "frame-src": [] }` or
    // `{ "frame-src": [" "] }` is a semantic no-op and must not flip
    // a permissive surface into the resolver path (which would then
    // enforce the widget-declared CSP even though the named directive
    // contributes nothing).
    const cspDirectivesConfigured =
      sandboxCspPolicy?.cspDirectives !== undefined &&
      Object.values(sandboxCspPolicy.cspDirectives).some(
        (tokens) =>
          Array.isArray(tokens) &&
          tokens.some((t) => {
            if (typeof t !== "string") return false;
            const trimmed = t.trim();
            if (trimmed.length === 0) return false;
            if (/[;,\n\r"<>]/.test(trimmed)) return false;
            return true;
          }),
      );
    const hasExplicitCspHardening =
      restrictToConfigured || cspDirectivesConfigured || HOSTED_MODE;

    // Chatbox / Playground / minimal-mode surfaces opted into `permissive`
    // CSP up at line 285. Permissive means "default to permissive when the
    // host hasn't asked for tightening" — short-circuit the host CSP
    // resolver only when the saved profile carries NO explicit hardening
    // (restrictTo) and we're not in hosted mode. Otherwise fall through to
    // the resolver so the documented guarantees still hold even when the
    // surface is permissive-by-default:
    //   * restrictTo intersects whatever the resource declares
    //   * hosted clamp is non-bypassable (MCPJam-origin SDK-internal strip)
    //
    // Without this fall-through, a host could save `restrictTo:
    // { connectDomains: ["https://api.acme"] }` on its chatbox host and
    // the inspector would silently honor it on Connect → Chat but ignore
    // it on the public chatbox URL — a policy bypass tied to surface
    // type.
    //
    // Permissions policy still resolves below — it's orthogonal to CSP
    // and the chatbox-surface decision is specifically about content
    // loading, not device access.
    if (cspMode === "permissive" && !hasExplicitCspHardening) {
      let resolvedPermissions: McpUiResourcePermissions | undefined;
      if (sandboxPermissionsPolicy) {
        const resourcePermsMap: Record<string, boolean> = {};
        if (widgetPermissions && typeof widgetPermissions === "object") {
          for (const [k, v] of Object.entries(
            widgetPermissions as Record<string, unknown>,
          )) {
            if (v) resourcePermsMap[k] = true;
          }
        }
        const resolved = resolveSandboxPermissions({
          resourcePermissions: resourcePermsMap,
          policy: sandboxPermissionsPolicy,
          hostedMode: HOSTED_MODE,
        });
        const out: Record<string, Record<string, never>> = {};
        for (const name of Object.keys(resolved.granted)) {
          out[name] = {};
        }
        resolvedPermissions = out as McpUiResourcePermissions;
      }
      return {
        csp: undefined,
        permissions: resolvedPermissions ?? widgetPermissions,
        permissive: true,
        hostPolicyApplied: !!resolvedPermissions,
        sandboxAttrs: sandboxAttrsPolicy,
        allowFeatures: allowFeaturesPolicy,
        cspDirectives: cspDirectivesEffective,
      };
    }

    // "relaxed" CSP mode is an explicit dev escape hatch. The resolver
    // can't represent "no restrictions" as a domain list (CSP allow-
    // lists can't carry `*` without inviting the hosted clamp to strip
    // it), so PURE relaxed (no restrictTo, not hosted) short-circuits
    // the resolver and emits no CSP — preserves the dev experience.
    //
    // Any tightening signal — restrictTo or hostedMode — falls through
    // INTO the resolver so the documented guarantees hold:
    //   * "restrictTo applies in every mode" — intersects in every mode
    //   * "hosted clamp is non-bypassable" — the MCPJam-origin SDK-
    //     internal strip must run in hosted mode regardless of saved profile
    //
    // The previous shape (`if (sandboxCspPolicy && !isRelaxedCsp)`)
    // skipped the resolver entirely on mode==="relaxed". A hosted user
    // could save a relaxed profile and silently opt out of the hosted
    // clamp's MCPJam-origin strip — P1 in production.
    const isPureRelaxedCsp =
      sandboxCspPolicy?.mode === "relaxed" &&
      !restrictToConfigured &&
      !cspDirectivesConfigured &&
      !HOSTED_MODE;

    let resolvedCsp: McpUiResourceCsp | undefined;
    if (sandboxCspPolicy && !isPureRelaxedCsp) {
      const resolved = resolveSandboxCsp({
        resourceCsp: widgetCsp,
        policy: sandboxCspPolicy,
        // "host-default" mode falls back to an EMPTY allowlist inside
        // the resolver when `hostDefaultBaseline` is omitted (per
        // SEP-1865 secure-default). For the inspector, the only sensible
        // default baseline we have is the resource's own declaration —
        // passing it here means "host-default" is restrictive only as
        // much as the resource itself asked for (never more, possibly
        // less if restrictTo narrows it). Without this, picking
        // "host-default" would silently emit `connect-src 'none'` and
        // break any widget that fetches external assets.
        hostDefaultBaseline: widgetCsp,
        hostedMode: HOSTED_MODE,
        // Defense in depth: in hosted mode strip any widget-declared
        // domain matching MCPJam's own app/API origins. A hosted widget
        // that declares `https://app.mcpjam.com/api/...` in
        // connectDomains could otherwise use the iframe as an
        // exfiltration channel via the user's authenticated session.
        // The list is hardcoded here (and not in the SDK) because
        // "which origins count as MCPJam" is an inspector concern, not
        // a shared SDK concern; the SDK just enforces what we pass.
        // Wildcard pattern strips all subdomains incl. staging/api.
        hostedClampExtraDeny: HOSTED_MODE
          ? {
              // Spread the readonly constant into mutable arrays — the
              // SDK's `SandboxCspDomainSet` shape declares them as
              // `string[]`. Spreading per directive avoids accidental
              // aliasing if the SDK ever mutates internally.
              connectDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
              resourceDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
              frameDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
              baseUriDomains: [...MCPJAM_HOSTED_CLAMP_ORIGINS],
            }
          : undefined,
      });
      resolvedCsp = {
        connectDomains: resolved.connectDomains,
        resourceDomains: resolved.resourceDomains,
        frameDomains: resolved.frameDomains,
        baseUriDomains: resolved.baseUriDomains,
      };
    }
    let resolvedPermissions: McpUiResourcePermissions | undefined;
    if (sandboxPermissionsPolicy) {
      const resourcePermsMap: Record<string, boolean> = {};
      if (widgetPermissions && typeof widgetPermissions === "object") {
        for (const [k, v] of Object.entries(
          widgetPermissions as Record<string, unknown>,
        )) {
          // SEP-1865 declares each permission as an empty object (`{}`)
          // when requested — i.e. a truthy value. Older shape gated on
          // `v !== undefined && v !== null` which would also accept
          // `false` / `0` / `""` and silently coerce them to GRANTED.
          // Tighten to a truthiness check so a malformed widget that
          // declares `{ camera: false }` doesn't end up with camera
          // granted in the resolved permission set.
          if (v) resourcePermsMap[k] = true;
        }
      }
      const resolved = resolveSandboxPermissions({
        resourcePermissions: resourcePermsMap,
        policy: sandboxPermissionsPolicy,
        hostedMode: HOSTED_MODE,
      });
      const out: Record<string, Record<string, never>> = {};
      for (const name of Object.keys(resolved.granted)) {
        out[name] = {};
      }
      resolvedPermissions = out as McpUiResourcePermissions;
    }
    const hostPolicyApplied =
      !!resolvedCsp || !!resolvedPermissions || isPureRelaxedCsp;
    return {
      // Pure relaxed → no CSP at all (caller's `permissive: true` below
      // tells SandboxedIframe to skip CSP injection). Otherwise pass
      // the resolver output through, falling back to the widget's own
      // derivation when no host CSP policy is in force.
      csp: isPureRelaxedCsp
        ? undefined
        : (resolvedCsp ?? (widgetPermissive ? undefined : widgetCsp)),
      permissions: resolvedPermissions ?? widgetPermissions,
      // A host-applied CSP MUST be honored at the browser layer. When
      // a restrictive host policy is in force, force `permissive: false`
      // so the SandboxedIframe injects the meta-CSP. In pure-relaxed
      // mode the host policy is "permissive on purpose" → force
      // `permissive: true` so the iframe doesn't inject any meta-CSP
      // at all. Without host-side CSP policy, pass the widget-derived
      // flag through.
      //
      // Gate ONLY on `resolvedCsp` (not `resolvedPermissions`): a
      // permissions-only profile (e.g. `mode: "deny-all"` for camera/
      // mic) used to flip `permissive: false` while `csp` stayed
      // undefined, which the sandbox proxy interprets as the SEP-1865
      // secure-default CSP (`default-src 'none'`, `connect-src 'none'`)
      // — silently breaking network access for permissive widgets.
      // Permissions and CSP are orthogonal user-facing knobs; tweaking
      // one must not reshape the other.
      permissive: isPureRelaxedCsp
        ? true
        : resolvedCsp
          ? false
          : widgetPermissive,
      hostPolicyApplied,
      sandboxAttrs: sandboxAttrsPolicy,
      allowFeatures: allowFeaturesPolicy,
      cspDirectives: cspDirectivesEffective,
    };
  }, [
    cspMode,
    sandboxCspPolicy,
    sandboxPermissionsPolicy,
    widgetCsp,
    widgetPermissions,
    widgetPermissive,
    sandboxAttrsPolicy,
    allowFeaturesPolicy,
    cspDirectivesEffective,
  ]);

  useEffect(() => {
    onSendFollowUpRef.current = onSendFollowUp;
    onCallToolRef.current = onCallTool;
    onRequestPipRef.current = onRequestPip;
    onExitPipRef.current = onExitPip;
    setDisplayModeRef.current = setDisplayMode;
    isPlaygroundActiveRef.current = isPlaygroundActive;
    playgroundDeviceTypeRef.current = playgroundDeviceType;
    effectiveDisplayModeRef.current = effectiveDisplayMode;
    serverIdRef.current = serverId;
    toolCallIdRef.current = toolCallId;
    pipWidgetIdRef.current = pipWidgetId;
    toolsMetadataRef.current = toolsMetadata;
    onModelContextUpdateRef.current = onModelContextUpdate;
    onAppSupportedDisplayModesChangeRef.current =
      onAppSupportedDisplayModesChange;
  }, [
    onSendFollowUp,
    onCallTool,
    onRequestPip,
    onExitPip,
    setDisplayMode,
    isPlaygroundActive,
    playgroundDeviceType,
    effectiveDisplayMode,
    serverId,
    toolCallId,
    pipWidgetId,
    toolsMetadata,
    onModelContextUpdate,
    onAppSupportedDisplayModesChange,
  ]);

  // ENFORCEMENT (live):
  // `effectiveHostCapabilities` (above) is the contract advertised in
  // ui/initialize, and the six chip-bound handlers below are only assigned
  // when their cap is present — so advertise and enforce stay in lockstep.
  // An unassigned `bridge.on*` slot causes the SDK to auto-respond to the
  // widget's RPC with a "method not supported" envelope, matching strict
  // host behavior.
  //   • bridge.onopenlink            ← effectiveHostCapabilities.openLinks
  //   • bridge.onmessage             ← effectiveHostCapabilities.message
  //   • bridge.onupdatemodelcontext  ← effectiveHostCapabilities.updateModelContext
  //   • bridge.oncalltool            ← effectiveHostCapabilities.serverTools
  //   • bridge.onreadresource /
  //     onlistresources /
  //     onlistresourcetemplates      ← effectiveHostCapabilities.serverResources
  //   • bridge.onloggingmessage      ← effectiveHostCapabilities.logging
  //
  // Intentionally unconditional (no chip / not capability-negotiated in
  // SEP-1865):
  //   • bridge.oninitialized         — handshake plumbing
  //   • bridge.onsizechange          — iframe resize is host-shell infra
  //   • bridge.onrequestdisplaymode  — request acceptance is always OK;
  //                                    the spec governs which modes are
  //                                    granted, not whether requests reply
  //   • bridge.onlistprompts         — no serverPrompts cap exists yet
  //   • handleUploadFile / GetFileDownloadUrl
  //                                  — gated by a separate `downloadFile`
  //                                    cap that no template advertises and
  //                                    no chip surfaces today
  const registerBridgeHandlers = useCallback(
    (bridge: AppBridge) => {
      bridge.oninitialized = () => {
        const wasReady = isReadyRef.current;
        setIsReady(true);
        isReadyRef.current = true;
        const appCaps = bridge.getAppCapabilities();
        logWidgetDebug("ui-to-host", "debug/app-initialized", {
          availableDisplayModes:
            (appCaps?.availableDisplayModes as DisplayMode[] | undefined) ??
            null,
          wasReady,
        });
        onAppSupportedDisplayModesChangeRef.current?.(
          appCaps?.availableDisplayModes as DisplayMode[] | undefined,
        );
        // If the guest re-initialized (e.g. an SDK-based app completing its
        // own handshake after the openai-compat shim already initialized),
        // bump reinitCount so the delivery effects re-send tool data.
        if (wasReady) {
          setReinitCount((c) => c + 1);
        }
      };

      if (effectiveHostCapabilities.message) {
        bridge.onmessage = async ({ content }) => {
          const textContent = content.find(
            (item) => item.type === "text",
          )?.text;
          if (textContent) {
            onSendFollowUpRef.current?.(textContent);
          }
          return {};
        };
      }

      if (effectiveHostCapabilities.openLinks) {
        bridge.onopenlink = async ({ url }) => {
          if (url) {
            window.open(url, "_blank", "noopener,noreferrer");
          }
          return {};
        };
      }

      if (effectiveHostCapabilities.serverTools) {
        bridge.oncalltool = async ({ name, arguments: args }, _extra) => {
          // Check if tool is model-only (not callable by apps) per SEP-1865
          const calledToolMeta = toolsMetadataRef.current?.[name];
          if (isVisibleToModelOnly(calledToolMeta)) {
            const error = new Error(
              `Tool "${name}" is not callable by apps (visibility: model-only)`,
            );
            bridge.sendToolCancelled({ reason: error.message });
            throw error;
          }

          if (!onCallToolRef.current) {
            const error = new Error("Tool calls not supported");
            bridge.sendToolCancelled({ reason: error.message });
            throw error;
          }

          try {
            const result = await onCallToolRef.current(
              name,
              (args ?? {}) as Record<string, unknown>,
            );
            return result as CallToolResult;
          } catch (error) {
            // SEP-1865: Send tool-cancelled for failed app-initiated tool calls
            bridge.sendToolCancelled({
              reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        };
      }

      if (effectiveHostCapabilities.serverResources) {
        bridge.onreadresource = async ({ uri }) => {
          const result = await readResource(serverIdRef.current, uri);
          return result.content;
        };

        bridge.onlistresources = async (params) => {
          return listResources(
            serverIdRef.current,
            (params as { cursor?: string } | undefined)?.cursor,
          );
        };

        bridge.onlistresourcetemplates = async (_params) => {
          if (HOSTED_MODE) {
            throw new Error(
              "Resource templates are not supported in hosted mode",
            );
          }

          const response = await authFetch(
            `/api/mcp/resource-templates/list`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                serverId: serverIdRef.current,
              }),
            },
          );
          if (!response.ok) {
            throw new Error(
              `Resource template list failed: ${response.statusText}`,
            );
          }
          return response.json();
        };
      }

      // onlistprompts: unconditional — no serverPrompts cap in SEP-1865 or
      // the chip set. Revisit if/when a serverPrompts chip is added.
      bridge.onlistprompts = async (params) => {
        void params;
        const prompts = await listPrompts(serverIdRef.current);
        return { prompts };
      };

      if (effectiveHostCapabilities.logging) {
        bridge.onloggingmessage = ({ level, data, logger }) => {
          if (minimalMode) return;
          const prefix = logger ? `[${logger}]` : "[MCP Apps]";
          const message = `${prefix} ${level.toUpperCase()}:`;
          if (level === "error" || level === "critical" || level === "alert") {
            console.error(message, data);
            return;
          }
          if (level === "warning") {
            console.warn(message, data);
            return;
          }
          console.info(message, data);
        };
      }

      // Width resize handling was removed here — previously this destructured
      // `width` and applied it to the iframe via `min(${width}px, 100%)`.
      // Only height-based auto-resize is applied; width is host-controlled.
      bridge.onsizechange = ({ height }) => {
        if (effectiveDisplayModeRef.current !== "inline") return;
        const iframe = sandboxRef.current?.getIframeElement();
        if (!iframe || height === undefined) return;

        // The MCP App has requested a `height`, but if
        // `box-sizing: border-box` is applied to the outer iframe element, then we
        // must add border thickness to `height` to compute the actual
        // necessary height (in order to prevent a resize feedback loop).
        const style = getComputedStyle(iframe);
        const isBorderBox = style.boxSizing === "border-box";

        // Animate the change for a smooth transition.
        const from: Keyframe = {};
        const to: Keyframe = {};

        let adjustedHeight = height;

        if (adjustedHeight !== undefined) {
          if (isBorderBox) {
            adjustedHeight +=
              parseFloat(style.borderTopWidth) +
              parseFloat(style.borderBottomWidth);
          }
          from.height = `${iframe.offsetHeight}px`;
          iframe.style.height = to.height = `${adjustedHeight}px`;
          lastInlineHeightRef.current = `${adjustedHeight}px`;
        }

        iframe.animate([from, to], { duration: 300, easing: "ease-out" });
        // size-changed fires on every resize/animation tick — chatty widgets
        // can flood the traffic log. The corresponding ui/notifications/
        // size-changed transport message is already suppressed above; rely on
        // that for diagnostics rather than a host-side debug log here.
      };

      bridge.onrequestdisplaymode = async ({ mode }) => {
        const requestedMode = mode ?? "inline";
        const hostAvailableModes = extractHostDisplayModes(
          hostContextRef.current as Record<string, unknown> | undefined,
        );
        // Use device type for mobile detection (defaults to mobile-like behavior when not in playground)
        const isMobile = isPlaygroundActiveRef.current
          ? playgroundDeviceTypeRef.current === "mobile" ||
            playgroundDeviceTypeRef.current === "tablet"
          : true;
        const mobileAdjustedMode: DisplayMode =
          isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;
        const actualMode = clampDisplayModeToAvailableModes(
          mobileAdjustedMode,
          hostAvailableModes,
        );

        setDisplayModeRef.current(actualMode);

        if (actualMode === "pip") {
          onRequestPipRef.current?.(toolCallIdRef.current);
        } else if (
          (actualMode === "inline" || actualMode === "fullscreen") &&
          pipWidgetIdRef.current === toolCallIdRef.current
        ) {
          onExitPipRef.current?.(toolCallIdRef.current);
        }

        return { mode: actualMode };
      };

      if (effectiveHostCapabilities.updateModelContext) {
        bridge.onupdatemodelcontext = async ({
          content,
          structuredContent,
        }) => {
          // Store in debug store for UI display
          setWidgetModelContext(toolCallId, {
            content,
            structuredContent,
          });

          // Notify parent component to queue for next model turn
          onModelContextUpdateRef.current?.(toolCallId, {
            content,
            structuredContent,
          });

          return {};
        };
      }
    },
    [
      setIsReady,
      toolCallId,
      setWidgetModelContext,
      logWidgetDebug,
      effectiveHostCapabilities,
    ],
  );

  useEffect(() => {
    if (!widgetHtml) return;
    if (!sandboxProxyReady) {
      logWidgetDebug("host-to-ui", "debug/bridge-connect-skipped", {
        reason: "sandbox-proxy-not-ready",
      });
      return;
    }
    const iframe = sandboxRef.current?.getIframeElement();
    if (!iframe?.contentWindow) {
      logWidgetDebug("host-to-ui", "debug/bridge-connect-skipped", {
        reason: "missing-iframe-content-window",
      });
      return;
    }

    setBridgeTransportReady(false);
    setIsReady(false);
    isReadyRef.current = false;
    logWidgetDebug("host-to-ui", "debug/bridge-connect-start", {
      cspMode,
      // Reflect the resolved (host-policy-applied) sandbox so the debug
      // panel matches what the iframe and bridge will actually see.
      hasCsp: !!effectiveSandbox.csp,
      hasPermissions: !!effectiveSandbox.permissions,
      htmlLength: widgetHtml.length,
      permissive: effectiveSandbox.permissive,
      hostPolicyApplied: effectiveSandbox.hostPolicyApplied,
      toolState: toolState ?? null,
    });

    // Sandbox policy is resolved once at component scope (see
    // `effectiveSandbox` above) and reused here so the AppBridge handshake
    // and the rendered <SandboxedIframe> stay in lockstep. Computing this
    // inline used to be the canonical correctness bug: the bridge got the
    // resolved policy while the iframe still got the raw resource
    // declaration, so the browser-enforced CSP didn't honor the host clamp.
    // Host identity advertised in ui/initialize. Templates that emulate
    // another host (e.g. ChatGPT) override this via
    // `mcpProfile.apps.uiInitialize.hostInfo`; backend soft-validates
    // name+version when set so the cast below is safe.
    const resolvedHostInfo = (resolveHostInfo(activeMcpProfile) ?? {
      name: "mcpjam-inspector",
      version: __APP_VERSION__,
    }) as { name: string; version: string };
    const bridge = new AppBridge(
      null,
      resolvedHostInfo,
      {
        ...effectiveHostCapabilities,
        sandbox: {
          csp: effectiveSandbox.csp,
          permissions: effectiveSandbox.permissions,
        },
      },
      { hostContext: hostContextRef.current ?? {} },
    );

    registerBridgeHandlers(bridge);
    bridgeRef.current = bridge;

    const transport = new LoggingTransport(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
      {
        onSend: (message) => {
          const method = extractMethod(message, "mcp-apps");
          if (SUPPRESSED_UI_LOG_METHODS.has(method)) return;
          logUiEvent({
            widgetId: toolCallId,
            serverId,
            direction: "host-to-ui",
            protocol: "mcp-apps",
            method,
            message,
          });
        },
        onReceive: (message) => {
          const method = extractMethod(message, "mcp-apps");
          if (method === "ui/notifications/size-changed") {
            signalStreamingRender();
          }
          if (SUPPRESSED_UI_LOG_METHODS.has(method)) return;
          logUiEvent({
            widgetId: toolCallId,
            serverId,
            direction: "ui-to-host",
            protocol: "mcp-apps",
            method,
            message,
          });
        },
      },
    );

    let isActive = true;
    bridge
      .connect(transport)
      .then(() => {
        if (!isActive) return;
        setBridgeTransportReady(true);
        logWidgetDebug("host-to-ui", "debug/bridge-connect-ready", {
          htmlLength: widgetHtml.length,
        });
      })
      .catch((error) => {
        if (!isActive) return;
        const errorMessage =
          error instanceof Error ? error.message : "Failed to connect MCP App";
        setLoadError(errorMessage);
        logWidgetDebug("host-to-ui", "debug/bridge-connect-error", {
          error: errorMessage,
        });
      });

    return () => {
      isActive = false;
      logWidgetDebug("host-to-ui", "debug/bridge-connect-cleanup", {
        wasReady: isReadyRef.current,
      });
      bridgeRef.current = null;
      if (isReadyRef.current) {
        bridge.teardownResource({}).catch(() => {});
      }
      bridge.close().catch(() => {});
      // Clear model context on widget teardown
      setWidgetModelContext(toolCallId, null);
    };
  }, [
    logUiEvent,
    minimalMode,
    serverId,
    toolCallId,
    widgetHtml,
    sandboxProxyReady,
    registerBridgeHandlers,
    setWidgetModelContext,
    cspMode,
    // Bridge must rebuild when the resolved sandbox policy changes — a host
    // toggling sandbox policy at runtime needs the new handshake. The memo
    // identity captures `widgetCsp`/`widgetPermissions`/`widgetPermissive`
    // and the sandbox slice of mcpProfile transitively.
    effectiveSandbox,
    logWidgetDebug,
    // Bridge must rebuild when the advertised host capabilities change
    // (host style switch or override edit) so the new handshake reflects
    // the new contract.
    effectiveHostCapabilities,
    // Bridge must rebuild when the host identity advertised in
    // ui/initialize changes — switching to a template that overrides
    // hostInfo (e.g. ChatGPT) is observable to the View.
    activeMcpProfile,
  ]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !isReady) return;
    bridge.setHostContext(hostContext);
  }, [hostContext, isReady]);

  const handleCspViolation = useCallback(
    (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;

      const {
        directive,
        blockedUri,
        sourceFile,
        lineNumber,
        columnNumber,
        effectiveDirective,
        timestamp,
      } = data;

      logUiEvent({
        widgetId: toolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: "csp-violation",
        message: data,
      });

      addCspViolation(toolCallId, {
        directive,
        effectiveDirective,
        blockedUri,
        sourceFile,
        lineNumber,
        columnNumber,
        timestamp: timestamp || Date.now(),
      });

      if (!minimalMode) {
        console.warn(
          `[MCP Apps CSP Violation] ${directive}: Blocked ${blockedUri}`,
          sourceFile ? `at ${sourceFile}:${lineNumber}:${columnNumber}` : "",
        );
      }
    },
    [addCspViolation, logUiEvent, minimalMode, serverId, toolCallId],
  );

  const handleSandboxMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data) return;

    // Handle CSP violation messages (custom type)
    if (data.type === "mcp-apps:csp-violation") {
      handleCspViolation(event);
      return;
    }

    // Handle file upload messages (non-JSON-RPC, same protocol as ChatGPT widget)
    if (data.type === "openai:uploadFile") {
      void handleUploadFileMessage(data, (message) => {
        sandboxRef.current?.postMessage(message);
      });
      return;
    }

    if (data.type === "openai:getFileDownloadUrl") {
      handleGetFileDownloadUrlMessage(data, (message) => {
        sandboxRef.current?.postMessage(message);
      });
      return;
    }

    // Apps SDK widget-state persistence (forwarded from the compat
    // runtime in the inner iframe). Two destinations:
    //   1) onWidgetStateChange — propagates upward for saved-view /
    //      replay / fork persistence (matches the legacy
    //      ChatGPTAppRenderer contract).
    //   2) setWidgetStateStore — keeps the Debug "Widget State" panel
    //      live; without it, Apps SDK setWidgetState updates silently
    //      bypass the diagnostics surface that reads from
    //      widgetDebugInfo.widgetState.
    if (data.type === "openai:setWidgetState") {
      if (onWidgetStateChange) {
        onWidgetStateChange(toolCallId, data.state);
      }
      setWidgetStateStore(toolCallId, data.state);
      return;
    }

    // Handle openai/* JSON-RPC notifications from the compat layer
    if (
      data.jsonrpc === "2.0" &&
      typeof data.method === "string" &&
      data.method.startsWith("openai/")
    ) {
      logUiEvent({
        widgetId: toolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: data.method,
        message: data,
      });

      if (data.method === "openai/requestModal") {
        const params = data.params ?? {};
        setModalTitle(params.title || "Modal");
        setModalParams(params.params || {});
        setModalTemplate(params.template || null);
        setModalOpen(true);
      } else if (data.method === "openai/requestClose") {
        setModalOpen(false);
      } else if (data.method === "openai/requestCheckout") {
        const params = data.params ?? {};
        const { callId: cId, ...sessionData } = params;
        setCheckoutCallId(cId as number);
        setCheckoutSession(sessionData as unknown as CheckoutSession);
        setCheckoutOpen(true);
      }
    }
  };
  const showWidget = isReady && canRenderStreamingInput;

  useEffect(() => {
    logWidgetDebug("host-to-ui", "debug/widget-visibility", {
      bridgeTransportReady,
      canRenderStreamingInput,
      hasWidgetHtml,
      isReady,
      loadError,
      showWidget,
      toolState: toolState ?? null,
      widgetHtmlLength,
    });
  }, [
    bridgeTransportReady,
    canRenderStreamingInput,
    hasWidgetHtml,
    isReady,
    loadError,
    showWidget,
    toolState,
    widgetHtmlLength,
    logWidgetDebug,
  ]);

  useEffect(() => {
    if (!bridgeTransportReady || !widgetHtml) return;
    logWidgetDebug("host-to-ui", "debug/sandbox-html-ready", {
      hasCsp: !!effectiveSandbox.csp,
      hasPermissions: !!effectiveSandbox.permissions,
      htmlLength: widgetHtml.length,
      permissive: effectiveSandbox.permissive,
      hostPolicyApplied: effectiveSandbox.hostPolicyApplied,
    });
  }, [
    bridgeTransportReady,
    widgetHtml,
    effectiveSandbox,
    logWidgetDebug,
  ]);

  const respondToCheckout = useCallback(
    (result: unknown, error?: string) => {
      if (checkoutCallId == null) return;
      const params: Record<string, unknown> = { callId: checkoutCallId };
      if (error) {
        params.error = error;
      } else {
        params.result = result;
      }
      sandboxRef.current?.postMessage({
        jsonrpc: "2.0",
        method: "openai/requestCheckout:response",
        params,
      });
      setCheckoutOpen(false);
      setCheckoutSession(null);
      setCheckoutCallId(null);
    },
    [checkoutCallId],
  );

  // Denied state
  if (toolState === "output-denied") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Tool execution was denied.
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
        Failed to load MCP App: {loadError}
      </div>
    );
  }

  if (!widgetHtml) {
    return null;
  }

  const isPip = effectiveDisplayMode === "pip";
  const isFullscreen = effectiveDisplayMode === "fullscreen";
  const isMobilePlaygroundMode =
    isPlaygroundActive && playgroundDeviceType === "mobile";
  const isContainedFullscreenMode =
    isPlaygroundActive &&
    (playgroundDeviceType === "mobile" || playgroundDeviceType === "tablet");

  const containerClassName = (() => {
    if (isFullscreen) {
      if (isContainedFullscreenMode) {
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      return "fixed inset-0 z-40 w-full h-full bg-background flex flex-col";
    }

    if (isPip) {
      if (isMobilePlaygroundMode) {
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      if (isPlaygroundActive) {
        return [
          "absolute top-4 left-1/2 -translate-x-1/2 z-40 w-full min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
          "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
          "shadow-xl border border-border/60 rounded-xl p-3",
        ].join(" ");
      }
      return [
        "fixed top-4 left-1/2 -translate-x-1/2 z-40 w-full min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
        "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "shadow-xl border border-border/60 rounded-xl p-3",
      ].join(" ");
    }

    return "mt-3 space-y-2 relative group";
  })();

  const canTransitionHeight =
    !isFullscreen &&
    effectiveDisplayModeRef.current === effectiveDisplayMode;
  const iframeStyle: CSSProperties = {
    height: isFullscreen
      ? "100%"
      : isPip
        ? PIP_MAX_HEIGHT
        : lastInlineHeightRef.current,
    width: "100%",
    maxWidth: "100%",
    backgroundColor:
      !isFullscreen && prefersBorder
        ? mergedStyleVariables["--color-background-primary"]
        : (hostChatBackground ?? "transparent"),
    opacity: showWidget ? 1 : 0,
    transition: [
      "opacity 150ms ease-in",
      canTransitionHeight ? "height 300ms ease-out" : "",
    ]
      .filter(Boolean)
      .join(", "),
    // Keep iframe in the layout but invisible while not ready
    ...(!showWidget
      ? { position: "absolute" as const, pointerEvents: "none" as const }
      : {}),
  };
  const hostChromeStyle: CSSProperties | undefined =
    !isFullscreen && prefersBorder
      ? {
          backgroundColor: mergedStyleVariables["--color-background-primary"],
        }
      : undefined;
  const iframe = (
    <SandboxedIframe
      ref={sandboxRef}
      html={bridgeTransportReady ? widgetHtml : null}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      // Browser-enforced CSP / Permission Policy MUST receive the resolved
      // values, not the raw resource declaration. `effectiveSandbox` runs the
      // shared resolver (mode → restrictTo intersect → hosted-mode clamp);
      // when a host policy applies it forces
      // `permissive: false` so SandboxedIframe injects the meta-CSP rather
      // than skipping it. Passing `widgetCsp` here directly is the canonical
      // regression — keep the resolver path.
      csp={effectiveSandbox.csp}
      permissions={effectiveSandbox.permissions}
      permissive={effectiveSandbox.permissive}
      sandboxAttrs={effectiveSandbox.sandboxAttrs}
      allowFeatures={effectiveSandbox.allowFeatures}
      cspDirectives={effectiveSandbox.cspDirectives}
      colorScheme={resolvedTheme}
      onProxyReady={() => {
        setSandboxProxyReady(true);
        logWidgetDebug("ui-to-host", "debug/sandbox-proxy-ready", {
          bridgeTransportReady,
          hasWidgetHtml,
        });
      }}
      onMessage={handleSandboxMessage}
      title={`MCP App: ${toolName}`}
      className={`bg-transparent overflow-hidden ${
        isFullscreen
          ? "flex-1 border-0 rounded-none"
          : `rounded-md ${prefersBorder ? "border border-border/40" : ""}`
      }`}
      style={iframeStyle}
    />
  );

  return (
    <div className={containerClassName}>

      {((isFullscreen && isContainedFullscreenMode) ||
        (isPip && isMobilePlaygroundMode)) && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            if (isPip) {
              onExitPip?.(toolCallId);
            }
            // onExitFullscreen is called within setDisplayMode when leaving fullscreen
          }}
          className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/20 hover:bg-black/40 text-white transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      {isFullscreen && !isContainedFullscreenMode && (
        <div className="flex items-center justify-between px-4 h-14 border-b border-border/40 bg-background/95 backdrop-blur z-40 shrink-0">
          <div />
          <div className="font-medium text-sm text-muted-foreground">
            {toolName}
          </div>
          <button
            onClick={() => {
              setDisplayMode("inline");
              if (pipWidgetId === toolCallId) {
                onExitPip?.(toolCallId);
              }
            }}
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Exit fullscreen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {isPip && !isMobilePlaygroundMode && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            onExitPip?.(toolCallId);
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close PiP mode"
          title="Close PiP mode"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {/* Uses SandboxedIframe for DRY double-iframe architecture */}
      {!isFullscreen && prefersBorder ? (
        <div
          data-testid="mcp-app-host-chrome"
          className="rounded-md"
          style={hostChromeStyle}
        >
          {iframe}
        </div>
      ) : (
        iframe
      )}

      <McpAppsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={modalTitle}
        template={modalTemplate}
        params={modalParams}
        registerBridgeHandlers={registerBridgeHandlers}
        // The modal mounts its own SandboxedIframe via `fetchMcpAppsWidgetContent`.
        // Pass the resolved values so the modal's CSP enforcement matches the
        // inline iframe — otherwise a host restrictTo intersection applies to
        // inline but not to a modal-mode widget reading the same resource.
        widgetCsp={effectiveSandbox.csp}
        widgetPermissions={effectiveSandbox.permissions}
        widgetPermissive={effectiveSandbox.permissive}
        widgetSandboxAttrs={effectiveSandbox.sandboxAttrs}
        widgetAllowFeatures={effectiveSandbox.allowFeatures}
        widgetCspDirectives={effectiveSandbox.cspDirectives}
        hostContextRef={hostContextRef}
        serverId={serverId}
        resourceUri={resourceUri}
        toolCallId={toolCallId}
        toolName={toolName}
        cspMode={cspMode}
        toolInputRef={toolInputRef}
        toolOutputRef={toolOutputRef}
        themeModeRef={themeModeRef}
        addUiLog={(log) =>
          logUiEvent({
            ...log,
            protocol: "mcp-apps" as UiProtocol,
          })
        }
        onCspViolation={handleCspViolation}
      />

      {checkoutSession && (
        <CheckoutDialogV2
          session={checkoutSession}
          open={checkoutOpen}
          onOpenChange={setCheckoutOpen}
          onComplete={(result) => respondToCheckout(result)}
          onError={(error) => respondToCheckout(null, error)}
          onCancel={() => respondToCheckout(null, "User cancelled checkout")}
          onCallTool={async (toolName, params) => {
            if (!onCallTool) {
              throw new Error("Tool calls not supported");
            }
            return onCallTool(toolName, params);
          }}
        />
      )}
    </div>
  );
}
