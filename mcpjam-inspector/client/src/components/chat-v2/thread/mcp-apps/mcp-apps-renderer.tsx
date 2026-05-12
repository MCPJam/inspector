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
} from "@/lib/host-styles";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/mcp-apps-utils";
import { LoggingTransport } from "./mcp-apps-logging-transport";
import { McpAppsModal } from "./mcp-apps-modal";
import {
  handleGetFileDownloadUrlMessage,
  handleUploadFileMessage,
} from "./widget-file-messages";
import { CheckoutDialogV2 } from "./checkout-dialog-v2";
import { fetchMcpAppsWidgetContent } from "./fetch-widget-content";
import type { CheckoutSession } from "@/shared/acp-types";
import { listResources, readResource } from "@/lib/apis/mcp-resources-api";
import { listPrompts } from "@/lib/apis/mcp-prompts-api";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-host-style-context";
import { useChatboxHostCapabilitiesOverride } from "@/contexts/chatbox-host-capabilities-override-context";
import { useChatboxMcpProfile } from "@/contexts/chatbox-mcp-profile-context";
import {
  cspDomainSetHasEntries,
  resolveSandboxCsp,
  resolveSandboxPermissions,
} from "@/lib/sandbox-policy";
import { useHostContextStore } from "@/stores/host-context-store";
import {
  clampDisplayModeToAvailableModes,
  extractHostDisplayMode,
  extractHostDisplayModes,
  extractHostTheme,
} from "@/lib/client-config";
import { resolveEffectiveHostCapabilities } from "@/lib/host-config-v2";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

// Default input schema for tools without metadata
const DEFAULT_INPUT_SCHEMA = { type: "object" } as const;

