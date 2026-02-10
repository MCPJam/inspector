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
  type CspMode,
} from "@/stores/ui-playground-store";
import { X } from "lucide-react";
import {
  SandboxedIframe,
  SandboxedIframeHandle,
} from "@/components/ui/sandboxed-iframe";
import { authFetch } from "@/lib/session-token";
import { useTrafficLogStore, extractMethod } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  JSONRPCMessage,
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getClaudeDesktopStyleVariables,
  CLAUDE_DESKTOP_FONT_CSS,
  CLAUDE_DESKTOP_PLATFORM,
} from "@/config/claude-desktop-host-context";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/mcp-apps-utils";
import { LoggingTransport } from "./mcp-apps-logging-transport";
import { McpAppsModal } from "./mcp-apps-modal";

// Injected by Vite at build time from package.json
declare const __APP_VERSION__: string;

// Default input schema for tools without metadata
const DEFAULT_INPUT_SCHEMA = { type: "object" } as const;

const PARTIAL_INPUT_THROTTLE_MS = 120;
const STREAMING_REVEAL_FALLBACK_MS = 700;
const SIGNATURE_MAX_DEPTH = 4;
const SIGNATURE_MAX_ARRAY_ITEMS = 24;
const SIGNATURE_MAX_OBJECT_KEYS = 32;
const SIGNATURE_STRING_EDGE_LENGTH = 24;
const SUPPRESSED_UI_LOG_METHODS = new Set([
  "ui/notifications/tool-input-partial",
  "ui/notifications/size-changed",
]);

type DisplayMode = "inline" | "pip" | "fullscreen";
type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "output-denied";

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
}

