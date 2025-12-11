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

import { useRef, useState, useEffect, useCallback, useMemo } from "react";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useUIPlaygroundStore,
  DEVICE_VIEWPORT_CONFIGS,
  type CspMode,
  type DeviceType,
} from "@/stores/ui-playground-store";
import { X } from "lucide-react";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { useTrafficLogStore, extractMethod } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

type DisplayMode = "inline" | "pip" | "fullscreen";
type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

// CSP metadata type per SEP-1865
interface UIResourceCSP {
  connectDomains?: string[];
  resourceDomains?: string[];
}

interface MCPAppsRendererProps {
  serverId: string;
  toolCallId: string;
  toolName: string;
  toolState?: ToolState;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  resourceUri: string;
  toolMetadata?: Record<string, unknown>;
  onSendFollowUp?: (text: string) => void;
  onCallTool?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
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

interface JSONRPCMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export function MCPAppsRenderer({
  serverId,
  toolCallId,
  toolName,
  toolState,
  toolInput,
  toolOutput,
  resourceUri,
  toolMetadata,
  onSendFollowUp,
  onCallTool,
  pipWidgetId,
  onRequestPip,
  onExitPip,
  displayMode: displayModeProp,
  onDisplayModeChange,
  onRequestFullscreen,
  onExitFullscreen,
}: MCPAppsRendererProps) {
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);

  // Get CSP mode from playground store when in playground, otherwise use permissive
  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const playgroundCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  const cspMode: CspMode = isPlaygroundActive
    ? playgroundCspMode
    : "permissive";

  // Get locale and timeZone from playground store when active, fallback to browser defaults
  const playgroundLocale = useUIPlaygroundStore((s) => s.globals.locale);
  const playgroundTimeZone = useUIPlaygroundStore((s) => s.globals.timeZone);
  const locale = isPlaygroundActive
    ? playgroundLocale
    : navigator.language || "en-US";
  const timeZone = isPlaygroundActive
    ? playgroundTimeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  // Get displayMode from playground store when active (SEP-1865)
  const playgroundDisplayMode = useUIPlaygroundStore((s) => s.displayMode);

  // Get device capabilities from playground store (SEP-1865)
  const playgroundCapabilities = useUIPlaygroundStore((s) => s.capabilities);
  const deviceCapabilities = useMemo(
    () =>
      isPlaygroundActive
        ? playgroundCapabilities
        : { hover: true, touch: false }, // Desktop defaults
    [isPlaygroundActive, playgroundCapabilities],
  );

  // Get safe area insets from playground store (SEP-1865)
  const playgroundSafeAreaInsets = useUIPlaygroundStore(
    (s) => s.safeAreaInsets,
  );
  const safeAreaInsets = useMemo(
    () =>
      isPlaygroundActive
        ? playgroundSafeAreaInsets
        : { top: 0, right: 0, bottom: 0, left: 0 },
    [isPlaygroundActive, playgroundSafeAreaInsets],
  );

