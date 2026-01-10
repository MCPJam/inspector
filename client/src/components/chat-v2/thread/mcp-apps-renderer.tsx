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
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  useUIPlaygroundStore,
  DEVICE_VIEWPORT_CONFIGS,
  type CspMode,
} from "@/stores/ui-playground-store";
import { X } from "lucide-react";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { useTrafficLogStore, extractMethod } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { getMcpAppsStyleVariables } from "./mcp-apps-renderer-helper";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

// Default input schema for tools without metadata
const DEFAULT_INPUT_SCHEMA = { type: "object" } as const;

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
  toolErrorText?: string;
  resourceUri: string;
  toolMetadata?: Record<string, unknown>;
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
}

class LoggingTransport implements Transport {
  private inner: Transport;
  private onSend?: (message: JSONRPCMessage) => void;
  private onReceive?: (message: JSONRPCMessage) => void;
  private _sessionId?: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
  setProtocolVersion?: (version: string) => void;

  constructor(
    inner: Transport,
    handlers: {
      onSend?: (message: JSONRPCMessage) => void;
      onReceive?: (message: JSONRPCMessage) => void;
    },
  ) {
    this.inner = inner;
    this.onSend = handlers.onSend;
    this.onReceive = handlers.onReceive;
  }

  get sessionId() {
    return this._sessionId ?? this.inner.sessionId;
  }

  set sessionId(value: string | undefined) {
    this._sessionId = value;
    this.inner.sessionId = value;
  }

  async start() {
    this.inner.onmessage = (message, extra) => {
      this.onReceive?.(message);
      this.onmessage?.(message, extra);
    };
    this.inner.onerror = (error) => {
      this.onerror?.(error);
    };
    this.inner.onclose = () => {
      this.onclose?.();
    };
    this.inner.setProtocolVersion = (version) => {
      this.setProtocolVersion?.(version);
    };
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions) {
    this.onSend?.(message);
    await this.inner.send(message, options);
  }

  async close() {
    await this.inner.close();
  }
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

