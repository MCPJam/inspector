import { useRef, useState, useEffect, useCallback, useMemo } from "react";

import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useUIPlaygroundStore,
  type CspMode,
} from "@/stores/ui-playground-store";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { useTrafficLogStore, extractMethod } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  ChatGPTSandboxedIframe,
  ChatGPTSandboxedIframeHandle,
} from "@/components/ui/chatgpt-sandboxed-iframe";
import { toast } from "sonner";
import { type DisplayMode } from "@/stores/ui-playground-store";
import posthog from "posthog-js";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { CheckoutSession } from "@/shared/acp-types.ts";
import { CheckoutDialog } from "./checkout-dialog";

type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | string;

/**
 * Parse RFC 7235 WWW-Authenticate header for OAuth challenges.
 * Format: Bearer realm="...", error="...", error_description="..."
 */
function parseWwwAuthenticate(
  header: string,
): { realm?: string; error?: string; errorDescription?: string } | null {
  if (!header || typeof header !== "string") return null;

  const result: { realm?: string; error?: string; errorDescription?: string } =
    {};

  // Extract key="value" pairs
  const matches = header.matchAll(/(\w+)="([^"]+)"/g);
  for (const match of matches) {
    const [, key, value] = match;
    if (key === "realm") result.realm = value;
    else if (key === "error") result.error = value;
    else if (key === "error_description") result.errorDescription = value;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Handle OAuth challenge from tool response per OpenAI Apps SDK spec.
 * When a tool returns 401, _meta["mcp/www_authenticate"] contains the challenge header.
 */
function handleOAuthChallenge(wwwAuth: string, toolName: string): void {
  const parsed = parseWwwAuthenticate(wwwAuth);

  console.warn(
    `[OAuth Challenge] Tool "${toolName}" requires authentication`,
    parsed
      ? {
          realm: parsed.realm,
          error: parsed.error,
          description: parsed.errorDescription,
        }
      : { raw: wwwAuth },
  );

  if (parsed?.error || parsed?.errorDescription) {
    toast.warning(
      `OAuth Required: ${parsed.errorDescription || parsed.error || "Authentication required"}`,
      {
        description: `Tool "${toolName}" needs authentication. Configure OAuth in server settings.`,
        duration: 8000,
      },
    );
  } else {
    toast.warning(`OAuth Required for "${toolName}"`, {
      description:
        "The tool requires authentication. Configure OAuth in server settings.",
      duration: 8000,
    });
  }
}

interface ChatGPTAppRendererProps {
  serverId: string;
  toolCallId?: string;
  toolName?: string;
  toolState?: ToolState;
  toolInput?: Record<string, any> | null;
  toolOutput?: unknown;
  toolMetadata?: Record<string, any>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, any>,
    meta?: Record<string, any>,
  ) => Promise<any>;
  onWidgetStateChange?: (toolCallId: string, state: any) => void;
  pipWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  /** Controlled display mode - when provided, component uses this instead of internal state */
  displayMode?: DisplayMode;
  /** Callback when display mode changes - required when displayMode is controlled */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
}

// ============================================================================
// Helper Hooks
// ============================================================================

function useResolvedToolData(
  toolCallId: string | undefined,
  toolName: string | undefined,
  toolInputProp: Record<string, any> | null | undefined,
  toolOutputProp: unknown,
  toolMetadata: Record<string, any> | undefined,
) {
  const resolvedToolCallId = useMemo(
    () => toolCallId ?? `${toolName || "chatgpt-app"}-${Date.now()}`,
    [toolCallId, toolName],
  );
  const outputTemplate = useMemo(
    () => toolMetadata?.["openai/outputTemplate"],
    [toolMetadata],
  );

  const structuredContent = useMemo(() => {
    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null &&
      "structuredContent" in toolOutputProp
    ) {
      return (toolOutputProp as Record<string, unknown>).structuredContent;
    }
    return null;
  }, [toolOutputProp]);

  const toolResponseMetadata = useMemo(() => {
    if (
      toolOutputProp &&
      typeof toolOutputProp === "object" &&
      toolOutputProp !== null
    ) {
      if ("_meta" in toolOutputProp)
        return (toolOutputProp as Record<string, unknown>)._meta;
      if ("meta" in toolOutputProp)
        return (toolOutputProp as Record<string, unknown>).meta;
    }
    return null;
  }, [toolOutputProp]);

  const resolvedToolInput = useMemo(
    () => (toolInputProp as Record<string, any>) ?? {},
    [toolInputProp],
  );
  const resolvedToolOutput = useMemo(
    () => structuredContent ?? toolOutputProp ?? null,
    [structuredContent, toolOutputProp],
  );

  return {
    resolvedToolCallId,
    outputTemplate,
    toolResponseMetadata,
    resolvedToolInput,
    resolvedToolOutput,
  };
}