const SUPPRESSED_UI_LOG_METHODS = new Set(["ui/notifications/size-changed"]);
const PIP_MAX_HEIGHT = "min(40vh, 600px)";

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
  ...Object.keys(DEFAULT_HOST_STYLE.resolveStyleVariables("light")),
  ...Object.keys(DEFAULT_HOST_STYLE.resolveStyleVariables("dark")),
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
  toolErrorText,
  resourceUri,
  toolMetadata,
  toolsMetadata,
  onSendFollowUp,
  onCallTool,
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
  minimalMode = false,
}: MCPAppsRendererProps) {
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const sharedHostStyle = usePreferencesStore((s) => s.hostStyle);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const hostCapabilitiesOverride = useChatboxHostCapabilitiesOverride();
  // Active hostConfig's mcpProfile (clientInfo, supported protocol versions,
  // sandbox policy). Used below to resolve the effective CSP layers so the
  // CSP debug overlay can show baseline → restrictTo → deny → hosted clamp
  // → effective. Actual *enforcement* of restrictTo/deny in the iframe's
  // injected CSP header is a follow-up — today the renderer still hands the
  // widget-declared CSP to `fetchMcpAppsWidgetContent` unchanged. The
  // debug-store update below uses the resolver output so the overlay
  // reflects the post-feature contract.
  const mcpProfile = useChatboxMcpProfile();
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
  const cspMode: CspMode = isPlaygroundActive
    ? playgroundCspMode
    : minimalMode
      ? "permissive"
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

        // Debug-store CSP+permissions update is handled by a separate
        // effect below — that way changing `mcpProfile` mid-session
        // refreshes the resolved overlay without forcing a widget HTML
        // refetch. The fetch effect just primes the component state
        // (widgetCsp / widgetPermissions / widgetPermissive); the
        // dedicated effect reacts to those plus mcpProfile.
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

  // Resolve the layered sandbox CSP whenever the widget's declared
  // CSP OR the active `mcpProfile` changes. Memoized so both the CSP
  // debug overlay (effect below) and the iframe enforcement props
  // (`csp={resolvedCsp}` / `permissions={resolvedPermissions}` on
  // SandboxedIframe) see the same resolved values. Without this
  // single source of truth, the overlay would show the post-profile
  // CSP while the iframe still enforced the raw widget-declared CSP
  // — a documented enforcement gap (Codex P1) where deny/restrict/
  // hosted-clamp rules would silently NOT apply at the iframe
  // boundary.
  const resolvedCspLayers = useMemo(() => {
    const resourceCsp = widgetCsp
      ? {
          connectDomains: widgetCsp.connectDomains,
          resourceDomains: widgetCsp.resourceDomains,
          frameDomains: widgetCsp.frameDomains,
          baseUriDomains: widgetCsp.baseUriDomains,
        }
      : undefined;
    return resolveSandboxCsp({
      resourceCsp,
      // Today the inspector's "renderer baseline" when no profile is
      // active IS the widget-declared CSP — that's what the
      // pre-profile iframe enforced. Passing it as hostDefaultCsp
      // gives `mode: "host-default"` parity with that legacy
      // behavior; otherwise selecting it would resolve to empty and
      // break every widget's network access. When the renderer ever
      // grows a separate preset baseline (e.g. an inspector-wide
      // CSP independent of the widget's declaration), wire it here.
      hostDefaultCsp: resourceCsp,
      // `relaxed` mode is the dev-convenience "permit everything"
      // baseline. We pass concrete wildcards (`*` per directive)
      // rather than `undefined` so selecting the mode produces a
      // working, permissive set instead of resolving to empty. In
      // hosted mode, the platform clamp strips these wildcards
      // back to a safe baseline regardless of user intent — so
      // `relaxed` is genuinely useful in local dev and not a
      // hosted-mode foot-gun.
      relaxedCsp: {
        connectDomains: ["*"],
        resourceDomains: ["*"],
        frameDomains: ["*"],
        baseUriDomains: ["*"],
      },
      isHostedMode: HOSTED_MODE,
      profile: mcpProfile,
    });
  }, [widgetCsp, mcpProfile]);

  // Resolved CSP shape the SandboxedIframe consumes. Mirrors the
  // widget-declared shape (`McpUiResourceCsp`-like) so the iframe
  // wiring doesn't have to branch on profile presence. When no
  // widget CSP and no profile narrowing, returns undefined to keep
  // pre-feature behavior (permissive iframe).
  const resolvedCsp = useMemo(() => {
    // Same "meaningful content" check as profileHasCsp — a bare
    // `csp: {}` from a payload outside the editor must NOT trigger
    // the resolver pipeline (it would produce empty-array directives
    // and the iframe would block all network access). Mirror the
    // editor's collapse-to-undefined rule here so wire-level payloads
    // and editor saves behave identically.
    const profileCspBlock = mcpProfile?.apps?.sandbox?.csp;
    const profileCspHasContent = Boolean(
      profileCspBlock &&
        (profileCspBlock.mode !== undefined ||
          cspDomainSetHasEntries(profileCspBlock.restrictTo) ||
          cspDomainSetHasEntries(profileCspBlock.deny) ||
          profileCspBlock.extensions !== undefined),
    );
    if (!widgetCsp && !profileCspHasContent) return undefined;
    const eff = resolvedCspLayers.effective;
    return {
      connectDomains: eff.connectDomains ?? [],
      resourceDomains: eff.resourceDomains ?? [],
      frameDomains: eff.frameDomains ?? [],
      baseUriDomains: eff.baseUriDomains ?? [],
    };
  }, [resolvedCspLayers, widgetCsp, mcpProfile]);

  // Resolved permissions for the iframe `allow=` attribute. Without
  // this, `permissions.mode: "deny-all"` and `permissions.deny`
  // entries in the profile would only show up in the debug overlay
  // while the iframe kept granting the resource-declared set.
  const resolvedPermissionsLayers = useMemo(() => {
    return resolveSandboxPermissions({
      resourcePermissions: widgetPermissions
        ? // McpUiResourcePermissions stores keys with empty-object
          // values to mean "requested"; flatten to boolean for the
          // resolver's ceiling check.
          Object.fromEntries(
            Object.keys(widgetPermissions).map((k) => [k, true]),
          )
        : undefined,
      isHostedMode: HOSTED_MODE,
      profile: mcpProfile,
    });
  }, [widgetPermissions, mcpProfile]);

  // Whether a host-level CSP policy is active. Gates `permissive`
  // ONLY on CSP — permissions are passed independently via the
  // iframe's `permissions=` prop, so a permissions-only profile
  // doesn't need to flip `permissive`. Without this narrowing, a
  // permissions-only profile would force `permissive=false` while
  // `resolvedCsp` is still `undefined` (because the resolver's
  // early-return at the `resolvedCsp` memo bails when there's no
  // widgetCsp AND no profile.apps.sandbox.csp), and SandboxedIframe
  // would fall back to a restrictive default CSP — inadvertently
  // breaking widget network access even though the user only
  // configured a permissions policy.
  //
  // When the profile sets CSP, the sandbox proxy treats
  // `permissive=true` as "skip CSP injection entirely," so we MUST
  // flip permissive to false there or the restrictTo / deny / clamp
  // rules silently bypass. Hosted chatboxes hit this every render
  // because `ChatTabV2`'s minimalMode wiring sets cspMode="permissive"
  // upstream, making `widgetPermissive=true` the default.
  // "Has CSP policy" means the profile's csp block carries at least
  // one meaningful field — `mode`, a non-empty `restrictTo` /
  // `deny`, or `extensions`. A bare `csp: {}` (which a payload from
  // outside the editor could carry — `normalizeMcpProfile` doesn't
  // strip empty inner blocks) MUST NOT count as policy, because
  // `resolvedCsp` then computes all-empty-array directives and the
  // iframe ends up with `permissive=false` + empty CSP, silently
  // blocking all widget network access.
  const profileCsp = mcpProfile?.apps?.sandbox?.csp;
  const profileHasCsp = Boolean(
    profileCsp &&
      (profileCsp.mode !== undefined ||
        cspDomainSetHasEntries(profileCsp.restrictTo) ||
        cspDomainSetHasEntries(profileCsp.deny) ||
        profileCsp.extensions !== undefined),
  );
  const effectivePermissive = profileHasCsp ? false : widgetPermissive;

  const resolvedPermissions = useMemo(() => {
    // Rebuild the McpUiResourcePermissions shape from the resolver's
    // effective boolean set, preserving the ORIGINAL value the
    // resource declared for each granted key (the type accepts
    // both `true` and `{}` markers; the iframe wrapper compares by
    // key presence). Substituting a synthetic `{}` would diverge
    // from what the resource sent (and from what existing call
    // sites assert in tests).
    const granted: Record<string, unknown> = {};
    for (const [key, allowed] of Object.entries(
      resolvedPermissionsLayers.effective,
    )) {
      if (!allowed) continue;
      // Prefer the original marker (true | {} | anything truthy)
      // from widgetPermissions when available; fall back to `true`
      // for keys the profile granted on its own.
      const original = (widgetPermissions as Record<string, unknown> | undefined)?.[key];
      granted[key] = original !== undefined ? original : true;
    }
    // Return undefined (NOT null) when no permissions remain after
    // resolution. SandboxedIframe and AppBridge prop types accept
    // `McpUiResourcePermissions | undefined`; preserving null here
    // would type-error those call sites. The empty-permissions
    // semantic ("no `allow=` attribute, SEP-1865 safe default") is
    // identical whether the source was widgetPermissions=null or
    // widgetPermissions=undefined.
    return Object.keys(granted).length > 0
      ? (granted as McpUiResourcePermissions)
      : undefined;
  }, [resolvedPermissionsLayers, widgetPermissions]);

  // Update the widget-debug-store entry whenever the resolved layers
  // change. Stays separate from the iframe enforcement so the overlay
  // can refresh without forcing the iframe to remount.
  useEffect(() => {
    if (!widgetCsp && !widgetPermissions && effectivePermissive) {
      // No CSP, no permissions, fully permissive — nothing to display
      // in the overlay; keep the store untouched so a previous entry
      // isn't clobbered by an empty one on remount.
      return;
    }
    setWidgetCspStore(toolCallId, {
      mode: effectivePermissive ? "permissive" : "widget-declared",
      connectDomains: resolvedCspLayers.effective.connectDomains || [],
      resourceDomains: resolvedCspLayers.effective.resourceDomains || [],
      frameDomains: resolvedCspLayers.effective.frameDomains || [],
      baseUriDomains: resolvedCspLayers.effective.baseUriDomains || [],
      permissions: resolvedPermissions ?? undefined,
      widgetDeclared: widgetCsp
        ? {
            connectDomains: widgetCsp.connectDomains,
            resourceDomains: widgetCsp.resourceDomains,
            frameDomains: widgetCsp.frameDomains,
            baseUriDomains: widgetCsp.baseUriDomains,
          }
        : null,
    });
    // setWidgetCspStore omitted from deps: it's a Zustand selector
    // pulling a fixed store-method (`s.setWidgetCsp`), so its
    // identity is stable across renders. Including it would be
    // valid (no TDZ — function-component const bindings exist by
    // the time effect callbacks fire), but pointless: the effect
    // would never re-run on its account, and the deps array
    // already covers every value the effect's body actually reads.
    // Same omission pattern as the fetch effect above.
  }, [
    widgetCsp,
    widgetPermissions,
    // `effectivePermissive`, NOT `widgetPermissive` — the body reads
    // the effective value (which depends on whether the profile has
    // saved policy), so listing `widgetPermissive` here would leave
    // the debug-store entry stale whenever the profile toggles its
    // sandbox block without touching widgetPermissive. Booleans
    // compare by value in deps, so this doesn't add render churn.
    effectivePermissive,
    resolvedCspLayers,
    resolvedPermissions,
    toolCallId,
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
      widgetState: null, // MCP Apps don't have widget state in the same way
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
  // value into the handshake; `registerBridgeHandlers` closes over it so the
  // future enforcement PR can read the same blob without duplicating the
  // resolution logic (which would risk advertise/enforce drift).
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
    () => hostStyleDefinition.resolveStyleVariables(resolvedTheme),
    [resolvedTheme, hostStyleDefinition],
  );
  const hostChatBackground = useMemo(
    () => hostStyleDefinition.resolveChatBackground(resolvedTheme),
    [hostStyleDefinition, resolvedTheme],
  );
  const defaultFontCss = hostStyleDefinition.fontCss;
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
          : hostStyleDefinition.platform,
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

  // ENFORCEMENT LANDING PAD (deferred):
  // `effectiveHostCapabilities` (above) is the contract advertised in
  // ui/initialize. The handlers bound below SHOULD eventually gate their work
  // on it so that "advertise" and "enforce" stay in lockstep, otherwise the
  // handshake lies (advertised "unsupported" + behavior "supported") — which
  // is worse than no mock at all for conformance testing. Mapping for the
  // follow-up PR:
  //   • bridge.onopenlink            ← effectiveHostCapabilities.openLinks
  //   • bridge.onmessage             ← effectiveHostCapabilities.message
  //   • bridge.onupdatemodelcontext  ← effectiveHostCapabilities.updateModelContext
  //   • bridge.oncalltool            ← effectiveHostCapabilities.serverTools
  //   • bridge.onreadresource /
  //     onlistresources /
  //     onlistresourcetemplates      ← effectiveHostCapabilities.serverResources
  //   • bridge.onloggingmessage      ← effectiveHostCapabilities.logging
  //   • (downloadFile handler)       ← effectiveHostCapabilities.downloadFile
  // When enforcement lands, add `effectiveHostCapabilities` to this
  // useCallback's dep array.
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

      bridge.onmessage = async ({ content }) => {
        const textContent = content.find((item) => item.type === "text")?.text;
        if (textContent) {
          onSendFollowUpRef.current?.(textContent);
        }
        return {};
      };

      bridge.onopenlink = async ({ url }) => {
        if (url) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
        return {};
      };

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

        const response = await authFetch(`/api/mcp/resource-templates/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId: serverIdRef.current,
          }),
        });
        if (!response.ok) {
          throw new Error(
            `Resource template list failed: ${response.statusText}`,
          );
        }
        return response.json();
      };

      bridge.onlistprompts = async (params) => {
        void params;
        const prompts = await listPrompts(serverIdRef.current);
        return { prompts };
      };

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

      bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
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
    },
    [setIsReady, toolCallId, setWidgetModelContext, logWidgetDebug],
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
      hasCsp: !!widgetCsp,
      hasPermissions: !!widgetPermissions,
      htmlLength: widgetHtml.length,
      permissive: widgetPermissive,
      toolState: toolState ?? null,
    });

    // `effectiveHostCapabilities` is computed at component scope so
    // `registerBridgeHandlers` can read the same value when enforcement
    // gates land (see comment near its definition). Runtime `sandbox` stays
    // widget-derived per SEP-1865 — CSP/permissions are approved per UI
    // resource, not a vendor trait.
    const bridge = new AppBridge(
      null,
      { name: "mcpjam-inspector", version: __APP_VERSION__ },
      {
        ...effectiveHostCapabilities,
        sandbox: {
          // In permissive mode: omit CSP (undefined) to indicate no restrictions.
          // In widget-declared mode: pass the RESOLVED CSP (resolver output
          // including profile restrictTo / deny / hosted clamp). The bridge
          // advertises the same effective set the iframe boundary enforces;
          // an app shouldn't be able to introspect a CSP that's wider than
          // what its requests actually escape.
          csp: effectivePermissive ? undefined : resolvedCsp,
          // Resolved permissions (after `mode` / `allow` / `deny` /
          // hosted clamp) so the bridge advertises the same set the
          // iframe `allow=` attribute applies.
          permissions: resolvedPermissions,
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
    // Raw widget* values stay in deps for the
    // `debug/bridge-connect-start` log entry inside the effect body.
    widgetCsp,
    widgetPermissions,
    widgetPermissive,
    // Bridge advertises the RESOLVED sandbox policy at handshake
    // (`sandbox: { csp, permissions }` in the AppBridge config below).
    // Without tracking the resolved values too, editing
    // `mcpProfile.apps.sandbox.*` while a widget is mounted leaves
    // `ui/initialize` advertising stale policy while the iframe
    // enforces the new one. Host-config preview / playground flows
    // hit this regularly because they re-render the renderer
    // without remounting the widget HTML.
    resolvedCsp,
    resolvedPermissions,
    effectivePermissive,
    logWidgetDebug,
    // Bridge must rebuild when the advertised host capabilities change
    // (host style switch or override edit) so the new handshake reflects
    // the new contract.
    effectiveHostCapabilities,
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
      hasCsp: !!widgetCsp,
      hasPermissions: !!widgetPermissions,
      htmlLength: widgetHtml.length,
      permissive: widgetPermissive,
    });
  }, [
    bridgeTransportReady,
    widgetHtml,
    widgetCsp,
    widgetPermissions,
    widgetPermissive,
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
      // Iframe enforcement reads the RESOLVED policy (resolver
      // output, including restrictTo intersection, deny subtraction,
      // and hosted-mode clamp), NOT the raw widget-declared CSP.
      // The debug overlay above and this iframe both consume the
      // same memoized values, so what users see in the overlay is
      // what actually applies at the iframe boundary.
      csp={resolvedCsp}
      permissions={resolvedPermissions}
      permissive={effectivePermissive}
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
        // Modal iframe must consume the RESOLVED policy too —
        // otherwise a profile's restrictTo / deny / hosted-clamp
        // rules apply to the inline view but bypass when a widget
        // opens its modal surface. The prop names retain
        // `widget*` shape for source-compat; the modal forwards
        // them to its own SandboxedIframe + AppBridge identically
        // to how the inline view's props flow.
        widgetCsp={resolvedCsp}
        widgetPermissions={resolvedPermissions}
        widgetPermissive={effectivePermissive}
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