  // Get device type from playground store for platform/viewport derivation (SEP-1865)
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);

  // Derive platform from device type per SEP-1865 (web | desktop | mobile)
  const platform = useMemo((): "web" | "desktop" | "mobile" => {
    if (!isPlaygroundActive) return "web";
    switch (playgroundDeviceType) {
      case "mobile":
      case "tablet":
        return "mobile";
      case "desktop":
      default:
        return "web";
    }
  }, [isPlaygroundActive, playgroundDeviceType]);

  // Derive viewport dimensions from device type (using shared config)
  const viewportWidth = useMemo(() => {
    if (!isPlaygroundActive) return 400;
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType]?.width ?? 400;
  }, [isPlaygroundActive, playgroundDeviceType]);

  const viewportHeight = useMemo(() => {
    if (!isPlaygroundActive) return 400;
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType]?.height ?? 400;
  }, [isPlaygroundActive, playgroundDeviceType]);

  // Display mode: controlled (via props) or uncontrolled (internal state)
  const isControlled = displayModeProp !== undefined;
  const [internalDisplayMode, setInternalDisplayMode] = useState<DisplayMode>(
    isPlaygroundActive ? playgroundDisplayMode : "inline",
  );
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
  const [contentHeight, setContentHeight] = useState<number>(400);

  // maxHeight should match the device's viewport height (max available space)
  const maxHeight = useMemo(() => {
    if (!isPlaygroundActive) return 800;
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType]?.height ?? 800;
  }, [isPlaygroundActive, playgroundDeviceType]);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [widgetCsp, setWidgetCsp] = useState<UIResourceCSP | undefined>(
    undefined,
  );
  const [widgetPermissive, setWidgetPermissive] = useState<boolean>(false);
  const [loadedCspMode, setLoadedCspMode] = useState<CspMode | null>(null);
  // SEP-1865 mimetype validation
  const [mimeTypeWarning, setMimeTypeWarning] = useState<string | null>(null);

  const pendingRequests = useRef<
    Map<
      number | string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >
  >(new Map());

  // Fetch widget HTML when tool output is available or CSP mode changes
  useEffect(() => {
    if (toolState !== "output-available") return;
    // Re-fetch if CSP mode changed (widget needs to reload with new CSP policy)
    if (widgetHtml && loadedCspMode === cspMode) return;

    const fetchWidgetHtml = async () => {
      try {
        // Store widget data first (same pattern as openai.ts)
        const storeResponse = await fetch("/api/mcp/apps/widget/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId,
            resourceUri,
            toolInput,
            toolOutput,
            toolId: toolCallId,
            toolName,
            theme: themeMode,
            protocol: "mcp-apps",
            cspMode, // Pass CSP mode preference
          }),
        });

        if (!storeResponse.ok) {
          throw new Error(
            `Failed to store widget: ${storeResponse.statusText}`,
          );
        }

        // Fetch widget content with CSP metadata (SEP-1865)
        const contentResponse = await fetch(
          `/api/mcp/apps/widget-content/${toolCallId}?csp_mode=${cspMode}`,
        );
        if (!contentResponse.ok) {
          const errorData = await contentResponse.json().catch(() => ({}));
          throw new Error(
            errorData.error ||
              `Failed to fetch widget: ${contentResponse.statusText}`,
          );
        }

        const {
          html,
          csp,
          permissive,
          mimeTypeWarning: warning,
        } = await contentResponse.json();
        setWidgetHtml(html);
        setWidgetCsp(csp);
        setWidgetPermissive(permissive ?? false);
        setLoadedCspMode(cspMode);
        setMimeTypeWarning(warning ?? null);
      } catch (err) {
        setLoadError(
          err instanceof Error ? err.message : "Failed to prepare widget",
        );
      }
    };

    fetchWidgetHtml();
  }, [
    toolState,
    toolCallId,
    widgetHtml,
    loadedCspMode,
    serverId,
    resourceUri,
    toolInput,
    toolOutput,
    toolName,
    themeMode,
    cspMode,
  ]);

  // UI logging
  const addUiLog = useTrafficLogStore((s) => s.addLog);

  // Widget debug store
  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);
  const clearCspViolations = useWidgetDebugStore((s) => s.clearCspViolations);

  // Clear CSP violations when CSP mode changes (stale data from previous mode)
  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      clearCspViolations(toolCallId);
    }
  }, [cspMode, loadedCspMode, toolCallId, clearCspViolations]);

  // Sync displayMode from playground store when it changes (SEP-1865)
  // Only sync when not in controlled mode (parent controls displayMode via props)
  useEffect(() => {
    if (isPlaygroundActive && !isControlled) {
      setInternalDisplayMode(playgroundDisplayMode);
    }
  }, [isPlaygroundActive, playgroundDisplayMode, isControlled]);

  // Initialize widget debug info
  useEffect(() => {
    setWidgetDebugInfo(toolCallId, {
      toolName,
      protocol: "mcp-apps",
      widgetState: null, // MCP Apps don't have widget state in the same way
      globals: {
        theme: themeMode,
        displayMode,
        maxHeight,
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
    themeMode,
    displayMode,
    maxHeight,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
  ]);

  // Update globals in debug store when they change
  useEffect(() => {
    setWidgetGlobals(toolCallId, {
      theme: themeMode,
      displayMode,
      maxHeight,
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
    });
  }, [
    toolCallId,
    themeMode,
    displayMode,
    maxHeight,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    setWidgetGlobals,
  ]);

  // JSON-RPC helpers
  const postMessage = useCallback(
    (data: unknown) => {
      // Log outgoing message
      addUiLog({
        widgetId: toolCallId,
        serverId,
        direction: "host-to-ui",
        protocol: "mcp-apps",
        method: extractMethod(data, "mcp-apps"),
        message: data,
      });
      sandboxRef.current?.postMessage(data);
    },
    [addUiLog, toolCallId, serverId],
  );

  const sendNotification = useCallback(
    (method: string, params: unknown) => {
      postMessage({ jsonrpc: "2.0", method, params });
    },
    [postMessage],
  );

  const sendResponse = useCallback(
    (
      id: number | string,
      result?: unknown,
      error?: { code: number; message: string },
    ) => {
      postMessage({
        jsonrpc: "2.0",
        id,
        ...(error ? { error } : { result: result ?? {} }),
      });
    },
    [postMessage],
  );

  // Handle messages from guest UI (via SandboxedIframe)
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      // Handle CSP violation messages (not JSON-RPC)
      if (event.data?.type === "mcp-apps:csp-violation") {
        const {
          directive,
          blockedUri,
          sourceFile,
          lineNumber,
          columnNumber,
          effectiveDirective,
          timestamp,
        } = event.data;

        // Log incoming CSP violation
        addUiLog({
          widgetId: toolCallId,
          serverId,
          direction: "ui-to-host",
          protocol: "mcp-apps",
          method: "csp-violation",
          message: event.data,
        });

        // Add violation to widget debug store for display in CSP panel
        addCspViolation(toolCallId, {
          directive,
          effectiveDirective,
          blockedUri,
          sourceFile,
          lineNumber,
          columnNumber,
          timestamp: timestamp || Date.now(),
        });

        // Also log to console for developers
        console.warn(
          `[MCP Apps CSP Violation] ${directive}: Blocked ${blockedUri}`,
          sourceFile ? `at ${sourceFile}:${lineNumber}:${columnNumber}` : "",
        );
        return;
      }

      const { jsonrpc, id, method, params, result, error } =
        event.data as JSONRPCMessage;

      // Not a JSON-RPC message
      if (jsonrpc !== "2.0") return;

      // Log incoming message
      addUiLog({
        widgetId: toolCallId,
        serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: extractMethod(event.data, "mcp-apps"),
        message: event.data,
      });

      // Handle responses to our requests
      if (id !== undefined && !method) {
        const pending = pendingRequests.current.get(id);
        if (pending) {
          pendingRequests.current.delete(id);
          if (error) {
            pending.reject(new Error(error.message || "Unknown error"));
          } else {
            pending.resolve(result);
          }
        }
        return;
      }

      // Handle requests from guest UI
      if (method && id !== undefined) {
        switch (method) {
          case "ui/initialize": {
            // Respond with host context (per SEP-1865)
            sendResponse(id, {
              protocolVersion: "2025-11-25",
              hostCapabilities: {},
              hostInfo: { name: "mcpjam-inspector", version: __APP_VERSION__ },
              hostContext: {
                theme: themeMode,
                displayMode,
                availableDisplayModes: ["inline", "pip", "fullscreen"],
                viewport: {
                  width: viewportWidth,
                  height: viewportHeight,
                  maxHeight,
                },
                locale,
                timeZone,
                platform,
                userAgent: navigator.userAgent,
                deviceCapabilities,
                safeAreaInsets,
                toolInfo: {
                  id: toolCallId,
                  tool: {
                    name: toolName,
                    inputSchema: (toolMetadata?.inputSchema as object) ?? {
                      type: "object",
                    },
                    ...(toolMetadata?.description && {
                      description: toolMetadata.description,
                    }),
                  },
                },
              },
            });
            setIsReady(true);
            break;
          }

          case "tools/call": {
            if (!onCallTool) {
              sendResponse(id, undefined, {
                code: -32601,
                message: "Tool calls not supported",
              });
              break;
            }
            try {
              const callParams = params as {
                name: string;
                arguments?: Record<string, unknown>;
              };
              const result = await onCallTool(
                callParams.name,
                callParams.arguments || {},
              );
              sendResponse(id, result);
            } catch (err) {
              sendResponse(id, undefined, {
                code: -32000,
                message:
                  err instanceof Error ? err.message : "Tool call failed",
              });
            }
            break;
          }

          case "resources/read": {
            try {
              const readParams = params as { uri: string };
              const response = await fetch(`/api/mcp/resources/read`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ serverId, uri: readParams.uri }),
              });
              const result = await response.json();
              // API returns { content: { contents: [...] } }, SDK expects { contents: [...] }
              sendResponse(id, result.content);
            } catch (err) {
              sendResponse(id, undefined, {
                code: -32000,
                message:
                  err instanceof Error ? err.message : "Resource read failed",
              });
            }
            break;
          }

          case "ui/open-link": {
            const linkParams = params as { url?: string };
            if (linkParams.url) {
              window.open(linkParams.url, "_blank", "noopener,noreferrer");
            }
            sendResponse(id, {});
            break;
          }

          case "ui/message": {
            // SEP-1865 specifies: { role: "user", content: { type: "text", text: "..." } }
            // SDK sends array:    { role: "user", content: [{ type: "text", text: "..." }] }
            // Support both formats for compatibility
            const messageParams = params as {
              role?: string;
              content?:
                | { type: string; text?: string }
                | Array<{ type: string; text?: string }>;
            };
            const textContent = Array.isArray(messageParams.content)
              ? messageParams.content.find((c) => c.type === "text")?.text
              : messageParams.content?.type === "text"
                ? messageParams.content.text
                : undefined;
            if (onSendFollowUp && textContent) {
              onSendFollowUp(textContent);
            }
            sendResponse(id, {});
            break;
          }

          default:
            sendResponse(id, undefined, {
              code: -32601,
              message: `Method not found: ${method}`,
            });
        }
        return;
      }

      // Handle notifications from guest UI
      if (method && id === undefined) {
        switch (method) {
          case "ui/notifications/initialized":
            // Guest UI finished initialization, send tool data
            if (toolInput) {
              sendNotification("ui/notifications/tool-input", {
                arguments: toolInput,
              });
            }
            if (toolOutput && toolState === "output-available") {
              sendNotification("ui/notifications/tool-result", toolOutput);
            }
            break;

          case "ui/notifications/size-changed": // SEP-1865 spec
          case "ui/notifications/size-change": {
            // Support both for backwards compatibility
            const sizeParams = params as { height?: number };
            if (typeof sizeParams.height === "number") {
              setContentHeight(Math.min(sizeParams.height, maxHeight));
            }
            break;
          }

          case "notifications/message":
            console.log("[MCP Apps] Guest log:", params);
            break;
        }
      }
    },
    [
      themeMode,
      displayMode,
      contentHeight,
      maxHeight,
      locale,
      timeZone,
      platform,
      viewportWidth,
      deviceCapabilities,
      safeAreaInsets,
      toolName,
      toolMetadata,
      onCallTool,
      onSendFollowUp,
      serverId,
      toolCallId,
      toolInput,
      toolOutput,
      toolState,
      sendResponse,
      sendNotification,
      addUiLog,
      addCspViolation,
    ],
  );

  // Track previous host context to send only changed fields (per SEP-1865)
  const prevHostContextRef = useRef<{
    theme: string;
    displayMode: DisplayMode;
    locale: string;
    timeZone: string;
    platform: "web" | "desktop" | "mobile";
    viewportWidth: number;
    viewportHeight: number;
    maxHeight: number;
    deviceCapabilities: { touch?: boolean; hover?: boolean };
    safeAreaInsets: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
  } | null>(null);

  // Send host-context-changed notifications when any context field changes
  useEffect(() => {
    if (!isReady) return;

    const currentContext = {
      theme: themeMode,
      displayMode,
      locale,
      timeZone,
      platform,
      viewportWidth,
      viewportHeight,
      maxHeight,
      deviceCapabilities,
      safeAreaInsets,
    };

    // Skip initial mount - context was already sent in initialize response
    if (prevHostContextRef.current === null) {
      prevHostContextRef.current = currentContext;
      return;
    }

    // Build partial update with only changed fields (per SEP-1865 spec)
    const changedFields: Record<string, unknown> = {};
    if (prevHostContextRef.current.theme !== themeMode) {
      changedFields.theme = themeMode;
    }
    if (prevHostContextRef.current.displayMode !== displayMode) {
      changedFields.displayMode = displayMode;
    }
    if (prevHostContextRef.current.locale !== locale) {
      changedFields.locale = locale;
    }
    if (prevHostContextRef.current.timeZone !== timeZone) {
      changedFields.timeZone = timeZone;
    }
    if (prevHostContextRef.current.platform !== platform) {
      changedFields.platform = platform;
    }
    // Send full viewport object when any viewport property changes
    if (
      prevHostContextRef.current.viewportWidth !== viewportWidth ||
      prevHostContextRef.current.viewportHeight !== viewportHeight ||
      prevHostContextRef.current.maxHeight !== maxHeight
    ) {
      changedFields.viewport = {
        width: viewportWidth,
        height: viewportHeight,
        maxHeight,
      };
    }
    // Compare deviceCapabilities (simple object with booleans)
    const prevCaps = prevHostContextRef.current.deviceCapabilities;
    if (
      prevCaps.touch !== deviceCapabilities.touch ||
      prevCaps.hover !== deviceCapabilities.hover
    ) {
      changedFields.deviceCapabilities = deviceCapabilities;
    }
    // Compare safeAreaInsets (simple object with numbers)
    const prevInsets = prevHostContextRef.current.safeAreaInsets;
    if (
      prevInsets.top !== safeAreaInsets.top ||
      prevInsets.right !== safeAreaInsets.right ||
      prevInsets.bottom !== safeAreaInsets.bottom ||
      prevInsets.left !== safeAreaInsets.left
    ) {
      changedFields.safeAreaInsets = safeAreaInsets;
    }

    // Only send notification if something changed
    if (Object.keys(changedFields).length > 0) {
      prevHostContextRef.current = currentContext;
      sendNotification("ui/notifications/host-context-changed", changedFields);
    }
  }, [
    themeMode,
    displayMode,
    locale,
    timeZone,
    platform,
    viewportWidth,
    viewportHeight,
    maxHeight,
    deviceCapabilities,
    safeAreaInsets,
    isReady,
    sendNotification,
  ]);

  // Loading states
  if (toolState !== "output-available") {
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Waiting for tool to finish executing...
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
    return (
      <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
        Preparing MCP App widget...
      </div>
    );
  }

  const isPip =
    displayMode === "pip" && (isControlled || pipWidgetId === toolCallId);
  const isFullscreen = displayMode === "fullscreen";
  // Apply maxHeight constraint, but no minimum - let widget control its size
  const appliedHeight = Math.min(contentHeight, maxHeight);

  let containerClassName = "mt-3 space-y-2 relative group";
  if (isFullscreen) {
    containerClassName =
      "fixed inset-0 z-50 w-full h-full bg-background flex flex-col";
  } else if (isPip) {
    containerClassName = [
      "fixed top-4 inset-x-0 z-40 w-full max-w-4xl mx-auto space-y-2",
      "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
      "shadow-xl border border-border/60 rounded-xl p-3",
    ].join(" ");
  }

  return (
    <div className={containerClassName}>
      {(isPip || isFullscreen) && (
        <button
          onClick={() => {
            setDisplayMode("inline");
            if (isPip) {
              onExitPip?.(toolCallId);
            }
            // onExitFullscreen is called within setDisplayMode when leaving fullscreen
          }}
          className="absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-background/80 hover:bg-background border border-border/50 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      )}

      {/* Uses SandboxedIframe for DRY double-iframe architecture */}
      <SandboxedIframe
        ref={sandboxRef}
        html={widgetHtml}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        csp={widgetCsp}
        permissive={widgetPermissive}
        onMessage={handleMessage}
        title={`MCP App: ${toolName}`}
        className="w-full border border-border/40 rounded-md bg-background transition-[height] duration-200 ease-out overflow-auto"
        style={{
          height: isFullscreen ? "100%" : `${appliedHeight}px`,
        }}
      />

      <div className="text-[11px] text-muted-foreground/70">
        MCP App: <code>{resourceUri}</code>
        {mimeTypeWarning && (
          <span className="ml-2 text-amber-600 dark:text-amber-500">
            · {mimeTypeWarning}
          </span>
        )}
      </div>
    </div>
  );
}
