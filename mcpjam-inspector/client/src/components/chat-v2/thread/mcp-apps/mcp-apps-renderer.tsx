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
import { authFetch } from "@/lib/session-token";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";
import {
  AppBridge,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  CallToolResult,
  ContentBlock,
} from "@modelcontextprotocol/sdk/types.js";
import { isVisibleToModelOnly } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  SUPPRESSED_UI_LOG_METHODS,
  type DisplayMode,
  type MCPAppsRendererProps,
} from "./mcp-apps-types";
import { useMcpAppsHostContext } from "./mcp-apps-host-context";
import { useMcpAppsResource } from "./use-mcp-apps-resource";
import { useMcpAppsToolSync } from "./use-mcp-apps-tool-sync";
import { useMcpAppsBridge } from "./use-mcp-apps-bridge";
import {
  buildCspViolationHandler,
  handleOpenAiCompatMessage,
} from "./mcp-apps-message-handlers";
import { McpAppsLayout } from "./mcp-apps-layout";
import { McpAppsModal } from "./mcp-apps-modal";
import type { SandboxedIframeHandle } from "@/components/ui/sandboxed-iframe";

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
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
  const bridgeRef = useRef<AppBridge | null>(null);
  const hostContextRef = useRef<McpUiHostContext | null>(null);
  const isReadyRef = useRef(false);

  const themeMode = usePreferencesStore((s) => s.themeMode);
  const addUiLog = useTrafficLogStore((s) => s.addLog);

  const setWidgetDebugInfo = useWidgetDebugStore((s) => s.setWidgetDebugInfo);
  const setWidgetGlobals = useWidgetDebugStore((s) => s.setWidgetGlobals);
  const setWidgetCspStore = useWidgetDebugStore((s) => s.setWidgetCsp);
  const addCspViolation = useWidgetDebugStore((s) => s.addCspViolation);
  const clearCspViolations = useWidgetDebugStore((s) => s.clearCspViolations);
  const setWidgetModelContext = useWidgetDebugStore(
    (s) => s.setWidgetModelContext,
  );
  const setWidgetHtmlStore = useWidgetDebugStore((s) => s.setWidgetHtml);

  const isPlaygroundActive = useUIPlaygroundStore((s) => s.isPlaygroundActive);
  const playgroundCspMode = useUIPlaygroundStore((s) => s.mcpAppsCspMode);
  const cspMode: CspMode = isPlaygroundActive
    ? playgroundCspMode
    : "widget-declared";

  const playgroundLocale = useUIPlaygroundStore((s) => s.globals.locale);
  const playgroundTimeZone = useUIPlaygroundStore((s) => s.globals.timeZone);
  const locale = isPlaygroundActive
    ? playgroundLocale
    : navigator.language || "en-US";
  const timeZone = isPlaygroundActive
    ? playgroundTimeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const playgroundDisplayMode = useUIPlaygroundStore((s) => s.displayMode);
  const playgroundCapabilities = useUIPlaygroundStore((s) => s.capabilities);
  const deviceCapabilities = useMemo(
    () =>
      isPlaygroundActive
        ? playgroundCapabilities
        : { hover: true, touch: false },
    [isPlaygroundActive, playgroundCapabilities],
  );
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
  const playgroundDeviceType = useUIPlaygroundStore((s) => s.deviceType);

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

      if (mode === "fullscreen") {
        onRequestFullscreen?.(toolCallId);
      } else if (displayMode === "fullscreen") {
        onExitFullscreen?.(toolCallId);
      }
    },
    [
      displayMode,
      isControlled,
      onDisplayModeChange,
      onExitFullscreen,
      onRequestFullscreen,
      toolCallId,
    ],
  );

  useEffect(() => {
    if (isPlaygroundActive && !isControlled) {
      setInternalDisplayMode(playgroundDisplayMode);
    }
  }, [isControlled, isPlaygroundActive, playgroundDisplayMode]);

  const [isReady, setIsReady] = useState(false);
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const hostContext = useMcpAppsHostContext({
    themeMode,
    displayMode: effectiveDisplayMode,
    locale,
    timeZone,
    deviceCapabilities,
    safeAreaInsets,
    toolCallId,
    toolName,
    toolMetadata,
  });

  useEffect(() => {
    hostContextRef.current = hostContext;
  }, [hostContext]);

  const {
    html: widgetHtml,
    csp: widgetCsp,
    permissions: widgetPermissions,
    permissive: widgetPermissive,
    prefersBorder,
    loadError,
    loadedCspMode,
  } = useMcpAppsResource({
    toolState,
    toolCallId,
    serverId,
    resourceUri,
    toolName,
    cspMode,
    isOffline,
    cachedWidgetHtmlUrl,
    toolInput,
    toolOutput,
    themeMode,
    setWidgetHtmlStore,
    setWidgetCspStore,
  });

  const {
    setStreamingRenderSignaled,
    canRenderStreamingInput,
    resetStreamingState,
  } = useMcpAppsToolSync({
    toolCallId,
    toolState,
    toolInput,
    toolOutput,
    toolErrorText,
    bridgeRef,
    isReady,
  });

  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      clearCspViolations(toolCallId);
    }
  }, [clearCspViolations, cspMode, loadedCspMode, toolCallId]);

  useEffect(() => {
    if (loadedCspMode !== null && loadedCspMode !== cspMode) {
      setIsReady(false);
      isReadyRef.current = false;
      resetStreamingState();
    }
  }, [cspMode, loadedCspMode, resetStreamingState]);

  useEffect(() => {
    setWidgetDebugInfo(toolCallId, {
      toolName,
      protocol: "mcp-apps",
      widgetState: null,
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
    deviceCapabilities,
    effectiveDisplayMode,
    locale,
    safeAreaInsets,
    setWidgetDebugInfo,
    themeMode,
    timeZone,
    toolCallId,
    toolName,
  ]);

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
    deviceCapabilities,
    effectiveDisplayMode,
    locale,
    safeAreaInsets,
    setWidgetGlobals,
    themeMode,
    timeZone,
    toolCallId,
  ]);

  const onSendFollowUpRef = useLatest(onSendFollowUp);
  const onCallToolRef = useLatest(onCallTool);
  const onRequestPipRef = useLatest(onRequestPip);
  const onExitPipRef = useLatest(onExitPip);
  const setDisplayModeRef = useLatest(setDisplayMode);
  const isPlaygroundActiveRef = useLatest(isPlaygroundActive);
  const playgroundDeviceTypeRef = useLatest(playgroundDeviceType);
  const effectiveDisplayModeRef = useLatest(effectiveDisplayMode);
  const serverIdRef = useLatest(serverId);
  const toolCallIdRef = useLatest(toolCallId);
  const pipWidgetIdRef = useLatest(pipWidgetId);
  const toolsMetadataRef = useLatest(toolsMetadata);
  const onModelContextUpdateRef = useLatest(onModelContextUpdate);
  const onAppSupportedDisplayModesChangeRef = useLatest(
    onAppSupportedDisplayModesChange,
  );
  const toolInputRef = useLatest(toolInput);
  const toolOutputRef = useLatest(toolOutput);
  const themeModeRef = useLatest(themeMode);

  const registerBridgeHandlers = useCallback(
    (bridge: AppBridge) => {
      bridge.oninitialized = () => {
        setBridgeError(null);
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

      bridge.oncalltool = async ({ name, arguments: args }) => {
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

      bridge.onsizechange = ({ height }) => {
        if (effectiveDisplayModeRef.current !== "inline") return;
        const iframe = sandboxRef.current?.getIframeElement();
        if (!iframe || height === undefined) return;

        const style = getComputedStyle(iframe);
        const isBorderBox = style.boxSizing === "border-box";

        const from: Keyframe = {};
        const to: Keyframe = {};

        let adjustedHeight = height;

        if (isBorderBox) {
          adjustedHeight +=
            parseFloat(style.borderTopWidth) +
            parseFloat(style.borderBottomWidth);
        }

        from.height = `${iframe.offsetHeight}px`;
        iframe.style.height = to.height = `${adjustedHeight}px`;
        iframe.animate([from, to], { duration: 300, easing: "ease-out" });
      };

      bridge.onrequestdisplaymode = async ({ mode }) => {
        const requestedMode = mode ?? "inline";
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
        setWidgetModelContext(toolCallId, {
          content: content as ContentBlock[] | undefined,
          structuredContent: structuredContent as
            | Record<string, unknown>
            | undefined,
        });

        onModelContextUpdateRef.current?.(toolCallId, {
          content: content as ContentBlock[] | undefined,
          structuredContent: structuredContent as
            | Record<string, unknown>
            | undefined,
        });

        return {};
      };
    },
    [
      effectiveDisplayModeRef,
      isPlaygroundActiveRef,
      onAppSupportedDisplayModesChangeRef,
      onCallToolRef,
      onExitPipRef,
      onModelContextUpdateRef,
      onRequestPipRef,
      onSendFollowUpRef,
      pipWidgetIdRef,
      playgroundDeviceTypeRef,
      serverIdRef,
      setDisplayModeRef,
      setWidgetModelContext,
      toolCallId,
      toolCallIdRef,
      toolsMetadataRef,
    ],
  );

  useEffect(() => {
    if (widgetHtml) {
      setBridgeError(null);
    }
  }, [widgetHtml]);

  const cspViolationHandler = useMemo(
    () =>
      buildCspViolationHandler({
        toolCallId,
        serverId,
        addUiLog,
        addCspViolation,
      }),
    [addCspViolation, addUiLog, serverId, toolCallId],
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [modalParams, setModalParams] = useState<Record<string, unknown>>({});
  const [modalTitle, setModalTitle] = useState("");
  const [modalTemplate, setModalTemplate] = useState<string | null>(null);

  const handleSandboxMessage = useCallback(
    (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;

      if ((data as { type?: string }).type === "mcp-apps:csp-violation") {
        cspViolationHandler(event);
        return;
      }

      const jsonRpcMessage = data as {
        jsonrpc?: string;
        method?: string;
      };
      if (
        jsonRpcMessage.jsonrpc === "2.0" &&
        typeof jsonRpcMessage.method === "string" &&
        jsonRpcMessage.method.startsWith("openai/")
      ) {
        addUiLog({
          widgetId: toolCallId,
          serverId,
          direction: "ui-to-host",
          protocol: "mcp-apps",
          method: jsonRpcMessage.method,
          message: data,
        });
      }

      const handledCompat = handleOpenAiCompatMessage({
        data,
        onOpenModal: (title, params, template) => {
          setModalTitle(title);
          setModalParams(params);
          setModalTemplate(template);
          setModalOpen(true);
        },
        onCloseModal: () => {
          setModalOpen(false);
        },
      });

      if (handledCompat) return;
    },
    [addUiLog, cspViolationHandler, serverId, toolCallId],
  );

  const getSandboxIframe = useCallback(
    () => sandboxRef.current?.getIframeElement() ?? null,
    [],
  );

  const handleBridgeLoadError = useCallback((message: string) => {
    setBridgeError(message);
  }, []);

  const handleBridgeSetReady = useCallback((ready: boolean) => {
    setIsReady(ready);
    isReadyRef.current = ready;
  }, []);

  const handleSizeChangedSignal = useCallback(() => {
    setStreamingRenderSignaled(true);
  }, [setStreamingRenderSignaled]);

  const handleBeforeBridgeClose = useCallback(
    (bridge: AppBridge) => {
      if (isReadyRef.current) {
        void bridge.teardownResource({}).catch(() => {});
      }
      setWidgetModelContext(toolCallId, null);
    },
    [setWidgetModelContext, toolCallId],
  );

  useMcpAppsBridge({
    widgetHtml,
    getSandboxIframe,
    bridgeRef,
    hostContext,
    widgetCsp,
    widgetPermissions,
    widgetPermissive,
    registerBridgeHandlers,
    widgetId: toolCallId,
    serverId,
    suppressedMethods: SUPPRESSED_UI_LOG_METHODS,
    onUiLog: addUiLog,
    onLoadError: handleBridgeLoadError,
    onSetReady: handleBridgeSetReady,
    onReceiveSizeChanged: handleSizeChangedSignal,
    onBeforeClose: handleBeforeBridgeClose,
  });

  const showWidget = isReady && canRenderStreamingInput;
  const combinedLoadError = loadError ?? bridgeError;

  const iframeStyle: CSSProperties = {
    height: effectiveDisplayMode === "fullscreen" ? "100%" : "400px",
    width: "100%",
    maxWidth: "100%",
    transition:
      effectiveDisplayMode === "fullscreen"
        ? undefined
        : "height 300ms ease-out",
    ...(!showWidget
      ? { visibility: "hidden" as const, position: "absolute" as const }
      : {}),
  };

  return (
    <McpAppsLayout
      toolState={toolState}
      loadError={combinedLoadError}
      widgetHtml={widgetHtml}
      showWidget={showWidget}
      effectiveDisplayMode={effectiveDisplayMode}
      isPlaygroundActive={isPlaygroundActive}
      playgroundDeviceType={playgroundDeviceType}
      toolName={toolName}
      toolCallId={toolCallId}
      pipWidgetId={pipWidgetId}
      resourceUri={resourceUri}
      prefersBorder={prefersBorder}
      iframeStyle={iframeStyle}
      sandboxRef={sandboxRef}
      widgetCsp={widgetCsp}
      widgetPermissions={widgetPermissions}
      widgetPermissive={widgetPermissive}
      onSandboxMessage={handleSandboxMessage}
      onSetDisplayMode={setDisplayMode}
      onExitPip={onExitPip}
      modal={
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
          addUiLog={(log) =>
            addUiLog({
              ...log,
              protocol: "mcp-apps",
            })
          }
          onCspViolation={cspViolationHandler}
        />
      }
    />
  );
}
