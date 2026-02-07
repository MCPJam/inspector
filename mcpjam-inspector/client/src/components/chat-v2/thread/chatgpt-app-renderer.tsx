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
import { authFetch } from "@/lib/session-token";

type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied"
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

interface ServerInfo {
  name: string;
  iconUrl?: string;
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
  fullscreenWidgetId?: string | null;
  onRequestPip?: (toolCallId: string) => void;
  onExitPip?: (toolCallId: string) => void;
  /** Server info for checkout display */
  serverInfo?: ServerInfo | null;
  /** Controlled display mode - when provided, component uses this instead of internal state */
  displayMode?: DisplayMode;
  /** Callback when display mode changes - required when displayMode is controlled */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  onRequestFullscreen?: (toolCallId: string) => void;
  onExitFullscreen?: (toolCallId: string) => void;
  /** Whether the server is offline (for Views tab offline rendering) */
  isOffline?: boolean;
  /** Cached widget HTML URL for offline rendering */
  cachedWidgetHtmlUrl?: string;
  /** Optional initial widget state (used by view previews/editor) */
  initialWidgetState?: unknown;
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
  frameDomains?: string[];
  headerString?: string;
  /** Widget's actual openai/widgetCSP declaration (null if not declared) */
  widgetDeclared?: {
    connect_domains?: string[];
    resource_domains?: string[];
    frame_domains?: string[];
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
  isOffline?: boolean,
  cachedWidgetHtmlUrl?: string,
  onWidgetHtmlCaptured?: (toolCallId: string, html: string) => void,
) {
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [widgetClosed, setWidgetClosed] = useState(false);
  const [widgetClosedReason, setWidgetClosedReason] = useState<
    "completed" | "closed" | null
  >(null);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  const [prevCspMode, setPrevCspMode] = useState(cspMode);
  const [prefersBorder, setPrefersBorder] = useState<boolean>(true);
  // Track if we should skip cached HTML (for live editing after initial load)
  const [skipCachedHtml, setSkipCachedHtml] = useState(false);
  // Track serialized data to detect changes
  const prevDataRef = useRef<string | null>(null);
  // Track the tool call ID to detect view switches (more stable than URL)
  const prevToolCallIdRef = useRef<string | null>(null);

  // Reset widget URL when switching to a different view (detected by toolCallId change)
  // We use toolCallId instead of cachedWidgetHtmlUrl because URLs can change after save
  // even for the same view, which would incorrectly reset the live editing state
  useEffect(() => {
    if (
      prevToolCallIdRef.current !== null &&
      prevToolCallIdRef.current !== resolvedToolCallId
    ) {
      // Actually switching to a different view - reset everything
      setWidgetUrl(null);
      setSkipCachedHtml(false);
      prevDataRef.current = null;
    }
    prevToolCallIdRef.current = resolvedToolCallId;
  }, [resolvedToolCallId]);

  // Reset widget URL when cachedWidgetHtmlUrl changes but only if not in live editing mode
  // This handles the case where a different cached HTML is available for the same view
  useEffect(() => {
    if (!skipCachedHtml) {
      setWidgetUrl(null);
    }
  }, [cachedWidgetHtmlUrl, skipCachedHtml]);

  // Use refs for values consumed inside the async storeWidgetData function.
  // These change reference (but not value) on every re-render during text
  // streaming because the AI SDK recreates message/part objects for each chunk.
  // Without refs, the effect would cancel and re-run on every text chunk,
  // racing with the in-flight store request.
  const resolvedToolInputRef = useRef(resolvedToolInput);
  resolvedToolInputRef.current = resolvedToolInput;
  const resolvedToolOutputRef = useRef(resolvedToolOutput);
  resolvedToolOutputRef.current = resolvedToolOutput;
  const toolResponseMetadataRef = useRef(toolResponseMetadata);
  toolResponseMetadataRef.current = toolResponseMetadata;
  const onCspConfigReceivedRef = useRef(onCspConfigReceived);
  onCspConfigReceivedRef.current = onCspConfigReceived;

  // Reset widget URL when CSP mode changes to trigger reload
  useEffect(() => {
    if (cspMode !== prevCspMode && widgetUrl) {
      setPrevCspMode(cspMode);
      setWidgetUrl(null);
    }
  }, [cspMode, prevCspMode, widgetUrl]);

  // Serialize data for stable comparison (avoids re-running effect on reference changes)
  const serializedData = useMemo(
    () =>
      JSON.stringify({ input: resolvedToolInput, output: resolvedToolOutput }),
    [resolvedToolInput, resolvedToolOutput],
  );

  // Debounce serializedData to avoid rapid reloads when typing fast in the editor
  const [debouncedSerializedData, setDebouncedSerializedData] =
    useState(serializedData);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSerializedData(serializedData);
    }, 300); // 300ms debounce delay

    return () => clearTimeout(timer);
  }, [serializedData]);

  // Detect data changes for live editing - trigger reload when toolInput/toolOutput changes
  useEffect(() => {
    if (toolState !== "output-available") return;

    // Skip initial load
    if (prevDataRef.current === null) {
      prevDataRef.current = debouncedSerializedData;
      return;
    }

    // If data changed after initial load, trigger a fresh fetch (skip cached HTML)
    if (prevDataRef.current !== debouncedSerializedData) {
      prevDataRef.current = debouncedSerializedData;
      // Only trigger reload if we have server connectivity (outputTemplate + toolName)
      if (outputTemplate && toolName && !isOffline) {
        setSkipCachedHtml(true);
        setWidgetUrl(null);
      }
    }
  }, [toolState, debouncedSerializedData, outputTemplate, toolName, isOffline]);

  useEffect(() => {
    let isCancelled = false;

    // Determine if we can proceed:
    // - Need output-available state
    // - Don't re-fetch if we already have a URL that matches current inputs
    // - Need either outputTemplate (for live fetch) OR cachedWidgetHtmlUrl (for offline)
    // - Need toolName for live fetch (but not required for cached)
    // - skipCachedHtml disables cached HTML for live editing
    const canUseCachedHtml = !!cachedWidgetHtmlUrl && !skipCachedHtml;
    const canUseLiveFetch = !!outputTemplate && !!toolName;

    // Check if widgetUrl is current (matches expected URL based on mode)
    // In cached mode: widgetUrl should equal cachedWidgetHtmlUrl
    // In live mode: widgetUrl is a widget-content endpoint URL
    const isWidgetUrlCurrent =
      widgetUrl &&
      ((canUseCachedHtml && widgetUrl === cachedWidgetHtmlUrl) ||
        (!canUseCachedHtml &&
          widgetUrl.includes("/api/apps/chatgpt/widget-content/")));

    if (
      toolState !== "output-available" ||
      isWidgetUrlCurrent ||
      (!canUseCachedHtml && !canUseLiveFetch)
    ) {
      // If we already have a widget URL, make sure loading state is cleared
      if (widgetUrl) {
        setIsStoringWidget(false);
      }
      if (!canUseCachedHtml && !outputTemplate) {
        setWidgetUrl(null);
        setStoreError(null);
        setIsStoringWidget(false);
      }
      if (!toolName && outputTemplate && !canUseCachedHtml) {
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
        // Try cached HTML first if available (for offline Views tab rendering)
        // Pass the Convex storage URL directly - it's publicly accessible and
        // the sandbox proxy can fetch it (unlike blob URLs which are origin-specific)
        // Skip cached HTML when doing live editing (skipCachedHtml is true)
        if (cachedWidgetHtmlUrl && !skipCachedHtml) {
          if (!isCancelled) {
            setWidgetUrl(cachedWidgetHtmlUrl);
            setIsStoringWidget(false);
          }
          return;
        }

        // If offline and no cached HTML, show error
        if (isOffline) {
          if (!isCancelled) {
            setStoreError("Server offline and no cached widget HTML available");
            setIsStoringWidget(false);
          }
          return;
        }

        // Host-controlled values per SDK spec
        const userLocation = await getUserLocation(); // Coarse IP-based location

        const storeResponse = await authFetch(
          "/api/apps/chatgpt/widget/store",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              serverId,
              uri: outputTemplate,
              toolInput: resolvedToolInputRef.current,
              toolOutput: resolvedToolOutputRef.current,
              toolResponseMetadata: toolResponseMetadataRef.current,
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
          },
        );
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
          if (data.csp && onCspConfigReceivedRef.current) {
            onCspConfigReceivedRef.current({
              mode: data.csp.mode,
              connectDomains: data.csp.connectDomains,
              resourceDomains: data.csp.resourceDomains,
              frameDomains: data.csp.frameDomains,
              headerString: data.csp.headerString,
              widgetDeclared: data.csp.widgetDeclared,
            });
          }

          if (data.closeWidget) {
            setWidgetClosed(true);
            setWidgetClosedReason("completed");
            setIsStoringWidget(false);
            return;
          }

          setPrefersBorder(data.prefersBorder ?? true);
        }

        // Fetch and cache the widget HTML for later saving
        const widgetContentUrl = `/api/apps/chatgpt/widget-content/${resolvedToolCallId}?csp_mode=${cspMode}`;
        if (onWidgetHtmlCaptured) {
          try {
            const contentResponse = await fetch(widgetContentUrl);
            if (contentResponse.ok) {
              const html = await contentResponse.text();
              onWidgetHtmlCaptured(resolvedToolCallId, html);
            }
          } catch (captureErr) {
            console.warn(
              "Failed to capture widget HTML for caching:",
              captureErr,
            );
          }
        }

        // Set the widget URL with CSP mode query param
        // Use /widget-content directly so CSP headers are applied by the browser
        setWidgetUrl(widgetContentUrl);

        // NOTE: We intentionally do NOT reset skipCachedHtml here.
        // Once in "live mode" (skipCachedHtml = true), we stay in live mode until
        // the user switches views (which triggers the reset effect via cachedWidgetHtmlUrl change).
        // This prevents live previews from reverting to stale cached HTML during view editing.
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
    // Note: resolvedToolInput, resolvedToolOutput, toolResponseMetadata, and onCspConfigReceived
    // are accessed via refs to avoid re-running this effect on reference changes.
    // The data change detection effect handles triggering re-fetches when data changes.
    themeMode,
    locale,
    cspMode,
    deviceType,
    capabilities,
    safeAreaInsets,
    isOffline,
    cachedWidgetHtmlUrl,
    onWidgetHtmlCaptured,
    skipCachedHtml,
  ]);

  return {
    widgetUrl,
    widgetClosed,
    widgetClosedReason,
    isStoringWidget,
    storeError,
    setWidgetUrl,
    setWidgetClosed,
    setWidgetClosedReason,
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
  fullscreenWidgetId,
  onRequestPip,
  onExitPip,
  serverInfo,
  displayMode: displayModeProp,
  onDisplayModeChange,
  onRequestFullscreen,
  onExitFullscreen,
  isOffline,
  cachedWidgetHtmlUrl,
  initialWidgetState,
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
  const effectiveDisplayMode = useMemo<DisplayMode>(() => {
    if (!isControlled) return displayMode;
    if (
      displayMode === "fullscreen" &&
      fullscreenWidgetId === resolvedToolCallId
    )
      return "fullscreen";
    if (displayMode === "pip" && pipWidgetId === resolvedToolCallId)
      return "pip";
    return "inline";
  }, [
    displayMode,
    fullscreenWidgetId,
    isControlled,
    pipWidgetId,
    resolvedToolCallId,
  ]);
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
  const [modalTemplate, setModalTemplate] = useState<string | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutSession, setCheckoutSession] =
    useState<CheckoutSession | null>(null);
  const [checkoutCallId, setCheckoutCallId] = useState<number | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<"inline" | "modal">(
    "inline",
  );
  const previousWidgetStateRef = useRef<string | null>(null);
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
  const cspMode = isPlaygroundActive ? playgroundCspMode : "widget-declared";
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
  const setWidgetHtml = useWidgetDebugStore((s) => s.setWidgetHtml);

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

  // Callback to capture widget HTML for offline rendering cache
  const handleWidgetHtmlCaptured = useCallback(
    (toolCallId: string, html: string) => {
      setWidgetHtml(toolCallId, html);
    },
    [setWidgetHtml],
  );

  const isFullscreen = effectiveDisplayMode === "fullscreen";
  const isPip = effectiveDisplayMode === "pip";
  const allowAutoResize = !isFullscreen && !isPip;
  const {
    widgetUrl,
    widgetClosed,
    widgetClosedReason,
    isStoringWidget,
    storeError,
    setWidgetClosed,
    setWidgetClosedReason,
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
    isOffline,
    cachedWidgetHtmlUrl,
    handleWidgetHtmlCaptured,
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
    if (effectiveDisplayMode === "pip") {
      // In mobile playground mode, PiP should be fullscreen (100% height)
      if (isMobilePlaygroundMode && isPip) return "100%";
      return isPip ? "400px" : `${appliedHeight}px`;
    }
    return `${appliedHeight}px`;
  }, [
    appliedHeight,
    effectiveDisplayMode,
    isFullscreen,
    isPip,
    isMobilePlaygroundMode,
  ]);

  const modalWidgetUrl = useMemo(() => {
    if (!widgetUrl || !modalOpen) return null;
    const url = new URL(widgetUrl, "http://placeholder");
    url.searchParams.set("view_mode", "modal");
    url.searchParams.set("view_params", JSON.stringify(modalParams));
    if (modalTemplate) {
      url.searchParams.set("template", modalTemplate);
    }
    return url.pathname + url.search;
  }, [widgetUrl, modalOpen, modalParams, modalTemplate]);

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
      widgetState: initialWidgetState ?? null,
      globals: {
        theme: themeMode,
        displayMode: effectiveDisplayMode,
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
    effectiveDisplayMode,
    maxHeight,
    locale,
    deviceType,
    capabilities,
    safeAreaInsets,
    initialWidgetState,
  ]);

  useEffect(() => {
    setWidgetGlobals(resolvedToolCallId, {
      theme: themeMode,
      displayMode: effectiveDisplayMode,
      maxHeight: maxHeight ?? undefined,
    });
  }, [
    resolvedToolCallId,
    themeMode,
    effectiveDisplayMode,
    maxHeight,
    setWidgetGlobals,
  ]);

  useEffect(() => {
    lastAppliedHeightRef.current = 0;
    // Reset navigation state when widget URL changes
    setCanGoBack(false);
    setCanGoForward(false);
    if (!widgetUrl) return;
    setContentHeight(320);
    if (effectiveDisplayMode === "inline") {
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
    if (!widgetUrl || effectiveDisplayMode !== "inline" || !isReady) return;
    sandboxRef.current?.postMessage({ type: "openai:requestResize" });
  }, [widgetUrl, effectiveDisplayMode, isReady]);

  // When returning from pip/fullscreen to inline, push the latest measured
  // height back into the iframe so it reflects current content.
  useEffect(() => {
    if (effectiveDisplayMode !== "inline") return;
    if (!Number.isFinite(appliedHeight) || appliedHeight <= 0) return;
    lastAppliedHeightRef.current = Math.round(appliedHeight);
    sandboxRef.current?.setHeight?.(appliedHeight);
  }, [appliedHeight, effectiveDisplayMode]);

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
            // Just update debug store - localStorage events handle modal ↔ inline sync
            if (newStateStr !== previousWidgetStateRef.current) {
              previousWidgetStateRef.current = newStateStr;
              setWidgetState(resolvedToolCallId, newState);
              onWidgetStateChange?.(resolvedToolCallId, newState);
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
          setWidgetClosed(true);
          setWidgetClosedReason("closed");
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
          setModalTemplate(event.data.template || null);
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
      onRequestPip,
      onExitPip,
      addUiLog,
      postToWidget,
      serverId,
      setWidgetState,
      applyMeasuredHeight,
      addCspViolation,
      checkoutCallId,
      setWidgetClosed,
      setWidgetClosedReason,
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
        // Just update debug store - localStorage events handle modal ↔ inline sync
        if (newStateStr !== previousWidgetStateRef.current) {
          previousWidgetStateRef.current = newStateStr;
          setWidgetState(resolvedToolCallId, newState);
          onWidgetStateChange?.(resolvedToolCallId, newState);
        }
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

      if (event.data?.type === "openai:callTool") {
        const callId = event.data.callId;
        const calledToolName = event.data.toolName;
        if (!onCallTool) {
          postToWidget(
            {
              type: "openai:callTool:response",
              callId,
              error: "callTool is not supported in this context",
            },
            true,
          );
          return;
        }
        (async () => {
          try {
            const result = await onCallTool(
              calledToolName,
              event.data.args || event.data.params || {},
              event.data._meta || {},
            );

            // Check for OAuth challenge per OpenAI Apps SDK spec
            const resultMeta = result?._meta || result?.meta;
            const wwwAuth = resultMeta?.["mcp/www_authenticate"];
            if (wwwAuth && typeof wwwAuth === "string") {
              handleOAuthChallenge(wwwAuth, calledToolName);
            }

            postToWidget(
              {
                type: "openai:callTool:response",
                callId,
                result,
              },
              true,
            );
          } catch (err) {
            postToWidget(
              {
                type: "openai:callTool:response",
                callId,
                error: err instanceof Error ? err.message : "Unknown error",
              },
              true,
            );
          }
        })();
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
      onCallTool,
    ],
  );

  const handleModalReady = useCallback(() => {
    setModalSandboxReady(true);
    // Widget state is loaded from localStorage by widget-runtime initialization
    // Push current globals
    const globals: Record<string, unknown> = {
      theme: themeMode,
      displayMode: "inline",
      maxHeight: null,
      locale,
      safeArea: { insets: safeAreaInsets },
      userAgent: {
        device: { type: deviceType },
        capabilities,
      },
      toolInput: resolvedToolInput,
      toolOutput: resolvedToolOutput,
    };
    if (initialWidgetState !== undefined) {
      globals.widgetState = initialWidgetState;
    }
    modalSandboxRef.current?.postMessage({
      type: "openai:set_globals",
      globals,
    });
  }, [
    themeMode,
    locale,
    deviceType,
    capabilities,
    safeAreaInsets,
    resolvedToolInput,
    resolvedToolOutput,
    initialWidgetState,
  ]);

  // Reset modal sandbox state when modal closes
  useEffect(() => {
    if (!modalOpen) {
      setModalSandboxReady(false);
      setModalTemplate(null);
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
      displayMode: effectiveDisplayMode,
      locale,
      safeArea: { insets: safeAreaInsets },
      userAgent: {
        device: { type: deviceType },
        capabilities,
      },
      // Keep tool data in sync for live editing, including offline cached views.
      toolInput: resolvedToolInput,
      toolOutput: resolvedToolOutput,
    };
    if (initialWidgetState !== undefined) {
      globals.widgetState = initialWidgetState;
    }
    if (typeof maxHeight === "number" && Number.isFinite(maxHeight))
      globals.maxHeight = maxHeight;
    postToWidget({ type: "openai:set_globals", globals });
    if (modalOpen) postToWidget({ type: "openai:set_globals", globals }, true);
  }, [
    themeMode,
    maxHeight,
    effectiveDisplayMode,
    locale,
    deviceType,
    capabilities,
    safeAreaInsets,
    resolvedToolInput,
    resolvedToolOutput,
    initialWidgetState,
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

  // Denied state
  if (toolState === "output-denied") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Tool execution was denied.
      </div>
    );
  }

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
        {widgetClosedReason === "closed"
          ? "Widget closed."
          : invokedText || "Tool completed successfully."}
      </div>
    );
  // Only show "unable to render" if we have no outputTemplate AND no cached HTML
  if (!outputTemplate && !cachedWidgetHtmlUrl) {
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
      return "fixed inset-0 z-40 w-full h-full bg-background flex flex-col";
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
        <div className="flex items-center justify-between px-4 h-14 border-b border-border/40 bg-background/95 backdrop-blur z-40 shrink-0">
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
            effectiveDisplayMode === "pip" && !isMobilePlaygroundMode
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
        <DialogContent className="w-fit max-w-[90vw] h-fit max-h-[70vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{modalTitle}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 w-full h-full min-h-0 overflow-y-auto">
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
        serverInfo={serverInfo ?? { name: serverId }}
        onCallTool={onCallTool}
      />
    </div>
  );
}
