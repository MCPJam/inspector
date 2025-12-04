import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { X, Loader2 } from "lucide-react";
import { useUiLogStore, extractMethod } from "@/stores/ui-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  ChatGPTSandboxedIframe,
  ChatGPTSandboxedIframeHandle,
} from "@/components/ui/chatgpt-sandboxed-iframe";
import { toast } from "sonner";

type DisplayMode = "inline" | "pip" | "fullscreen";
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
) {
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [widgetClosed, setWidgetClosed] = useState(false);
  const [isStoringWidget, setIsStoringWidget] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);

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
        const locale = navigator.language || "en-US";
        const deviceType = getDeviceType();
        const userLocation = await getUserLocation(); // Coarse IP-based location

        const storeResponse = await fetch("/api/mcp/openai/widget/store", {
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
            deviceType, // Device type from host
            userLocation, // Coarse location { country, region, city } or null
          }),
        });
        if (!storeResponse.ok)
          throw new Error(
            `Failed to store widget data: ${storeResponse.statusText}`,
          );
        if (isCancelled) return;

        // Check if widget should close
        const htmlResponse = await fetch(
          `/api/mcp/openai/widget-html/${resolvedToolCallId}`,
        );
        if (htmlResponse.ok) {
          const data = await htmlResponse.json();
          if (data.closeWidget) {
            setWidgetClosed(true);
            setIsStoringWidget(false);
            return;
          }
        }

        // Set the widget URL - the widget will be loaded via src, not srcdoc
        setWidgetUrl(`/api/mcp/openai/widget/${resolvedToolCallId}`);
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
  ]);

  return { widgetUrl, widgetClosed, isStoringWidget, storeError };
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
}: ChatGPTAppRendererProps) {
  const sandboxRef = useRef<ChatGPTSandboxedIframeHandle>(null);
  const modalSandboxRef = useRef<ChatGPTSandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("inline");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(320);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, any>>({});
  const [modalTitle, setModalTitle] = useState<string>("");
  const previousWidgetStateRef = useRef<string | null>(null);
  const [currentWidgetState, setCurrentWidgetState] = useState<unknown>(null);
  const [modalSandboxReady, setModalSandboxReady] = useState(false);

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
  const { widgetUrl, widgetClosed, isStoringWidget, storeError } =
    useWidgetFetch(
      toolState,
      resolvedToolCallId,
      outputTemplate,
      toolName,
      serverId,
      resolvedToolInput,
      resolvedToolOutput,
      toolResponseMetadata,
      themeMode,
    );

  const appliedHeight = useMemo(() => {
    const baseHeight = contentHeight > 0 ? contentHeight : 320;
    return typeof maxHeight === "number" && Number.isFinite(maxHeight)
      ? Math.min(baseHeight, maxHeight)
      : baseHeight;
  }, [contentHeight, maxHeight]);

  const iframeHeight = useMemo(() => {
    if (displayMode === "fullscreen") return "100%";
    if (displayMode === "pip")
      return pipWidgetId === resolvedToolCallId
        ? "400px"
        : `${appliedHeight}px`;
    return `${appliedHeight}px`;
  }, [appliedHeight, displayMode, pipWidgetId, resolvedToolCallId]);

  const modalWidgetUrl = useMemo(() => {
    if (!widgetUrl || !modalOpen) return null;
    const url = new URL(widgetUrl, window.location.origin);
    url.searchParams.set("view_mode", "modal");
    url.searchParams.set("view_params", JSON.stringify(modalParams));
    return url.toString();
  }, [widgetUrl, modalOpen, modalParams]);

  const addUiLog = useUiLogStore((s) => s.addLog);
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetState = useWidgetDebugStore((s) => s.setWidgetState);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);

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
        locale: "en-US",
        safeArea: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
        userAgent: {
          device: { type: "desktop" },
          capabilities: { hover: true, touch: false },
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
  ]);

  useEffect(() => {
    setWidgetGlobals(resolvedToolCallId, {
      theme: themeMode,
      displayMode,
      maxHeight: maxHeight ?? undefined,
    });
  }, [resolvedToolCallId, themeMode, displayMode, maxHeight, setWidgetGlobals]);

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

  const handleSandboxMessage = useCallback(
    async (event: MessageEvent) => {
      if (event.data?.type)
        addUiLog({
          widgetId: resolvedToolCallId,
          serverId,
          direction: "ui-to-host",
          protocol: "openai-apps",
          method: extractMethod(event.data, "openai-apps"),
          message: event.data,
        });

      switch (event.data?.type) {
        case "openai:resize": {
          const rawHeight = Number(event.data.height);
          if (Number.isFinite(rawHeight) && rawHeight > 0)
            setContentHeight((prev) =>
              Math.abs(prev - Math.round(rawHeight)) > 1
                ? Math.round(rawHeight)
                : prev,
            );
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

            // Send full result to widget - let the widget handle the result structure
            const responseError = result?.isError
              ? result?.content?.[0]?.text || "Tool returned an error"
              : undefined;
            postToWidget({
              type: "openai:callTool:response",
              callId,
              result,
              error: responseError,
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
          const { directive, blockedUri, sourceFile, lineNumber } = event.data;
          console.warn(
            `[ChatGPT Widget CSP] Blocked ${blockedUri} by ${directive}`,
            sourceFile ? `at ${sourceFile}:${lineNumber}` : "",
          );
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
        case "openai:requestModal": {
          setModalTitle(event.data.title || "Modal");
          setModalParams(event.data.params || {});
          setModalOpen(true);
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
    },
    [
      addUiLog,
      resolvedToolCallId,
      serverId,
      setWidgetState,
      onWidgetStateChange,
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
      },
    });
  }, [currentWidgetState, resolvedToolCallId, themeMode]);

  // Reset modal sandbox state when modal closes
  useEffect(() => {
    if (!modalOpen) {
      setModalSandboxReady(false);
    }
  }, [modalOpen]);

  useEffect(() => {
    if (displayMode === "pip" && pipWidgetId !== resolvedToolCallId)
      setDisplayMode("inline");
  }, [displayMode, pipWidgetId, resolvedToolCallId]);

  useEffect(() => {
    if (!isReady) return;
    const globals: Record<string, unknown> = { theme: themeMode, displayMode };
    if (typeof maxHeight === "number" && Number.isFinite(maxHeight))
      globals.maxHeight = maxHeight;
    postToWidget({ type: "openai:set_globals", globals });
    if (modalOpen) postToWidget({ type: "openai:set_globals", globals }, true);
  }, [themeMode, maxHeight, displayMode, isReady, modalOpen, postToWidget]);

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

  const isPip = displayMode === "pip" && pipWidgetId === resolvedToolCallId;
  const isFullscreen = displayMode === "fullscreen";
  const containerClassName = isFullscreen
    ? "fixed inset-0 z-50 w-full h-full bg-background flex flex-col"
    : isPip
      ? "fixed top-4 inset-x-0 z-40 w-full max-w-4xl mx-auto space-y-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-xl border border-border/60 rounded-xl p-3"
      : "mt-3 space-y-2 relative group";

  return (
    <div className={containerClassName}>
      {(isPip || isFullscreen) && (
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
        onMessage={handleSandboxMessage}
        onReady={() => {
          setIsReady(true);
          setLoadError(null);
        }}
        title={`ChatGPT App Widget: ${toolName || "tool"}`}
        className="w-full border border-border/40 rounded-md bg-background"
        style={{
          height: iframeHeight,
          maxHeight: displayMode === "fullscreen" ? "90vh" : undefined,
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
                className="w-full h-full border-0 rounded-md bg-background"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