/**
 * Compute device type from viewport width, matching ChatGPT's breakpoints.
 * ChatGPT passes this as ?deviceType=desktop in iframe URL.
 */
function getDeviceType(): "mobile" | "tablet" | "desktop" {
  const width = window.innerWidth;
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

/**
 * Coarse user location per SDK spec: { country, region, city }
 * Uses IP-based geolocation (no permission required).
 */
interface UserLocation {
  country: string;
  region: string;
  city: string;
}

// Cache location to avoid repeated API calls
let cachedLocation: UserLocation | null = null;
let locationFetchPromise: Promise<UserLocation | null> | null = null;

// Default values for non-playground contexts (defined outside component to avoid infinite loops)
const DEFAULT_CAPABILITIES = { hover: true, touch: false };
const DEFAULT_SAFE_AREA_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Fetch coarse location from IP-based geolocation service.
 * Uses ip-api.com (free, no API key required, 45 req/min limit).
 * Results are cached for the session.
 */
async function getUserLocation(): Promise<UserLocation | null> {
  // Return cached result if available
  if (cachedLocation) return cachedLocation;

  // Return existing promise if fetch is in progress
  if (locationFetchPromise) return locationFetchPromise;

  locationFetchPromise = (async () => {
    try {
      // ip-api.com provides free IP geolocation (no API key needed)
      // Fields: country, regionName, city
      const response = await fetch(
        "http://ip-api.com/json/?fields=status,country,regionName,city",
        {
          signal: AbortSignal.timeout(3000), // 3s timeout
        },
      );

      if (!response.ok) return null;

      const data = await response.json();
      if (data.status !== "success") return null;

      cachedLocation = {
        country: data.country || "",
        region: data.regionName || "",
        city: data.city || "",
      };

      return cachedLocation;
    } catch (err) {
      // Silently fail - location is optional per SDK spec
      console.debug("[OpenAI SDK] IP geolocation unavailable:", err);
      return null;
    }
  })();

  return locationFetchPromise;
}

interface WidgetCspData {
  mode: CspMode;
  connectDomains: string[];
  resourceDomains: string[];
  headerString?: string;
  /** Widget's actual openai/widgetCSP declaration (null if not declared) */
  widgetDeclared?: {
    connect_domains?: string[];
    resource_domains?: string[];
  } | null;
}

function useWidgetFetch(
  toolState: ToolState | undefined,
  resolvedToolCallId: string,
  outputTemplate: string | undefined,
  toolName: string | undefined,
  serverId: string,
  resolvedToolInput: Record<string, any>,
  resolvedToolOutput: unknown,
  toolResponseMetadata: unknown,
  themeMode: string,
  locale: string,
  cspMode: CspMode,
  deviceType: string,
  capabilities: { hover: boolean; touch: boolean },
  safeAreaInsets: { top: number; bottom: number; left: number; right: number },
  onCspConfigReceived?: (csp: WidgetCspData) => void,
) {
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [widgetClosed, setWidgetClosed] = useState(false);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [prevCspMode, setPrevCspMode] = useState(cspMode);
  const [prefersBorder, setPrefersBorder] = useState<boolean>(true);

  // Reset widget URL when CSP mode changes to trigger reload
  useEffect(() => {
    if (cspMode !== prevCspMode && widgetUrl) {
      setPrevCspMode(cspMode);
      setWidgetUrl(null);
    }
  }, [cspMode, prevCspMode, widgetUrl]);

  useEffect(() => {
    let isCancelled = false;
    if (
      toolState !== "output-available" ||
      widgetUrl ||
      !outputTemplate ||
      !toolName
    ) {
      if (!outputTemplate) {
        setWidgetUrl(null);
        setStoreError(null);
        setIsStoringWidget(false);
      }
      if (!toolName && outputTemplate) {
        setWidgetUrl(null);
        setStoreError("Tool name is required");
        setIsStoringWidget(false);
      }
      return;
    }

    const storeWidgetData = async () => {
      setIsStoringWidget(true);
      setStoreError(null);
      try {
        // Host-controlled values per SDK spec
        const userLocation = await getUserLocation(); // Coarse IP-based location

        const storeResponse = await fetch("/api/apps/chatgpt/widget/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId,
            uri: outputTemplate,
            toolInput: resolvedToolInput,
            toolOutput: resolvedToolOutput,
            toolResponseMetadata,
            toolId: resolvedToolCallId,
            toolName,
            theme: themeMode,
            locale, // BCP 47 locale from host
            deviceType, // Device type from host (playground setting or computed)
            userLocation, // Coarse location { country, region, city } or null
            cspMode, // CSP enforcement mode
            capabilities, // Device capabilities { hover, touch }
            safeAreaInsets, // Safe area insets { top, bottom, left, right }
          }),
        });
        if (!storeResponse.ok)
          throw new Error(
            `Failed to store widget data: ${storeResponse.statusText}`,
          );
        if (isCancelled) return;

        // Check if widget should close and get CSP config
        const htmlResponse = await fetch(
          `/api/apps/chatgpt/widget-html/${resolvedToolCallId}`,
        );
        if (htmlResponse.ok) {
          const data = await htmlResponse.json();

          // Update CSP info in widget debug store
          if (data.csp && onCspConfigReceived) {
            onCspConfigReceived({
              mode: data.csp.mode,
              connectDomains: data.csp.connectDomains,
              resourceDomains: data.csp.resourceDomains,
              headerString: data.csp.headerString,
              widgetDeclared: data.csp.widgetDeclared,
            });
          }

          if (data.closeWidget) {
            setWidgetClosed(true);
            setIsStoringWidget(false);
            return;
          }

          setPrefersBorder(data.prefersBorder ?? true);
        }

        // Set the widget URL with CSP mode query param
        // Use /widget-content directly so CSP headers are applied by the browser
        setWidgetUrl(
          `/api/apps/chatgpt/widget-content/${resolvedToolCallId}?csp_mode=${cspMode}`,
        );
      } catch (err) {
        if (isCancelled) return;
        console.error("Error storing widget data:", err);
        setStoreError(
          err instanceof Error ? err.message : "Failed to prepare widget",
        );
      } finally {
        if (!isCancelled) setIsStoringWidget(false);
      }
    };
    storeWidgetData();
    return () => {
      isCancelled = true;
    };
  }, [
    toolState,
    resolvedToolCallId,
    widgetUrl,
    outputTemplate,
    toolName,
    serverId,
    resolvedToolInput,
    resolvedToolOutput,
    toolResponseMetadata,
    themeMode,
    locale,
    cspMode,
    deviceType,
    capabilities,
    safeAreaInsets,
    onCspConfigReceived,
  ]);

  return {
    widgetUrl,
    widgetClosed,
    isStoringWidget,
    storeError,
    setWidgetUrl,
    prefersBorder,
  };
}