function getToolInputSignature(
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return "";
  const seen = new WeakSet<object>();

  const getValueSignature = (value: unknown, depth: number): string => {
    if (value == null) return "null";

    const valueType = typeof value;
    if (valueType === "string") {
      const text = value as string;
      const head = text.slice(0, SIGNATURE_STRING_EDGE_LENGTH);
      const tail = text.slice(-SIGNATURE_STRING_EDGE_LENGTH);
      return `str:${text.length}:${JSON.stringify(head)}:${JSON.stringify(tail)}`;
    }
    if (valueType === "number") {
      if (Number.isNaN(value)) return "num:NaN";
      if (value === Infinity) return "num:Infinity";
      if (value === -Infinity) return "num:-Infinity";
      if (Object.is(value, -0)) return "num:-0";
      return `num:${value as number}`;
    }
    if (valueType === "boolean") return `bool:${String(value)}`;
    if (valueType === "bigint") return `bigint:${String(value)}`;
    if (valueType === "undefined") return "undefined";
    if (valueType === "function") return "function";
    if (valueType === "symbol") return `symbol:${String(value)}`;

    if (depth >= SIGNATURE_MAX_DEPTH) {
      if (Array.isArray(value)) return `arr:max-depth:${value.length}`;
      return `obj:max-depth:${Object.keys(value as Record<string, unknown>).length}`;
    }

    if (Array.isArray(value)) {
      const length = value.length;
      if (length === 0) return "arr:0";

      const headCount = Math.min(length, SIGNATURE_MAX_ARRAY_ITEMS);
      const headSignatures: string[] = [];
      for (let index = 0; index < headCount; index += 1) {
        headSignatures.push(
          `${index}:${getValueSignature(value[index], depth + 1)}`,
        );
      }

      if (length <= SIGNATURE_MAX_ARRAY_ITEMS) {
        return `arr:${length}:[${headSignatures.join(",")}]`;
      }

      const tailStart = Math.max(headCount, length - 2);
      const tailSignatures: string[] = [];
      for (let index = tailStart; index < length; index += 1) {
        tailSignatures.push(
          `${index}:${getValueSignature(value[index], depth + 1)}`,
        );
      }

      return `arr:${length}:[${headSignatures.join(",")}]|tail:[${tailSignatures.join(",")}]`;
    }

    if (valueType === "object") {
      const record = value as Record<string, unknown>;
      if (seen.has(record)) return "obj:circular";
      seen.add(record);

      const keys = Object.keys(record).sort();
      const keyCount = Math.min(keys.length, SIGNATURE_MAX_OBJECT_KEYS);
      const entries: string[] = [];

      for (let index = 0; index < keyCount; index += 1) {
        const key = keys[index];
        entries.push(`${key}:${getValueSignature(record[key], depth + 1)}`);
      }

      if (keys.length > SIGNATURE_MAX_OBJECT_KEYS) {
        const omitted = keys.length - SIGNATURE_MAX_OBJECT_KEYS;
        const tailKeys = keys.slice(-2).join(",");
        entries.push(`omitted:${omitted}:tail-keys:${tailKeys}`);
      }

      seen.delete(record);
      return `obj:${keys.length}:{${entries.join("|")}}`;
    }

    return `other:${valueType}`;
  };

  return getValueSignature(input, 0);
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
}: MCPAppsRendererProps) {
  const sandboxRef = useRef<SandboxedIframeHandle>(null);
  const themeMode = usePreferencesStore((s) => s.themeMode);

  // Get CSP mode from playground store when in playground, otherwise use widget-declared
  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const playgroundCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  const cspMode: CspMode = isPlaygroundActive
    ? playgroundCspMode
    : "widget-declared";

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

  // Get device type from playground store for platform derivation (SEP-1865)
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);

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

  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [widgetHtml, setWidgetHtml] = useState<string | null>(null);
  const [widgetCsp, setWidgetCsp] = useState<McpUiResourceCsp | undefined>(
    undefined,
  );
  const [widgetPermissions, setWidgetPermissions] = useState<
    McpUiResourcePermissions | undefined
  >(undefined);
  const [widgetPermissive, setWidgetPermissive] = useState<boolean>(false);
  const [prefersBorder, setPrefersBorder] = useState<boolean>(true);
  const [loadedCspMode, setLoadedCspMode] = useState<CspMode | null>(null);
  const [streamingRenderSignaled, setStreamingRenderSignaled] = useState(false);
  const [hasDeliveredStreamingInput, setHasDeliveredStreamingInput] =
    useState(false);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, unknown>>({});
  const [modalTitle, setModalTitle] = useState("");
  const [modalTemplate, setModalTemplate] = useState<string | null>(null);

  // Reset widget HTML when cachedWidgetHtmlUrl changes (e.g., different view selected)
  useEffect(() => {
    setWidgetHtml(null);
    setLoadedCspMode(null);
  }, [cachedWidgetHtmlUrl]);

  const bridgeRef = useRef<AppBridge | null>(null);
  const hostContextRef = useRef<McpUiHostContext | null>(null);
  const lastToolInputRef = useRef<string | null>(null);
  const lastToolInputPartialRef = useRef<string | null>(null);
  const lastToolInputPartialSentAtRef = useRef(0);
  const pendingToolInputPartialRef = useRef<Record<string, unknown> | null>(
    null,
  );
  const partialInputTimerRef = useRef<number | null>(null);
  const streamingRevealTimerRef = useRef<number | null>(null);
  const lastToolOutputRef = useRef<string | null>(null);
  const lastToolErrorRef = useRef<string | null>(null);
  const toolInputSentRef = useRef(false);
  const isReadyRef = useRef(false);
  const previousToolStateRef = useRef<ToolState | undefined>(toolState);

  /** Clear all streaming-related timers and refs. Shared across reset paths. */
  const resetStreamingState = useCallback(() => {
    lastToolInputRef.current = null;
    lastToolInputPartialRef.current = null;
    lastToolInputPartialSentAtRef.current = 0;
    pendingToolInputPartialRef.current = null;
    if (partialInputTimerRef.current !== null) {
      window.clearTimeout(partialInputTimerRef.current);
      partialInputTimerRef.current = null;
    }
    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }
    lastToolOutputRef.current = null;
    lastToolErrorRef.current = null;
    toolInputSentRef.current = false;
    setStreamingRenderSignaled(false);
    setHasDeliveredStreamingInput(false);
  }, []);

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
  themeModeRef.current = themeMode;

  const hasToolInputData = useMemo(
    () => !!toolInput && Object.keys(toolInput).length > 0,
    [toolInput],
  );

  const canRenderStreamingInput = useMemo(() => {
    if (toolState !== "input-streaming") return true;
    return streamingRenderSignaled && hasDeliveredStreamingInput;
  }, [hasDeliveredStreamingInput, streamingRenderSignaled, toolState]);

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
        // Use cached widget HTML whenever available (faster and works offline)
        if (cachedWidgetHtmlUrl) {
          const cachedResponse = await fetch(cachedWidgetHtmlUrl);
          if (!cachedResponse.ok) {
            throw new Error(
              `Failed to fetch cached widget HTML: ${cachedResponse.statusText}`,
            );
          }
          const html = await cachedResponse.text();
          setWidgetHtml(html);
          // In offline mode, we use permissive CSP since we can't verify the original settings
          setWidgetPermissive(true);
          setPrefersBorder(true);
          setLoadedCspMode(cspMode);
          return;
        }

        // If server is offline and no cached HTML, show helpful error
        if (isOffline) {
          setLoadError(
            "Server is offline and this view was saved without cached HTML. " +
              "Connect the server and re-save the view to enable offline rendering.",
          );
          return;
        }

        // Store widget data first (same pattern as openai.ts)
        const storeResponse = await authFetch("/api/mcp/apps/widget/store", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId,
            resourceUri,
            toolInput: toolInputRef.current,
            toolOutput: toolOutputRef.current,
            toolId: toolCallId,
            toolName,
            theme: themeModeRef.current,
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
          permissions,
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
    toolName,
    cspMode,
    isOffline,
    cachedWidgetHtmlUrl,
  ]);

  // UI logging
  const addUiLog = useTrafficLogStore((s) => s.addLog);

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
      locale,
      timeZone,
      deviceCapabilities,
      safeAreaInsets,
    });
  }, [
    toolCallId,
    themeMode,
    effectiveDisplayMode,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    setWidgetGlobals,
  ]);

  // CSS Variables for theming (SEP-1865 styles.variables)
  // These are sent via hostContext.styles.variables - the SDK should pass them through
  const styleVariables = useMemo(
    () => getClaudeDesktopStyleVariables(themeMode),
    [themeMode],
  );

  // containerDimensions (maxWidth/maxHeight) was previously sent here but
  // removed — width is now fully host-controlled.
  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      theme: themeMode,
      displayMode: effectiveDisplayMode,
      availableDisplayModes: ["inline", "pip", "fullscreen"],
      locale,
      timeZone,
      platform: CLAUDE_DESKTOP_PLATFORM,
      userAgent: navigator.userAgent,
      deviceCapabilities,
      safeAreaInsets,
      styles: {
        variables: styleVariables,
        css: { fonts: CLAUDE_DESKTOP_FONT_CSS },
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
      locale,
      timeZone,
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

  const registerBridgeHandlers = useCallback(
    (bridge: AppBridge) => {
      bridge.oninitialized = () => {
        setIsReady(true);
        isReadyRef.current = true;
        const appCaps = bridge.getAppCapabilities();
        onAppSupportedDisplayModesChangeRef.current?.(
          appCaps?.availableDisplayModes as DisplayMode[] | undefined,
        );
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
        const response = await authFetch(`/api/mcp/resources/read`, {
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
        const response = await authFetch(`/api/mcp/resources/list`, {
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
        const response = await authFetch(`/api/mcp/resource-templates/list`, {
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
        const response = await authFetch(`/api/mcp/prompts/list`, {
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
        }

        iframe.animate([from, to], { duration: 300, easing: "ease-out" });
      };

      bridge.onrequestdisplaymode = async ({ mode }) => {
        const requestedMode = mode ?? "inline";
        // Use device type for mobile detection (defaults to mobile-like behavior when not in playground)
        const isMobile = isPlaygroundActiveRef.current
          ? playgroundDeviceTypeRef.current === "mobile" ||
            playgroundDeviceTypeRef.current === "tablet"
          : true;
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
    [setIsReady, toolCallId, setWidgetModelContext],
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
        sandbox: {
          // In permissive mode: omit CSP (undefined) to indicate no restrictions
          // In widget-declared mode: pass the widget's declared CSP
          csp: widgetPermissive ? undefined : widgetCsp,
          // Always pass permissions (if widget declared them)
          permissions: widgetPermissions,
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
          addUiLog({
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
            setStreamingRenderSignaled(true);
          }
          if (SUPPRESSED_UI_LOG_METHODS.has(method)) return;
          addUiLog({
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
      // Clear model context on widget teardown
      setWidgetModelContext(toolCallId, null);
    };
  }, [
    addUiLog,
    serverId,
    toolCallId,
    widgetHtml,
    registerBridgeHandlers,
    setWidgetModelContext,
  ]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge || !isReady) return;
    bridge.setHostContext(hostContext);
  }, [hostContext, isReady]);

  useEffect(() => {
    if (!streamingRenderSignaled) return;
    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }
  }, [streamingRenderSignaled]);

  useEffect(() => {
    if (!isReady || toolState !== "input-streaming" || streamingRenderSignaled)
      return;
    if (streamingRevealTimerRef.current !== null) return;

    streamingRevealTimerRef.current = window.setTimeout(() => {
      streamingRevealTimerRef.current = null;
      setStreamingRenderSignaled(true);
    }, STREAMING_REVEAL_FALLBACK_MS);
  }, [isReady, streamingRenderSignaled, toolState]);

  useEffect(() => {
    const prevToolState = previousToolStateRef.current;

    // Some providers may re-enter input-streaming for a new call while reusing
    // the same toolCallId. Reset send guards so we can stream/send fresh input.
    if (
      toolState === "input-streaming" &&
      prevToolState &&
      prevToolState !== "input-streaming"
    ) {
      resetStreamingState();
    }

    previousToolStateRef.current = toolState;
  }, [resetStreamingState, toolState]);

  // Send partial tool input during streaming (SEP-1865 toolInputPartial)
  useEffect(() => {
    if (!isReady || toolState !== "input-streaming" || toolInputSentRef.current)
      return;
    if (!hasToolInputData) return;
    const resolvedToolInput = toolInput ?? {};
    pendingToolInputPartialRef.current = resolvedToolInput;

    const flushPartialInput = () => {
      const bridge = bridgeRef.current;
      if (!bridge || !isReadyRef.current || toolInputSentRef.current) return;
      const pending = pendingToolInputPartialRef.current;
      if (!pending) return;

      const signature = getToolInputSignature(pending);
      if (lastToolInputPartialRef.current === signature) return;
      lastToolInputPartialRef.current = signature;
      lastToolInputPartialSentAtRef.current = Date.now();
      setHasDeliveredStreamingInput(true);
      setStreamingRenderSignaled(true);
      Promise.resolve(
        bridge.sendToolInputPartial({ arguments: pending }),
      ).catch(() => {});
    };

    const now = Date.now();
    const elapsed = now - lastToolInputPartialSentAtRef.current;
    if (
      lastToolInputPartialSentAtRef.current === 0 ||
      elapsed >= PARTIAL_INPUT_THROTTLE_MS
    ) {
      if (partialInputTimerRef.current !== null) {
        window.clearTimeout(partialInputTimerRef.current);
        partialInputTimerRef.current = null;
      }
      flushPartialInput();
      return;
    }

    if (partialInputTimerRef.current !== null) {
      window.clearTimeout(partialInputTimerRef.current);
    }
    partialInputTimerRef.current = window.setTimeout(() => {
      partialInputTimerRef.current = null;
      flushPartialInput();
    }, PARTIAL_INPUT_THROTTLE_MS - elapsed);
  }, [hasToolInputData, isReady, toolInput, toolState]);

  // Send complete tool input when arguments are ready
  useEffect(() => {
    if (!isReady) return;
    if (toolState !== "input-available" && toolState !== "output-available")
      return;
    if (partialInputTimerRef.current !== null) {
      window.clearTimeout(partialInputTimerRef.current);
      partialInputTimerRef.current = null;
    }
    if (streamingRevealTimerRef.current !== null) {
      window.clearTimeout(streamingRevealTimerRef.current);
      streamingRevealTimerRef.current = null;
    }
    pendingToolInputPartialRef.current = null;
    const bridge = bridgeRef.current;
    if (!bridge) return;

    const resolvedToolInput = toolInput ?? {};
    const serialized = JSON.stringify(resolvedToolInput);
    // Allow live editors/previews to update tool input repeatedly while keeping
    // duplicate sends suppressed for identical payloads.
    if (lastToolInputRef.current === serialized) {
      toolInputSentRef.current = true;
      return;
    }
    lastToolInputRef.current = serialized;
    toolInputSentRef.current = true;
    Promise.resolve(
      bridge.sendToolInput({ arguments: resolvedToolInput }),
    ).catch(() => {
      toolInputSentRef.current = false;
      lastToolInputRef.current = null;
    });
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

    // SEP-1865: Send tool-cancelled for errors instead of tool-result with isError
    bridge.sendToolCancelled({ reason: errorMessage });
  }, [isReady, toolErrorText, toolOutput, toolState]);

  useEffect(() => {
    resetStreamingState();
  }, [toolCallId, resetStreamingState]);

  useEffect(() => {
    return () => resetStreamingState();
  }, [resetStreamingState]);

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

      addUiLog({
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

      console.warn(
        `[MCP Apps CSP Violation] ${directive}: Blocked ${blockedUri}`,
        sourceFile ? `at ${sourceFile}:${lineNumber}:${columnNumber}` : "",
      );
    },
    [addUiLog, toolCallId, serverId, addCspViolation],
  );

  const handleSandboxMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data) return;

    // Handle CSP violation messages (custom type)
    if (data.type === "mcp-apps:csp-violation") {
      handleCspViolation(event);
      return;
    }

    // Handle openai/* JSON-RPC notifications from the compat layer
    if (
      data.jsonrpc === "2.0" &&
      typeof data.method === "string" &&
      data.method.startsWith("openai/")
    ) {
      addUiLog({
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
      }
    }
  };

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
        "fixed top-4 left-1/2 -translate-x-1/2 z-40 w-full min-w-[300px] max-w-[min(90vw,1200px)] space-y-2",
        "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80",
        "shadow-xl border border-border/60 rounded-xl p-3",
      ].join(" ");
    }

    return "mt-3 space-y-2 relative group";
  })();

  // Keep streaming active in background, but delay visual reveal until the app
  // signals layout (size-changed) or fallback timeout elapses.
  const showWidget = isReady && canRenderStreamingInput;

  const iframeStyle: CSSProperties = {
    height: isFullscreen ? "100%" : "400px",
    width: "100%",
    maxWidth: "100%",
    // Width transition was previously included here ("width 300ms ease-out").
    transition: isFullscreen ? undefined : "height 300ms ease-out",
    // Hide iframe visually while not ready to display
    ...(!showWidget
      ? { visibility: "hidden" as const, position: "absolute" as const }
      : {}),
  };

  return (
    <div className={containerClassName}>
      {!showWidget && (
        <div className="border border-border/40 rounded-md bg-muted/30 text-xs text-muted-foreground px-3 py-2">
          {toolState === "input-streaming"
            ? "Streaming tool arguments..."
            : "Preparing MCP App widget..."}
        </div>
      )}

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
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        csp={widgetCsp}
        permissions={widgetPermissions}
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

      <McpAppsModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        title={modalTitle}
        template={modalTemplate}
        params={modalParams}
        registerBridgeHandlers={registerBridgeHandlers}
        widgetCsp={widgetCsp}
        widgetPermissions={widgetPermissions}
        widgetPermissive={widgetPermissive}
        hostContextRef={hostContextRef}
        serverId={serverId}
        resourceUri={resourceUri}
        toolCallId={toolCallId}
        toolName={toolName}
        cspMode={cspMode}
        toolInputRef={toolInputRef}
        toolOutputRef={toolOutputRef}
        themeModeRef={themeModeRef}
        addUiLog={addUiLog}
        onCspViolation={handleCspViolation}
      />
    </div>
  );
}