  // Get device type and custom viewport from playground store for platform/viewport derivation (SEP-1865)
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);

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

  // Derive viewport dimensions from device type (using shared config + custom viewport)
  const viewportWidth = useMemo(() => {
    if (!isPlaygroundActive) return 400;
    if (playgroundDeviceType === "custom") {
      return customViewport.width;
    }
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType].width;
  }, [isPlaygroundActive, playgroundDeviceType, customViewport]);

  const viewportHeight = useMemo(() => {
    if (!isPlaygroundActive) return 400;
    if (playgroundDeviceType === "custom") {
      return customViewport.height;
    }
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType].height;
  }, [isPlaygroundActive, playgroundDeviceType, customViewport]);

  // Display mode: controlled (via props) or uncontrolled (internal state)
  const isControlled = displayModeProp !== undefined;
  const [internalDisplayMode, setInternalDisplayMode] = useState<DisplayMode>(
    isPlaygroundActive ? playgroundDisplayMode : "inline",
  );
  const displayMode = isControlled ? displayModeProp : internalDisplayMode;
  const effectiveDisplayMode = useMemo<DisplayMode>(() => {
    if (!isControlled) return displayMode;
    if (displayMode === "fullscreen" && fullscreenWidgetId === toolCallId)
      return "fullscreen";
    if (displayMode === "pip" && pipWidgetId === toolCallId) return "pip";
    return "inline";
  }, [displayMode, fullscreenWidgetId, isControlled, pipWidgetId, toolCallId]);
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

  // maxHeight is sent to guest UI as part of viewport info (SEP-1865 protocol)
  // Note: We no longer use this to clamp resize, but apps may use it for layout decisions
  const maxHeight = useMemo(() => {
    if (!isPlaygroundActive) return 800;
    if (playgroundDeviceType === "custom") {
      return customViewport.height;
    }
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType].height;
  }, [isPlaygroundActive, playgroundDeviceType, customViewport]);

  const maxWidth = useMemo(() => {
    if (!isPlaygroundActive) return 1200;
    if (playgroundDeviceType === "custom") {
      return customViewport.width;
    }
    return DEVICE_VIEWPORT_CONFIGS[playgroundDeviceType].width;
  }, [isPlaygroundActive, playgroundDeviceType, customViewport]);

  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [widgetCsp, setWidgetCsp] = useState<UIResourceCSP | undefined>(
    undefined,
  );
  const [widgetPermissive, setWidgetPermissive] = useState<boolean>(false);
  const [prefersBorder, setPrefersBorder] = useState<boolean>(true);
  const [loadedCspMode, setLoadedCspMode] = useState<CspMode | null>(null);

  const bridgeRef = useRef<AppBridge | null>(null);
  const hostContextRef = useRef<McpUiHostContext | null>(null);
  const lastToolInputRef = useRef<string | null>(null);
  const lastToolOutputRef = useRef<string | null>(null);
  const lastToolErrorRef = useRef<string | null>(null);
  const isReadyRef = useRef(false);

  const onSendFollowUpRef = useRef(onSendFollowUp);
  const onCallToolRef = useRef(onCallTool);
  const onRequestPipRef = useRef(onRequestPip);
  const onExitPipRef = useRef(onExitPip);
  const setDisplayModeRef = useRef(setDisplayMode);
  const viewportWidthRef = useRef(viewportWidth);
  const effectiveDisplayModeRef = useRef(effectiveDisplayMode);
  const serverIdRef = useRef(serverId);
  const toolCallIdRef = useRef(toolCallId);
  const pipWidgetIdRef = useRef(pipWidgetId);

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
          mimeTypeValid: valid,
          prefersBorder,
        } = await contentResponse.json();

        if (!valid) {
          setLoadError(
            warning ||
              `Invalid mimetype - SEP-1865 requires "text/html;profile=mcp-app"`,
          );
          return;
        }

        setWidgetHtml(html);
        setWidgetCsp(csp);
        setWidgetPermissive(permissive ?? false);
        setPrefersBorder(prefersBorder ?? true);
        setLoadedCspMode(cspMode);
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

  // Reset ready state and refs when CSP mode changes (widget will reinitialize)
  // This ensures tool input/output are re-sent after CSP mode switch
  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      setIsReady(false);
      isReadyRef.current = false;
      lastToolInputRef.current = null;
      lastToolOutputRef.current = null;
      lastToolErrorRef.current = null;
    }
  }, [cspMode, loadedCspMode]);

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
        displayMode: effectiveDisplayMode,
        maxHeight,
        maxWidth,
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
    effectiveDisplayMode,
    maxHeight,
    maxWidth,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
  ]);

  // Update globals in debug store when they change
  useEffect(() => {
    setWidgetGlobals(toolCallId, {
      theme: themeMode,
      displayMode: effectiveDisplayMode,
      maxHeight,
      maxWidth,
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
    });
  }, [
    toolCallId,
    themeMode,
    effectiveDisplayMode,
    maxHeight,
    maxWidth,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    setWidgetGlobals,
  ]);

  // CSS Variables for theming (SEP-1865 styles.variables)
  // These are sent via hostContext.styles.variables - the SDK should pass them through
  const styleVariables = useMemo(
    () => getMcpAppsStyleVariables(themeMode),
    [themeMode],
  );

  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      theme: themeMode,
      displayMode: effectiveDisplayMode,
      availableDisplayModes: ["inline", "pip", "fullscreen"],
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
        maxHeight,
        maxWidth,
      },
      locale,
      timeZone,
      platform,
      userAgent: navigator.userAgent,
      deviceCapabilities,
      safeAreaInsets,
      styles: {
        variables: styleVariables,
      },
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
      themeMode,
      effectiveDisplayMode,
      viewportWidth,
      viewportHeight,
      maxHeight,
      maxWidth,
      locale,
      timeZone,
      platform,
      deviceCapabilities,
      safeAreaInsets,
      styleVariables,
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
    viewportWidthRef.current = viewportWidth;
    effectiveDisplayModeRef.current = effectiveDisplayMode;
    serverIdRef.current = serverId;
    toolCallIdRef.current = toolCallId;
    pipWidgetIdRef.current = pipWidgetId;
  }, [
    onSendFollowUp,
    onCallTool,
    onRequestPip,
    onExitPip,
    setDisplayMode,
    viewportWidth,
    effectiveDisplayMode,
    serverId,
    toolCallId,
    pipWidgetId,
  ]);

  const registerBridgeHandlers = useCallback(
    (bridge: AppBridge) => {
      bridge.oninitialized = () => {
        setIsReady(true);
        isReadyRef.current = true;
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
        if (!onCallToolRef.current) {
          throw new Error("Tool calls not supported");
        }
        const result = await onCallToolRef.current(
          name,
          (args ?? {}) as Record<string, unknown>,
        );
        return result as CallToolResult;
      };

      bridge.onreadresource = async ({ uri }) => {
        const response = await fetch(`/api/mcp/resources/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: serverIdRef.current, uri }),
        });
        if (!response.ok) {
          throw new Error(`Resource read failed: ${response.statusText}`);
        }
        const result = await response.json();
        return result.content;
      };

      bridge.onlistresources = async (params) => {
        const response = await fetch(`/api/mcp/resources/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId: serverIdRef.current,
            ...(params ?? {}),
          }),
        });
        if (!response.ok) {
          throw new Error(`Resource list failed: ${response.statusText}`);
        }
        return response.json();
      };

      bridge.onlistresourcetemplates = async (params) => {
        const response = await fetch(`/api/mcp/resource-templates/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId: serverIdRef.current,
            ...(params ?? {}),
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
        const response = await fetch(`/api/mcp/prompts/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId: serverIdRef.current,
            ...(params ?? {}),
          }),
        });
        if (!response.ok) {
          throw new Error(`Prompt list failed: ${response.statusText}`);
        }
        return response.json();
      };

      bridge.onloggingmessage = ({ level, data, logger }) => {
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

      bridge.onsizechange = ({ width, height }) => {
        if (effectiveDisplayModeRef.current !== "inline") return;
        const iframe = sandboxRef.current?.getIframeElement();
        if (!iframe || (height === undefined && width === undefined)) return;

        // The MCP App has requested a `width` and `height`, but if
        // `box-sizing: border-box` is applied to the outer iframe element, then we
        // must add border thickness to `width` and `height` to compute the actual
        // necessary width and height (in order to prevent a resize feedback loop).
        const style = getComputedStyle(iframe);
        const isBorderBox = style.boxSizing === "border-box";

        // Animate the change for a smooth transition.
        const from: Keyframe = {};
        const to: Keyframe = {};

        let adjustedWidth = width;
        let adjustedHeight = height;

        if (adjustedWidth !== undefined) {
          if (isBorderBox) {
            adjustedWidth +=
              parseFloat(style.borderLeftWidth) +
              parseFloat(style.borderRightWidth);
          }
          // Use width with min(..., 100%) so the iframe can both grow and shrink
          // dynamically based on widget requests, while respecting container bounds.
          from.width = `${iframe.offsetWidth}px`;
          iframe.style.width = to.width = `min(${adjustedWidth}px, 100%)`;
        }
        if (adjustedHeight !== undefined) {
          if (isBorderBox) {
            adjustedHeight +=
              parseFloat(style.borderTopWidth) +
              parseFloat(style.borderBottomWidth);
          }
          from.height = `${iframe.offsetHeight}px`;
          iframe.style.height = to.height = `${adjustedHeight}px`;
        }

        iframe.animate([from, to], { duration: 300, easing: "ease-out" });
      };

      bridge.onrequestdisplaymode = async ({ mode }) => {
        const requestedMode = mode ?? "inline";
        const isMobile = viewportWidthRef.current < 768;
        const actualMode: DisplayMode =
          isMobile && requestedMode === "pip" ? "fullscreen" : requestedMode;

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
    },
    [setIsReady],
  );

  useEffect(() => {
    if (!widgetHtml) return;
    const iframe = sandboxRef.current?.getIframeElement();
    if (!iframe?.contentWindow) return;

    setIsReady(false);
    isReadyRef.current = false;

    const bridge = new AppBridge(
      null,
      { name: "mcpjam-inspector", version: __APP_VERSION__ },
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
      },
      { hostContext: hostContextRef.current ?? {} },
    );

    registerBridgeHandlers(bridge);
    bridgeRef.current = bridge;

    const transport = new LoggingTransport(
      new PostMessageTransport(iframe.contentWindow, iframe.contentWindow),
      {
        onSend: (message) => {
          addUiLog({
            widgetId: toolCallId,
            serverId,
            direction: "host-to-ui",
            protocol: "mcp-apps",
            method: extractMethod(message, "mcp-apps"),
            message,
          });
        },
        onReceive: (message) => {
          addUiLog({
            widgetId: toolCallId,
            serverId,
            direction: "ui-to-host",
            protocol: "mcp-apps",
            method: extractMethod(message, "mcp-apps"),
            message,
          });
        },
      },
    );

    let isActive = true;
    bridge.connect(transport).catch((error) => {
      if (!isActive) return;
      setLoadError(
        error instanceof Error ? error.message : "Failed to connect MCP App",
      );
    });

    return () => {
      isActive = false;
      bridgeRef.current = null;
      if (isReadyRef.current) {
        bridge.teardownResource({}).catch(() => {});
      }
      bridge.close().catch(() => {});
    };
  }, [addUiLog, serverId, toolCallId, widgetHtml, registerBridgeHandlers]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !isReady) return;
    bridge.setHostContext(hostContext);
  }, [hostContext, isReady]);

  useEffect(() => {
    if (!isReady || toolState !== "output-available") return;
    const bridge = bridgeRef.current;
    if (!bridge || lastToolInputRef.current !== null) return;

    const resolvedToolInput = toolInput ?? {};
    lastToolInputRef.current = JSON.stringify(resolvedToolInput);
    bridge.sendToolInput({ arguments: resolvedToolInput });
  }, [isReady, toolInput, toolState]);

  useEffect(() => {
    if (!isReady || toolState !== "output-available") return;
    const bridge = bridgeRef.current;
    if (!bridge || !toolOutput) return;

    const serialized = JSON.stringify(toolOutput);
    if (lastToolOutputRef.current === serialized) return;
    lastToolOutputRef.current = serialized;
    bridge.sendToolResult(toolOutput as CallToolResult);
  }, [isReady, toolOutput, toolState]);

  useEffect(() => {
    if (!isReady || toolState !== "output-error") return;
    const bridge = bridgeRef.current;
    if (!bridge) return;

    const errorMessage =
      toolErrorText ??
      (toolOutput instanceof Error
        ? toolOutput.message
        : typeof toolOutput === "string"
          ? toolOutput
          : "Tool execution failed");

    if (lastToolErrorRef.current === errorMessage) return;
    lastToolErrorRef.current = errorMessage;
    bridge.sendToolResult({
      content: [{ type: "text", text: errorMessage }],
      isError: true,
    });
  }, [isReady, toolErrorText, toolOutput, toolState]);

  useEffect(() => {
    lastToolInputRef.current = null;
    lastToolOutputRef.current = null;
    lastToolErrorRef.current = null;
  }, [toolCallId]);

  const handleSandboxMessage = (event: MessageEvent) => {
    if (event.data?.type !== "mcp-apps:csp-violation") return;
    const {
      directive,
      blockedUri,
      sourceFile,
      lineNumber,
      columnNumber,
      effectiveDirective,
      timestamp,
    } = event.data;

    addUiLog({
      widgetId: toolCallId,
      serverId,
      direction: "ui-to-host",
      protocol: "mcp-apps",
      method: "csp-violation",
      message: event.data,
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

    console.warn(
      `[MCP Apps CSP Violation] ${directive}: Blocked ${blockedUri}`,
      sourceFile ? `at ${sourceFile}:${lineNumber}:${columnNumber}` : "",
    );
  };

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
      return [
        "fixed top-4 left-1/2 -translate-x-1/2 z-40 w-fit min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
        "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "shadow-xl border border-border/60 rounded-xl p-3",
      ].join(" ");
    }

    return "mt-3 space-y-2 relative group";
  })();

  const iframeStyle: CSSProperties = {
    height: isFullscreen ? "100%" : "400px",
    width: "100%",
    maxWidth: "100%",
    transition: isFullscreen
      ? undefined
      : "height 300ms ease-out, width 300ms ease-out",
  };

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
      <SandboxedIframe
        ref={sandboxRef}
        html={widgetHtml}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        csp={widgetCsp}
        permissive={widgetPermissive}
        onMessage={handleSandboxMessage}
        title={`MCP App: ${toolName}`}
        className={`bg-background overflow-hidden ${
          isFullscreen
            ? "flex-1 border-0 rounded-none"
            : `rounded-md ${prefersBorder ? "border border-border/40" : ""}`
        }`}
        style={iframeStyle}
      />

      <div className="text-[11px] text-muted-foreground/70">
        MCP App: <code>{resourceUri}</code>
      </div>
    </div>
  );
}