// ============================================================================
// Main Component
// ============================================================================

export function ChatGPTAppRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput: toolInputProp,
  toolOutput: toolOutputProp,
  toolMetadata,
  onSendFollowUp,
  onCallTool,
  onWidgetStateChange,
  pipWidgetId,
  onRequestPip,
  onExitPip,
  displayMode: displayModeProp,
  onDisplayModeChange,
  onRequestFullscreen,
  onExitFullscreen,
}: ChatGPTAppRendererProps) {
  const sandboxRef = useRef<ChatGPTSandboxedIframeHandle>(null);
  const modalSandboxRef = useRef<ChatGPTSandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  // Get locale from playground store, fallback to navigator.language
  const playgroundLocale = useUIPlaygroundStore((s) => s.globals.locale);
  const locale = playgroundLocale || navigator.language || "en-US";

  const {
    resolvedToolCallId,
    outputTemplate,
    toolResponseMetadata,
    resolvedToolInput,
    resolvedToolOutput,
  } = useResolvedToolData(
    toolCallId,
    toolName,
    toolInputProp,
    toolOutputProp,
    toolMetadata,
  );

  // Display mode: controlled (via props) or uncontrolled (internal state)
  const isControlled = displayModeProp !== undefined;
  const [internalDisplayMode, setInternalDisplayMode] =
    useState<DisplayMode>("inline");
  const displayMode = isControlled ? displayModeProp : internalDisplayMode;
  const setDisplayMode = useCallback(
    (mode: DisplayMode) => {
      if (isControlled) {
        onDisplayModeChange?.(mode);
      } else {
        setInternalDisplayMode(mode);
      }

      // Notify parent about fullscreen state changes regardless of controlled mode
      if (mode === "fullscreen") {
        onRequestFullscreen?.(resolvedToolCallId);
      } else if (displayMode === "fullscreen") {
        onExitFullscreen?.(resolvedToolCallId);
      }
    },
    [
      isControlled,
      onDisplayModeChange,
      resolvedToolCallId,
      onRequestFullscreen,
      onExitFullscreen,
      displayMode,
    ],
  );
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(320);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, any>>({});
  const [modalTitle, setModalTitle] = useState<string>("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutSession, setCheckoutSession] =
    useState<CheckoutSession | null>(null);
  const [checkoutCallId, setCheckoutCallId] = useState<number | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<"inline" | "modal">(
    "inline",
  );
  const previousWidgetStateRef = useRef<string | null>(null);
  const [currentWidgetState, setCurrentWidgetState] = useState<unknown>(null);
  const [modalSandboxReady, setModalSandboxReady] = useState(false);
  const lastAppliedHeightRef = useRef<number>(0);

  // Host-backed navigation state for fullscreen header buttons
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  // Get CSP mode, device type, capabilities, and safe area from playground store
  // Only apply custom settings when in UI Playground
  // ChatTabV2 and ResultsPanel should always use defaults
  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const playgroundCspMode = useUIPlaygroundStore((s) => s.cspMode);
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const playgroundCapabilities = useUIPlaygroundStore((s) => s.capabilities);
  const playgroundSafeAreaInsets = useUIPlaygroundStore(
    (s) => s.safeAreaInsets,
  );
  const cspMode = isPlaygroundActive ? playgroundCspMode : "permissive";
  // Use playground settings when active, otherwise compute from window
  const deviceType = isPlaygroundActive
    ? playgroundDeviceType
    : getDeviceType();
  // Use stable default objects to avoid infinite re-renders in useWidgetFetch
  const capabilities = isPlaygroundActive
    ? playgroundCapabilities
    : DEFAULT_CAPABILITIES;
  const safeAreaInsets = isPlaygroundActive
    ? playgroundSafeAreaInsets
    : DEFAULT_SAFE_AREA_INSETS;
  const setWidgetCsp = useWidgetDebugStore((s) => s.setWidgetCsp);

  // Mobile playground mode detection
  const isMobilePlaygroundMode = isPlaygroundActive && deviceType === "mobile";
  // Contained fullscreen mode detection (mobile + tablet should stay in container)
  const isContainedFullscreenMode =
    isPlaygroundActive && (deviceType === "mobile" || deviceType === "tablet");

  // Callback to handle CSP config received from server
  const handleCspConfigReceived = useCallback(
    (csp: WidgetCspData) => {
      setWidgetCsp(resolvedToolCallId, csp);
    },
    [resolvedToolCallId, setWidgetCsp],
  );

  const isFullscreen = displayMode === "fullscreen";
  const isPip =
    displayMode === "pip" &&
    (isControlled || pipWidgetId === resolvedToolCallId);
  const allowAutoResize = !isFullscreen && !isPip;
  const {
    widgetUrl,
    widgetClosed,
    isStoringWidget,
    storeError,
    prefersBorder,
  } = useWidgetFetch(
    toolState,
    resolvedToolCallId,
    outputTemplate,
    toolName,
    serverId,
    resolvedToolInput,
    resolvedToolOutput,
    toolResponseMetadata,
    themeMode,
    locale,
    cspMode,
    deviceType,
    capabilities,
    safeAreaInsets,
    handleCspConfigReceived,
  );

  const applyMeasuredHeight = useCallback(
    (height: unknown) => {
      const numericHeight = Number(height);
      if (!Number.isFinite(numericHeight) || numericHeight <= 0) return;
      const roundedHeight = Math.ceil(numericHeight);
      // Add a small buffer in auto-resize mode to avoid tiny scrollbars from subpixel rounding.
      const bufferedHeight = allowAutoResize
        ? roundedHeight + 2
        : roundedHeight;
      if (bufferedHeight === lastAppliedHeightRef.current) return;
      lastAppliedHeightRef.current = bufferedHeight;

      setContentHeight((prev) =>
        prev !== bufferedHeight ? bufferedHeight : prev,
      );

      const shouldApplyImperatively = allowAutoResize;

      if (shouldApplyImperatively) {
        const effectiveHeight =
          typeof maxHeight === "number" && Number.isFinite(maxHeight)
            ? Math.min(bufferedHeight, maxHeight)
            : bufferedHeight;
        sandboxRef.current?.setHeight?.(effectiveHeight);
      }
    },
    [allowAutoResize, maxHeight],
  );

  const appliedHeight = useMemo(() => {
    const baseHeight = contentHeight > 0 ? contentHeight : 320;
    return typeof maxHeight === "number" && Number.isFinite(maxHeight)
      ? Math.min(baseHeight, maxHeight)
      : baseHeight;
  }, [contentHeight, maxHeight]);

  const iframeHeight = useMemo(() => {
    if (isFullscreen) return "100%";
    if (displayMode === "pip") {
      // In mobile playground mode, PiP should be fullscreen (100% height)
      if (isMobilePlaygroundMode && isPip) return "100%";
      return isPip ? "400px" : `${appliedHeight}px`;
    }
    return `${appliedHeight}px`;
  }, [appliedHeight, displayMode, isFullscreen, isPip, isMobilePlaygroundMode]);

  const modalWidgetUrl = useMemo(() => {
    if (!widgetUrl || !modalOpen) return null;
    const url = new URL(widgetUrl, window.location.origin);
    url.searchParams.set("view_mode", "modal");
    url.searchParams.set("view_params", JSON.stringify(modalParams));
    return url.toString();
  }, [widgetUrl, modalOpen, modalParams]);

  const addUiLog = useTrafficLogStore((s) => s.addLog);
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetState = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);

  useEffect(() => {
    if (!toolName) return;
    setWidgetDebugInfo(resolvedToolCallId, {
      toolName,
      protocol: "openai-apps",
      widgetState: null,
      globals: {
        theme: themeMode,
        displayMode,
        maxHeight: maxHeight ?? undefined,
        locale,
        safeArea: { insets: safeAreaInsets },
        userAgent: {
          device: { type: deviceType },
          capabilities,
        },
      },
    });
  }, [
    resolvedToolCallId,
    toolName,
    setWidgetDebugInfo,
    themeMode,
    displayMode,
    maxHeight,
    locale,
    deviceType,
    capabilities,
    safeAreaInsets,
  ]);

  useEffect(() => {
    setWidgetGlobals(resolvedToolCallId, {
      theme: themeMode,
      displayMode,
      maxHeight: maxHeight ?? undefined,
    });
  }, [resolvedToolCallId, themeMode, displayMode, maxHeight, setWidgetGlobals]);

  useEffect(() => {
    lastAppliedHeightRef.current = 0;
    // Reset navigation state when widget URL changes
    setCanGoBack(false);
    setCanGoForward(false);
    if (!widgetUrl) return;
    setContentHeight(320);
    if (displayMode === "inline") {
      const baseHeight =
        typeof maxHeight === "number" && Number.isFinite(maxHeight)
          ? Math.min(320, maxHeight)
          : 320;
      sandboxRef.current?.setHeight?.(baseHeight);
    }
  }, [widgetUrl, maxHeight]);

  // When returning to inline, ask the widget to re-measure so backend-driven
  // resize logic publishes the fresh height.
  useEffect(() => {
    if (!widgetUrl || displayMode !== "inline" || !isReady) return;
    sandboxRef.current?.postMessage({ type: "openai:requestResize" });
  }, [widgetUrl, displayMode, isReady]);

  // When returning from pip/fullscreen to inline, push the latest measured
  // height back into the iframe so it reflects current content.
  useEffect(() => {
    if (displayMode !== "inline") return;
    if (!Number.isFinite(appliedHeight) || appliedHeight <= 0) return;
    lastAppliedHeightRef.current = Math.round(appliedHeight);
    sandboxRef.current?.setHeight?.(appliedHeight);
  }, [appliedHeight, displayMode]);

  const postToWidget = useCallback(
    (data: unknown, targetModal?: boolean) => {
      addUiLog({
        widgetId: resolvedToolCallId,
        serverId,
        direction: "host-to-ui",
        protocol: "openai-apps",
        method: extractMethod(data, "openai-apps"),
        message: data,
      });
      if (targetModal) {
        // Only send to modal if it's ready
        if (modalSandboxReady) {
          modalSandboxRef.current?.postMessage(data);
        }
      } else {
        sandboxRef.current?.postMessage(data);
      }
    },
    [addUiLog, resolvedToolCallId, serverId, modalSandboxReady],
  );

  const respondToCheckout = useCallback(
    (payload: { result?: unknown; error?: string }) => {
      if (checkoutCallId == null) return;
      postToWidget(
        {
          type: "openai:requestCheckout:response",
          callId: checkoutCallId,
          ...payload,
        },
        checkoutTarget === "modal",
      );
      setCheckoutCallId(null);
      setCheckoutSession(null);
      setCheckoutOpen(false);
    },
    [checkoutCallId, checkoutTarget, postToWidget],
  );

  // Host-backed navigation: send navigation command to widget
  const navigateWidget = useCallback(
    (direction: "back" | "forward") => {
      sandboxRef.current?.postMessage({
        type: "openai:navigate",
        direction,
        toolId: resolvedToolCallId,
      });
    },
    [resolvedToolCallId],
  );

  const handleSandboxMessage = useCallback(
    async (event: MessageEvent) => {
      const eventType = event.data?.type;
      addUiLog({
        widgetId: resolvedToolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "openai-apps",
        method: extractMethod(event.data, "openai-apps"),
        message: event.data,
      });

      if (eventType !== "openai:resize") {
        posthog.capture("openai_app_message_received", {
          location: "chatgpt_app_renderer",
          type: eventType,
          fullEventData: event.data,
          platform: detectPlatform(),
          environment: detectEnvironment(),
        });
      }

      switch (eventType) {
        case "openai:resize": {
          applyMeasuredHeight(event.data.height);
          break;
        }
        case "openai:setWidgetState": {
          if (event.data.toolId === resolvedToolCallId) {
            const newState = event.data.state;
            const newStateStr =
              newState === null ? null : JSON.stringify(newState);
            if (newStateStr !== previousWidgetStateRef.current) {
              previousWidgetStateRef.current = newStateStr;
              setCurrentWidgetState(newState);
              setWidgetState(resolvedToolCallId, newState);
              onWidgetStateChange?.(resolvedToolCallId, newState);
            }
            // Push to modal if open and ready
            if (modalOpen && modalSandboxReady) {
              modalSandboxRef.current?.postMessage({
                type: "openai:pushWidgetState",
                toolId: resolvedToolCallId,
                state: newState,
              });
            }
          }
          break;
        }
        case "openai:callTool": {
          const callId = event.data.callId;
          const calledToolName = event.data.toolName;
          if (!onCallTool) {
            postToWidget({
              type: "openai:callTool:response",
              callId,
              error: "callTool is not supported in this context",
            });
            break;
          }
          try {
            const result = await onCallTool(
              calledToolName,
              event.data.args || event.data.params || {},
              event.data._meta || {},
            );

            // Check for OAuth challenge per OpenAI Apps SDK spec
            // When a tool returns 401, _meta["mcp/www_authenticate"] contains the RFC 7235 challenge
            const resultMeta = result?._meta || result?.meta;
            const wwwAuth = resultMeta?.["mcp/www_authenticate"];
            if (wwwAuth && typeof wwwAuth === "string") {
              handleOAuthChallenge(wwwAuth, calledToolName);
            }

            // Send full result to widget - let the widget handle isError
            // Don't set error field for tool errors (isError: true) - only for transport errors
            // Per OpenAI Apps SDK spec, callTool() should resolve with { isError: true }, not reject
            postToWidget({
              type: "openai:callTool:response",
              callId,
              result,
            });
          } catch (err) {
            postToWidget({
              type: "openai:callTool:response",
              callId,
              error: err instanceof Error ? err.message : "Unknown error",
            });
          }
          break;
        }
        case "openai:sendFollowup": {
          if (onSendFollowUp && event.data.message) {
            const message =
              typeof event.data.message === "string"
                ? event.data.message
                : event.data.message.prompt ||
                  JSON.stringify(event.data.message);
            onSendFollowUp(message);
          }
          break;
        }
        case "openai:requestDisplayMode": {
          const requestedMode = event.data.mode || "inline";
          const isMobile = window.innerWidth < 768;
          const actualMode =
            isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;
          setDisplayMode(actualMode);
          if (actualMode === "pip") onRequestPip?.(resolvedToolCallId);
          else if (
            (actualMode === "inline" || actualMode === "fullscreen") &&
            pipWidgetId === resolvedToolCallId
          )
            onExitPip?.(resolvedToolCallId);
          if (typeof event.data.maxHeight === "number")
            setMaxHeight(event.data.maxHeight);
          else if (event.data.maxHeight == null) setMaxHeight(null);
          postToWidget({
            type: "openai:set_globals",
            globals: { displayMode: actualMode },
          });
          break;
        }
        case "openai:requestClose": {
          setDisplayMode("inline");
          if (pipWidgetId === resolvedToolCallId)
            onExitPip?.(resolvedToolCallId);
          break;
        }
        case "openai:csp-violation": {
          const {
            directive,
            blockedUri,
            sourceFile,
            lineNumber,
            columnNumber,
            effectiveDirective,
            timestamp,
          } = event.data;

          // Add violation to widget debug store for display in CSP panel
          addCspViolation(resolvedToolCallId, {
            directive,
            effectiveDirective,
            blockedUri,
            sourceFile,
            lineNumber,
            columnNumber,
            timestamp: timestamp || Date.now(),
          });
          break;
        }
        case "openai:openExternal": {
          if (event.data.href && typeof event.data.href === "string") {
            const href = event.data.href;
            if (
              href.startsWith("http://localhost") ||
              href.startsWith("http://127.0.0.1")
            )
              break;
            window.open(href, "_blank", "noopener,noreferrer");
          }
          break;
        }
        case "openai:requestCheckout": {
          if (typeof event.data.callId !== "number") break;
          const session =
            event.data.session && typeof event.data.session === "object"
              ? (event.data.session as CheckoutSession)
              : null;
          if (!session) break;
          if (checkoutCallId != null) {
            postToWidget({
              type: "openai:requestCheckout:response",
              callId: event.data.callId,
              error: "Another checkout is already in progress",
            });
            break;
          }
          setCheckoutTarget("inline");
          setCheckoutCallId(event.data.callId);
          setCheckoutSession(session);
          setCheckoutOpen(true);
          break;
        }
        case "openai:requestModal": {
          setModalTitle(event.data.title || "Modal");
          setModalParams(event.data.params || {});
          setModalOpen(true);
          break;
        }
        case "openai:navigationStateChanged": {
          // Host-backed navigation: update navigation button state
          if (event.data.toolId === resolvedToolCallId) {
            setCanGoBack(event.data.canGoBack ?? false);
            setCanGoForward(event.data.canGoForward ?? false);
          }
          break;
        }
      }
    },
    [
      onCallTool,
      onSendFollowUp,
      onWidgetStateChange,
      resolvedToolCallId,
      pipWidgetId,
      modalOpen,
      modalSandboxReady,
      onRequestPip,
      onExitPip,
      addUiLog,
      postToWidget,
      serverId,
      setWidgetState,
      applyMeasuredHeight,
      addCspViolation,
      checkoutCallId,
    ],
  );

  const handleModalSandboxMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data?.type) {
        addUiLog({
          widgetId: resolvedToolCallId,
          serverId,
          direction: "ui-to-host",
          protocol: "openai-apps",
          method: extractMethod(event.data, "openai-apps"),
          message: event.data,
        });
      }

      if (
        event.data?.type === "openai:setWidgetState" &&
        event.data.toolId === resolvedToolCallId
      ) {
        const newState = event.data.state;
        const newStateStr = newState === null ? null : JSON.stringify(newState);
        if (newStateStr !== previousWidgetStateRef.current) {
          previousWidgetStateRef.current = newStateStr;
          setCurrentWidgetState(newState);
          setWidgetState(resolvedToolCallId, newState);
          onWidgetStateChange?.(resolvedToolCallId, newState);
        }
        // Push to inline widget
        sandboxRef.current?.postMessage({
          type: "openai:pushWidgetState",
          toolId: resolvedToolCallId,
          state: newState,
        });
      }

      if (event.data?.type === "openai:requestCheckout") {
        if (typeof event.data.callId !== "number") return;
        const session =
          event.data.session && typeof event.data.session === "object"
            ? (event.data.session as CheckoutSession)
            : null;
        if (!session) return;
        if (checkoutCallId != null) {
          postToWidget(
            {
              type: "openai:requestCheckout:response",
              callId: event.data.callId,
              error: "Another checkout is already in progress",
            },
            true,
          );
          return;
        }
        setCheckoutTarget("modal");
        setCheckoutCallId(event.data.callId);
        setCheckoutSession(session);
        setCheckoutOpen(true);
      }
    },
    [
      addUiLog,
      resolvedToolCallId,
      serverId,
      setWidgetState,
      onWidgetStateChange,
      checkoutCallId,
      postToWidget,
    ],
  );

  const handleModalReady = useCallback(() => {
    setModalSandboxReady(true);
    // Push current widget state to modal on ready
    if (currentWidgetState !== null) {
      modalSandboxRef.current?.postMessage({
        type: "openai:pushWidgetState",
        toolId: resolvedToolCallId,
        state: currentWidgetState,
      });
    }
    // Push current globals
    modalSandboxRef.current?.postMessage({
      type: "openai:set_globals",
      globals: {
        theme: themeMode,
        displayMode: "inline",
        maxHeight: null,
        locale,
        safeArea: { insets: safeAreaInsets },
        userAgent: {
          device: { type: deviceType },
          capabilities,
        },
      },
    });
  }, [
    currentWidgetState,
    resolvedToolCallId,
    themeMode,
    locale,
    deviceType,
    capabilities,
    safeAreaInsets,
  ]);

  // Reset modal sandbox state when modal closes
  useEffect(() => {
    if (!modalOpen) {
      setModalSandboxReady(false);
    }
  }, [modalOpen]);

  // Reset pip mode if pipWidgetId doesn't match (but not when controlled externally)
  useEffect(() => {
    if (
      !isControlled &&
      displayMode === "pip" &&
      pipWidgetId !== resolvedToolCallId
    )
      setDisplayMode("inline");
  }, [
    displayMode,
    pipWidgetId,
    resolvedToolCallId,
    isControlled,
    setDisplayMode,
  ]);

  useEffect(() => {
    if (!isReady) return;
    const globals: Record<string, unknown> = {
      theme: themeMode,
      displayMode,
      locale,
      safeArea: { insets: safeAreaInsets },
      userAgent: {
        device: { type: deviceType },
        capabilities,
      },
    };
    if (typeof maxHeight === "number" && Number.isFinite(maxHeight))
      globals.maxHeight = maxHeight;
    postToWidget({ type: "openai:set_globals", globals });
    if (modalOpen) postToWidget({ type: "openai:set_globals", globals }, true);
  }, [
    themeMode,
    maxHeight,
    displayMode,
    locale,
    deviceType,
    capabilities,
    safeAreaInsets,
    isReady,
    modalOpen,
    postToWidget,
  ]);

  const invokingText = toolMetadata?.["openai/toolInvocation/invoking"] as
    | string
    | undefined;
  const invokedText = toolMetadata?.["openai/toolInvocation/invoked"] as
    | string
    | undefined;

  // Loading/error states
  if (toolState === "input-streaming" || toolState === "input-available") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        {invokingText || "Executing tool..."}
      </div>
    );
  }
  if (isStoringWidget)
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading ChatGPT App widget...
      </div>
    );
  if (storeError)
    return (
      <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
        Failed to load widget: {storeError}
        {outputTemplate && (
          <>
            {" "}
            (Template <code>{outputTemplate}</code>)
          </>
        )}
      </div>
    );
  if (widgetClosed)
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        {invokedText || "Tool completed successfully."}
      </div>
    );
  if (!outputTemplate) {
    if (toolState !== "output-available")
      return (
        <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
          Widget UI will appear once the tool finishes executing.
        </div>
      );
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Unable to render ChatGPT App UI for this tool result.
      </div>
    );
  }
  if (!widgetUrl)
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2 flex items-center gap-2">
        <Loader2 className="h-3 w-3 animate-spin" />
        Preparing widget...
      </div>
    );

  // Determine container className based on display mode
  const containerClassName = (() => {
    // Fullscreen modes
    if (isFullscreen) {
      if (isContainedFullscreenMode) {
        // Mobile/tablet fullscreen: contained within device frame
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      // Desktop fullscreen: breaks out to viewport
      return "fixed inset-0 z-50 w-full h-full bg-background flex flex-col";
    }

    // PiP modes
    if (isPip) {
      if (isMobilePlaygroundMode) {
        // Mobile PiP acts like fullscreen: contained within device frame
        return "absolute inset-0 z-10 w-full h-full bg-background flex flex-col";
      }
      // Desktop/tablet PiP: floating at top
      return "fixed top-4 inset-x-0 z-40 w-full max-w-4xl mx-auto space-y-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-xl border border-border/60 rounded-xl p-3";
    }

    // Inline mode
    return "mt-3 space-y-2 relative group";
  })();

  return (
    <div className={containerClassName}>
      {/* Contained fullscreen modes: simple floating X button */}
      {((isFullscreen && isContainedFullscreenMode) ||
        (isPip && isMobilePlaygroundMode)) && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            if (pipWidgetId === resolvedToolCallId) {
              onExitPip?.(resolvedToolCallId);
            }
          }}
          className="absolute left-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/20 hover:bg-black/40 text-white transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      )}

      {/* Breakout fullscreen: full header with navigation */}
      {isFullscreen && !isContainedFullscreenMode && (
        <div className="flex items-center justify-between px-4 h-14 border-b border-border/40 bg-background/95 backdrop-blur z-50 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigateWidget("back")}
              disabled={!canGoBack}
              className={`p-2 rounded-lg transition-colors ${
                canGoBack
                  ? "hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                  : "text-muted-foreground/50 cursor-not-allowed"
              }`}
              aria-label="Go back"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => navigateWidget("forward")}
              disabled={!canGoForward}
              className={`p-2 rounded-lg transition-colors ${
                canGoForward
                  ? "hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
                  : "text-muted-foreground/50 cursor-not-allowed"
              }`}
              aria-label="Go forward"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="font-medium text-sm text-muted-foreground">
            {toolName || "ChatGPT App"}
          </div>

          <button
            onClick={() => {
              setDisplayMode("inline");
              // Also ensure we exit PiP if that was the origin, though fullscreen usually overrides it
              if (pipWidgetId === resolvedToolCallId) {
                onExitPip?.(resolvedToolCallId);
              }
            }}
            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Exit fullscreen"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* PiP Close Button - only show in PiP mode, Fullscreen has its own header */}
      {isPip && !isMobilePlaygroundMode && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            onExitPip?.(resolvedToolCallId);
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close PiP mode"
          title="Close PiP mode"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {loadError && (
        <div className="border border-destructive/40 bg-destructive/10 text-destructive text-xs rounded-md px-3 py-2">
          Failed to load widget: {loadError}
        </div>
      )}
      <ChatGPTSandboxedIframe
        ref={sandboxRef}
        url={widgetUrl}
        allowAutoResize={allowAutoResize}
        onMessage={handleSandboxMessage}
        onReady={() => {
          setIsReady(true);
          setLoadError(null);
        }}
        title={`ChatGPT App Widget: ${toolName || "tool"}`}
        className={`w-full bg-background overflow-hidden ${
          isFullscreen
            ? "flex-1 border-0 rounded-none"
            : `rounded-md ${prefersBorder ? "border border-border/40" : ""}`
        }`}
        style={{
          height: iframeHeight,
          // Remove max-height in fullscreen to allow flex-1 to control size
          // In mobile playground mode, PiP should not be constrained by 90vh
          maxHeight:
            displayMode === "pip" && !isMobilePlaygroundMode
              ? "90vh"
              : undefined,
        }}
      />
      {outputTemplate && (
        <div className="text-[11px] text-muted-foreground/70">
          Template: <code>{outputTemplate}</code>
        </div>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-6xl h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{modalTitle}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 w-full h-full min-h-0">
            {modalWidgetUrl && (
              <ChatGPTSandboxedIframe
                ref={modalSandboxRef}
                url={modalWidgetUrl}
                onMessage={handleModalSandboxMessage}
                onReady={handleModalReady}
                title={`ChatGPT App Modal: ${modalTitle}`}
                className="w-full h-full border-0 rounded-md bg-background overflow-hidden"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <CheckoutDialog
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        checkoutSession={checkoutSession}
        checkoutCallId={checkoutCallId}
        onRespond={respondToCheckout}
      />
    </div>
  );
}
