/**
 * PlaygroundMain
 *
 * Main center panel for the UI Playground that combines:
 * - Deterministic tool execution (injected as messages)
 * - LLM-driven chat continuation
 * - Widget rendering via Thread component
 *
 * Uses the shared useChatSession hook for chat infrastructure.
 * Device/display mode handling is delegated to the Thread component
 * which manages PiP/fullscreen at the widget level.
 */

import {
  FormEvent,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { Braces, Loader2, Trash2 } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { UIMessage } from "ai";
import { toast } from "sonner";
import { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import {
  formatErrorMessage,
  DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
  MINIMAL_CHAT_COMPOSER_PLACEHOLDER,
  cloneUiMessages,
} from "@/components/chat-v2/shared/chat-helpers";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import { MultiModelStartersEmptyLayout } from "@/components/chat-v2/multi-model-starters-empty";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
import {
  type ChatSessionResetReason,
  useChatSession,
} from "@/hooks/use-chat-session";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { createDeterministicToolMessages } from "./playground-helpers";
import type { MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import {
  type FileAttachment,
  attachmentsToFileUIParts,
  revokeFileAttachmentUrls,
} from "@/components/chat-v2/chat-input/attachments/file-utils";
import {
  useUIPlaygroundStore,
  type DeviceType,
  type DisplayMode,
} from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  getChatboxChatBackground,
  getChatboxHostFamily,
} from "@/lib/chatbox-host-style";
import { DEFAULT_HOST_STYLE } from "@/lib/host-styles";
import {
  HostContextHeader,
  PRESET_DEVICE_CONFIGS,
} from "@/components/shared/HostContextHeader";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { Settings2 } from "lucide-react";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import type { LoadingIndicatorVariant } from "@/components/chat-v2/shared/loading-indicator-content";
import { useConvexAuth } from "convex/react";
import { useWorkspaceServers } from "@/hooks/useViews";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import { useHostContextStore } from "@/stores/host-context-store";
import {
  extractEffectiveHostDisplayMode,
  extractHostTheme,
  type WorkspaceHostContextDraft,
} from "@/lib/client-config";
import { PostConnectGuide } from "@/components/app-builder/PostConnectGuide";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-host-style-context";
import { useComposerOnboarding } from "@/hooks/use-composer-onboarding";
import { useDebouncedXRayPayload } from "@/hooks/use-debounced-x-ray-payload";
import { useModelSelectorLayoutLock } from "@/hooks/use-model-selector-layout-lock";
import {
  getChatComposerInteractivity,
  useChatStopControls,
} from "@/hooks/use-chat-stop-controls";
import { HandDrawnSendHint } from "./HandDrawnSendHint";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { LiveTraceRawEmptyState } from "@/components/evals/live-trace-raw-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";
import { ChatTraceViewModeHeaderBar } from "@/components/evals/trace-view-mode-tabs";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";
import {
  buildPreludeTraceEnvelope,
  type PreludeTraceExecution,
} from "@/components/ui-playground/live-trace-prelude";
import { type BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";
import { type MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import {
  MultiModelPlaygroundCard,
  type PlaygroundDeterministicExecutionRequest,
} from "@/components/ui-playground/multi-model-playground-card";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
};

type ThreadThemeMode = "light" | "dark";

interface PlaygroundMainProps {
  activeWorkspaceId?: string | null;
  serverName: string;
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  onSaveHostContext?: (
    workspaceId: string,
    hostContext: WorkspaceHostContextDraft,
  ) => Promise<void>;
  enableMultiModelChat?: boolean;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
  // Execution state for "Invoking" indicator
  isExecuting?: boolean;
  executingToolName?: string | null;
  invokingMessage?: string | null;
  // Deterministic execution
  pendingExecution: {
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
    toolMeta: Record<string, unknown> | undefined;
    state?: "output-available" | "output-error";
    errorText?: string;
    renderOverride?: ToolRenderOverride;
    toolCallId?: string;
    replaceExisting?: boolean;
  } | null;
  onExecutionInjected: (toolCallId?: string) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  // Device emulation
  deviceType?: DeviceType;
  onDeviceTypeChange?: (type: DeviceType) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  // Locale (BCP 47)
  locale?: string;
  onLocaleChange?: (locale: string) => void;
  // Timezone (IANA) per SEP-1865
  timeZone?: string;
  onTimeZoneChange?: (timeZone: string) => void;
  // View-mode controls
  disableChatInput?: boolean;
  hideSaveViewButton?: boolean;
  disabledInputPlaceholder?: string;
  loadingIndicatorVariant?: LoadingIndicatorVariant;
  // Onboarding
  initialInput?: string;
  /** When true with `initialInput`, reveals the string with a typewriter effect (App Builder NUX). */
  initialInputTypewriter?: boolean;
  /** When true, Send / Enter are blocked until the playground server is connected. */
  blockSubmitUntilServerConnected?: boolean;
  pulseSubmit?: boolean;
  showPostConnectGuide?: boolean;
  onFirstMessageSent?: () => void;
}

type PlaygroundTraceViewMode = "chat" | "timeline" | "raw";

// Invoking indicator component (ChatGPT-style "Invoking [toolName]")
function InvokingIndicator({
  toolName,
  customMessage,
}: {
  toolName: string;
  customMessage?: string | null;
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Braces className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        {customMessage ? (
          <span>{customMessage}</span>
        ) : (
          <>
            <span>Invoking</span>
            <code className="text-primary font-mono">{toolName}</code>
          </>
        )}
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
      </div>
    </div>
  );
}

export function PlaygroundMain({
  activeWorkspaceId = null,
  serverName,
  ensureServersReady,
  onSaveHostContext,
  enableMultiModelChat = false,
  onWidgetStateChange,
  playgroundServerSelectorProps,
  isExecuting,
  executingToolName,
  invokingMessage,
  pendingExecution,
  onExecutionInjected,
  toolRenderOverrides: externalToolRenderOverrides = {},
  // Device/locale/timezone props are now managed via the store by HostContextHeader
  // These are kept for backward compatibility but are no longer used
  deviceType: _deviceType = "mobile",
  onDeviceTypeChange: _onDeviceTypeChange,
  displayMode: displayModeProp = "inline",
  onDisplayModeChange,
  locale: _locale = "en-US",
  onLocaleChange: _onLocaleChange,
  timeZone: _timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC",
  onTimeZoneChange: _onTimeZoneChange,
  disableChatInput = false,
  hideSaveViewButton = false,
  disabledInputPlaceholder = "Input disabled in Views",
  loadingIndicatorVariant,
  initialInput,
  initialInputTypewriter = false,
  blockSubmitUntilServerConnected = false,
  pulseSubmit = false,
  showPostConnectGuide = false,
  onFirstMessageSent,
}: PlaygroundMainProps) {
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const clearLogs = useTrafficLogStore((s) => s.clear);

  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [traceViewMode, setTraceViewMode] =
    useState<PlaygroundTraceViewMode>("chat");
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false);
  const [isPreparingServerForSend, setIsPreparingServerForSend] =
    useState(false);
  const [injectedToolRenderOverrides, setInjectedToolRenderOverrides] =
    useState<Record<string, ToolRenderOverride>>({});
  const [preludeTraceExecutions, setPreludeTraceExecutions] = useState<
    PreludeTraceExecution[]
  >([]);
  const [broadcastRequest, setBroadcastRequest] =
    useState<BroadcastChatTurnRequest | null>(null);
  const [deterministicExecutionRequest, setDeterministicExecutionRequest] =
    useState<PlaygroundDeterministicExecutionRequest | null>(null);
  const [stopBroadcastRequestId, setStopBroadcastRequestId] = useState(0);
  const [multiModelSessionGeneration, setMultiModelSessionGeneration] =
    useState(0);
  const [multiModelSummaries, setMultiModelSummaries] = useState<
    Record<string, MultiModelCardSummary>
  >({});
  const [multiModelHasMessages, setMultiModelHasMessages] = useState<
    Record<string, boolean>
  >({});
  const [multiCompareEnterVersion, setMultiCompareEnterVersion] = useState(0);
  const [multiCompareEnterMessages, setMultiCompareEnterMessages] = useState<
    UIMessage[]
  >([]);
  const [multiAddColumnSeeds, setMultiAddColumnSeeds] = useState<
    Record<string, { version: number; messages: UIMessage[] }>
  >({});
  const multiTranscriptsRef = useRef<Record<string, UIMessage[]>>({});
  const prevCompareModeRef = useRef(false);
  const lastMultiLeadIdRef = useRef<string | null>(null);
  const prevCompareModelIdsRef = useRef<Set<string>>(new Set());
  const multiAddColumnSeqRef = useRef(0);
  // Device config from store (managed by HostContextHeader)
  const storeDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const hostContext = useHostContextStore((s) => s.draftHostContext);
  const patchHostContext = useHostContextStore((s) => s.patchHostContext);

  // Device config for frame sizing
  const deviceConfig = useMemo(() => {
    if (storeDeviceType === "custom") {
      return {
        ...CUSTOM_DEVICE_BASE,
        width: customViewport.width,
        height: customViewport.height,
      };
    }
    return PRESET_DEVICE_CONFIGS[storeDeviceType];
  }, [storeDeviceType, customViewport]);

  const appState = useSharedAppState();
  const servers = appState.servers;
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const selectedServers = useMemo(
    () =>
      serverName && servers[serverName]?.connectionStatus === "connected"
        ? [serverName]
        : [],
    [serverName, servers],
  );

  const serverConnected = Boolean(
    serverName && servers[serverName]?.connectionStatus === "connected",
  );

  const handlePlaygroundServerToggle = useCallback(
    (name: string) => {
      if (name === serverName) {
        playgroundServerSelectorProps?.onServerChange("none");
      } else {
        playgroundServerSelectorProps?.onServerChange(name);
      }
    },
    [serverName, playgroundServerSelectorProps],
  );

  // Hosted mode context (workspaceId, serverIds, OAuth tokens)
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const convexWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;
  const { serversByName } = useWorkspaceServers({
    isAuthenticated: isConvexAuthenticated,
    workspaceId: convexWorkspaceId,
  });
  const hostedSelectedServerIds = useMemo(
    () =>
      selectedServers
        .map((name) => serversByName.get(name))
        .filter((serverId): serverId is string => !!serverId),
    [selectedServers, serversByName],
  );
  const hostedOAuthTokens = useMemo(
    () =>
      buildOAuthTokensByServerId(
        selectedServers,
        (name) => serversByName.get(name),
        (name) => appState.servers[name]?.oauthTokens?.access_token,
      ),
    [selectedServers, serversByName, appState.servers],
  );

  // Use shared chat session hook
  const composerOnResetRef = useRef<() => void>(() => {});
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    status,
    error,
    chatSessionId,
    selectedModel,
    setSelectedModel,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
    availableModels,
    isAuthLoading,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    toolsMetadata,
    toolServerMap,
    tokenUsage,
    resetChat,
    startChatWithMessages,
    liveTraceEnvelope,
    requestPayloadHistory,
    hasTraceSnapshot,
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    disableForAuthentication,
    submitBlocked,
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse,
  } = useChatSession({
    selectedServers,
    hostedContext: {
      workspaceId: convexWorkspaceId,
      selectedServerIds: hostedSelectedServerIds,
      oauthTokens: hostedOAuthTokens,
    },
    onReset: (reason?: ChatSessionResetReason) => {
      setModelContextQueue([]);
      setPreludeTraceExecutions([]);
      setInjectedToolRenderOverrides({});
      if (reason === "servers-changed") {
        return;
      }
      composerOnResetRef.current();
    },
  });

  // Set playground active flag for widget renderers to read
  const setPlaygroundActive = useUIPlaygroundStore(
    (s) => s.setPlaygroundActive,
  );
  useEffect(() => {
    setPlaygroundActive(true);
    return () => setPlaygroundActive(false);
  }, [setPlaygroundActive]);

  // Currently selected protocol (detected from tool metadata)
  const selectedProtocol = useUIPlaygroundStore((s) => s.selectedProtocol);

  // Host chat background: actual chat area colors from each host's UI
  // (separate from the 76 MCP spec widget design tokens)
  const hostStyle = usePreferencesStore((s) => s.hostStyle);
  const globalThemeMode = usePreferencesStore(
    (s) => s.themeMode,
  ) as ThreadThemeMode;
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const effectiveThreadTheme =
    extractHostTheme(hostContext) ?? globalThemeMode;
  const hostStyleFamily = getChatboxHostFamily(hostStyle) ?? "claude";
  const hostBackgroundColor =
    getChatboxChatBackground(hostStyle, effectiveThreadTheme) ??
    DEFAULT_HOST_STYLE.resolveChatBackground(effectiveThreadTheme);
  const displayMode =
    extractEffectiveHostDisplayMode(hostContext) ?? displayModeProp;

  const handleDisplayModeChange = useCallback(
    (mode: DisplayMode) => {
      patchHostContext({ displayMode: mode });
      onDisplayModeChange?.(mode);
    },
    [patchHostContext, onDisplayModeChange],
  );

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );
  const multiModelAvailableModels = useMemo(
    () => new Map(availableModels.map((model) => [String(model.id), model])),
    [availableModels],
  );
  const resolvedSelectedModels = useMemo(() => {
    const persistedModels = selectedModelIds
      .map((modelId) => multiModelAvailableModels.get(modelId))
      .filter((model): model is ModelDefinition => !!model && !model.disabled);

    if (persistedModels.length > 0) {
      return persistedModels.slice(0, 3);
    }

    return selectedModel ? [selectedModel] : [];
  }, [multiModelAvailableModels, selectedModel, selectedModelIds]);
  const canEnableMultiModel =
    enableMultiModelChat && availableModels.length > 1;
  const isMultiModelMode = canEnableMultiModel && multiModelEnabled;
  const { isMultiModelLayoutMode, onModelSelectorOpenChange } =
    useModelSelectorLayoutLock(isMultiModelMode);

  useEffect(() => {
    if (isMultiModelMode && resolvedSelectedModels[0]) {
      lastMultiLeadIdRef.current = String(resolvedSelectedModels[0].id);
    }
  }, [isMultiModelMode, resolvedSelectedModels]);

  const handleMultiModelTranscriptSync = useCallback(
    (modelId: string, transcript: UIMessage[]) => {
      multiTranscriptsRef.current[modelId] = cloneUiMessages(transcript);
    },
    [],
  );

  const clearMultiModelUiState = useCallback(() => {
    setBroadcastRequest(null);
    setDeterministicExecutionRequest(null);
    setStopBroadcastRequestId(0);
    setMultiModelSummaries({});
    setMultiModelHasMessages({});
    setMultiAddColumnSeeds({});
    prevCompareModelIdsRef.current = new Set();
  }, []);

  useLayoutEffect(() => {
    const prev = prevCompareModeRef.current;
    if (prev && !isMultiModelMode) {
      const leadId = lastMultiLeadIdRef.current;
      if (leadId) {
        const transcript = multiTranscriptsRef.current[leadId];
        const hasConversation =
          transcript?.some(
            (m) => m.role === "user" || m.role === "assistant",
          ) ?? false;
        if (hasConversation && transcript) {
          startChatWithMessages(cloneUiMessages(transcript));
        }
      }
      clearMultiModelUiState();
    }
    if (!prev && isMultiModelMode) {
      setMultiCompareEnterVersion((v) => v + 1);
      setMultiCompareEnterMessages(cloneUiMessages(messages));
    }
    prevCompareModeRef.current = isMultiModelMode;
  }, [
    isMultiModelMode,
    messages,
    startChatWithMessages,
    clearMultiModelUiState,
  ]);

  useEffect(() => {
    if (!isMultiModelMode) {
      prevCompareModelIdsRef.current = new Set();
      return;
    }
    const current = new Set(resolvedSelectedModels.map((m) => String(m.id)));
    const prev = prevCompareModelIdsRef.current;
    const added = [...current].filter((id) => !prev.has(id));
    const leadId = resolvedSelectedModels[0]
      ? String(resolvedSelectedModels[0].id)
      : null;
    if (prev.size > 0 && added.length > 0 && leadId) {
      const src = multiTranscriptsRef.current[leadId] ?? [];
      multiAddColumnSeqRef.current += 1;
      const v = multiAddColumnSeqRef.current;
      setMultiAddColumnSeeds((s) => {
        const next = { ...s };
        for (const id of added) {
          next[id] = { version: v, messages: cloneUiMessages(src) };
        }
        return next;
      });
    }
    prevCompareModelIdsRef.current = current;
  }, [isMultiModelMode, resolvedSelectedModels]);

  const effectiveHasMessages = isMultiModelLayoutMode
    ? Object.values(multiModelHasMessages).some(Boolean)
    : !isThreadEmpty;
  const preludeTraceEnvelope = useMemo(
    () => buildPreludeTraceEnvelope(preludeTraceExecutions),
    [preludeTraceExecutions],
  );
  const effectiveLiveTraceEnvelope =
    hasTraceSnapshot || isStreaming
      ? liveTraceEnvelope
      : (preludeTraceEnvelope ?? liveTraceEnvelope);
  // Match ChatTabV2 `showTopTraceViewTabs`: keep Trace/Chat/Raw while multi-model is
  // empty; hide the top bar once compare columns are active (per-card trace tabs take over).
  const showTraceViewTabs =
    traceViewsSupported && (!isMultiModelLayoutMode || !effectiveHasMessages);
  const activeTraceViewMode: PlaygroundTraceViewMode = showTraceViewTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const showMultiModelTraceEmptyPanel =
    isMultiModelMode &&
    !effectiveHasMessages &&
    showLiveTraceDiagnostics &&
    !showPostConnectGuide;
  const multiModelTracePanelModel =
    selectedModel ?? resolvedSelectedModels[0] ?? null;
  const { isStreamingActive, stopActiveChat } = useChatStopControls({
    isMultiModelMode,
    isStreaming,
    multiModelSummaries,
    setStopBroadcastRequestId,
    stop,
  });

  // Composer onboarding: typewriter effect, guided input, submit gating, NUX CTA
  const composer = useComposerOnboarding({
    initialInput,
    initialInputTypewriter,
    blockSubmitUntilServerConnected,
    pulseSubmit,
    showPostConnectGuide,
    serverConnected,
    isThreadEmpty: !effectiveHasMessages,
  });
  composerOnResetRef.current = composer.onSessionReset;
  const { composerDisabled, sendBlocked } = getChatComposerInteractivity({
    isStreamingActive: isStreamingActive || isPreparingServerForSend,
    composerDisabled:
      disableChatInput || submitBlocked || isPreparingServerForSend,
    submitDisabled:
      disableChatInput ||
      submitBlocked ||
      composer.submitGatedByServer ||
      isPreparingServerForSend,
  });

  useEffect(() => {
    if (!canEnableMultiModel && multiModelEnabled) {
      setMultiModelEnabled(false);
      setSelectedModelIds(selectedModel ? [String(selectedModel.id)] : []);
      return;
    }

    const sanitizedIds = resolvedSelectedModels.map((model) =>
      String(model.id),
    );
    const persistedIds = selectedModelIds.slice(0, 3);
    const idsChanged =
      sanitizedIds.length !== persistedIds.length ||
      sanitizedIds.some((modelId, index) => modelId !== persistedIds[index]);

    if (idsChanged) {
      setSelectedModelIds(
        sanitizedIds.length > 0 && multiModelEnabled
          ? sanitizedIds
          : selectedModel
            ? [String(selectedModel.id)]
            : [],
      );
    }
  }, [
    canEnableMultiModel,
    multiModelEnabled,
    resolvedSelectedModels,
    selectedModel,
    selectedModelIds,
    setMultiModelEnabled,
    setSelectedModelIds,
  ]);

  useEffect(() => {
    const activeModelIds = new Set(
      resolvedSelectedModels.map((model) => String(model.id)),
    );

    setMultiModelSummaries((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) =>
          activeModelIds.has(modelId),
        ),
      ),
    );
    setMultiModelHasMessages((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) =>
          activeModelIds.has(modelId),
        ),
      ),
    );
  }, [resolvedSelectedModels]);

  useEffect(() => {
    if (!traceViewsSupported) {
      setTraceViewMode("chat");
    }
  }, [traceViewsSupported]);

  useEffect(() => {
    setTraceViewMode("chat");
    setPreludeTraceExecutions([]);
  }, [chatSessionId]);

  // Keyboard shortcut for clear chat (Cmd/Ctrl+Shift+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        if (effectiveHasMessages) {
          setShowClearConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveHasMessages]);

  // Handle deterministic execution injection
  useEffect(() => {
    if (!pendingExecution) return;
    if (isMultiModelMode) {
      const requestId = Date.now();
      const toolCallId =
        pendingExecution.toolCallId ?? `playground-tool-${requestId}`;
      setDeterministicExecutionRequest({
        id: requestId,
        toolName: pendingExecution.toolName,
        params: pendingExecution.params,
        result: pendingExecution.result,
        toolMeta: pendingExecution.toolMeta,
        state: pendingExecution.state,
        errorText: pendingExecution.errorText,
        renderOverride: pendingExecution.renderOverride,
        toolCallId,
        replaceExisting: pendingExecution.replaceExisting,
      });
      onExecutionInjected(toolCallId);
      return;
    }

    const { toolName, params, result, toolMeta } = pendingExecution;
    const deterministicOptions =
      pendingExecution.state === "output-error"
        ? {
            state: "output-error" as const,
            errorText: pendingExecution.errorText,
            toolCallId: pendingExecution.toolCallId,
          }
        : pendingExecution.toolCallId
          ? { toolCallId: pendingExecution.toolCallId }
          : undefined;
    const { messages: newMessages, toolCallId } =
      createDeterministicToolMessages(
        toolName,
        params,
        result,
        toolMeta,
        deterministicOptions,
      );

    if (pendingExecution.renderOverride) {
      setInjectedToolRenderOverrides((prev) => ({
        ...prev,
        [toolCallId]: pendingExecution.renderOverride!,
      }));
    }

    const upsertById = (
      current: typeof newMessages,
      nextMessage: (typeof newMessages)[number],
    ) => {
      const idx = current.findIndex((m) => m.id === nextMessage.id);
      if (idx === -1) return [...current, nextMessage];
      const copy = [...current];
      copy[idx] = nextMessage;
      return copy;
    };

    if (pendingExecution.replaceExisting && pendingExecution.toolCallId) {
      setMessages((prev) => {
        let next = [...prev];
        for (const msg of newMessages) {
          next = upsertById(next as typeof newMessages, msg) as typeof prev;
        }
        return next;
      });
    } else {
      setMessages((prev) => [...prev, ...newMessages]);
    }
    setPreludeTraceExecutions((prev) => {
      const nextExecution: PreludeTraceExecution = {
        toolCallId,
        toolName,
        params,
        result,
        state:
          pendingExecution.state === "output-error"
            ? "output-error"
            : "output-available",
        errorText: pendingExecution.errorText,
      };

      if (pendingExecution.replaceExisting && pendingExecution.toolCallId) {
        return prev.map((execution) =>
          execution.toolCallId === pendingExecution.toolCallId
            ? nextExecution
            : execution,
        );
      }

      return [...prev, nextExecution];
    });
    onExecutionInjected(toolCallId);
  }, [isMultiModelMode, onExecutionInjected, pendingExecution, setMessages]);

  useEffect(() => {
    if (!isMultiModelMode && hasTraceSnapshot) {
      setPreludeTraceExecutions([]);
    }
  }, [hasTraceSnapshot, isMultiModelMode]);

  // Handle widget state changes
  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      onWidgetStateChange?.(toolCallId, state);
    },
    [onWidgetStateChange],
  );

  const ensureSelectedServerReadyForChat = useCallback(async () => {
    if (!serverName || !ensureServersReady) {
      return true;
    }

    const connectionStatus = servers[serverName]?.connectionStatus;
    if (connectionStatus === "connected") {
      return true;
    }

    setIsPreparingServerForSend(true);
    try {
      const result = await ensureServersReady([serverName]);
      if (result.readyServerNames.includes(serverName)) {
        // Yield one frame so React can flush the connection-status state
        // update before the caller proceeds to send a message.
        await new Promise<void>((resolve) => {
          if (typeof window !== "undefined" && window.requestAnimationFrame) {
            window.requestAnimationFrame(() => resolve());
            return;
          }
          setTimeout(resolve, 0);
        });
        return true;
      }

      const errorMessage = result.missingServerNames.includes(serverName)
        ? `${serverName} is no longer available in this workspace.`
        : result.reauthServerNames.includes(serverName)
          ? `Reauthenticate ${serverName} before sending.`
          : `Couldn't connect to ${serverName}.`;
      toast.error(errorMessage);
      return false;
    } finally {
      setIsPreparingServerForSend(false);
    }
  }, [ensureServersReady, serverName, servers]);

  // Handle follow-up messages from widgets
  const handleSendFollowUp = useCallback(
    (text: string) => {
      void (async () => {
        if (!(await ensureSelectedServerReadyForChat())) {
          return;
        }
        sendMessage({ text });
      })();
    },
    [ensureSelectedServerReadyForChat, sendMessage],
  );

  // Handle model context updates from widgets (SEP-1865 ui/update-model-context)
  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      },
    ) => {
      // Queue model context to be included in next message
      setModelContextQueue((prev) => {
        // Remove any existing context from same widget (overwrite pattern per SEP-1865)
        const filtered = prev.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  const resetMultiModelSessions = useCallback(() => {
    clearMultiModelUiState();
    setMultiModelSessionGeneration((previous) => previous + 1);
  }, [clearMultiModelUiState]);

  const handleResetAllChats = useCallback(() => {
    composer.prepareForClearChat();
    resetChat();
    clearLogs();
    setInjectedToolRenderOverrides({});
    setPreludeTraceExecutions([]);
    resetMultiModelSessions();
  }, [clearLogs, composer, resetChat, resetMultiModelSessions]);

  const handleClearChat = useCallback(() => {
    handleResetAllChats();
    setShowClearConfirm(false);
  }, [handleResetAllChats]);

  const handleSingleModelChange = useCallback(
    (model: ModelDefinition) => {
      setSelectedModel(model);
      setSelectedModelIds([String(model.id)]);
      setMultiModelEnabled(false);
    },
    [setMultiModelEnabled, setSelectedModel, setSelectedModelIds],
  );

  const handleSelectedModelsChange = useCallback(
    (models: ModelDefinition[]) => {
      const nextSelectedModels = models.slice(0, 3);
      const leadModel = nextSelectedModels[0] ?? selectedModel;

      if (leadModel) {
        setSelectedModel(leadModel);
      }
      setSelectedModelIds(
        nextSelectedModels.map((selectedModelItem) =>
          String(selectedModelItem.id),
        ),
      );
    },
    [selectedModel, setSelectedModel, setSelectedModelIds],
  );

  const handleMultiModelEnabledChange = useCallback(
    (enabled: boolean) => {
      setMultiModelEnabled(enabled);
    },
    [setMultiModelEnabled],
  );

  const handleRequireToolApprovalChange = useCallback(
    (enabled: boolean) => {
      setRequireToolApproval(enabled);
      if (isMultiModelMode) {
        handleResetAllChats();
      }
    },
    [handleResetAllChats, isMultiModelMode, setRequireToolApproval],
  );

  const handleMultiModelSummaryChange = useCallback(
    (summary: MultiModelCardSummary) => {
      setMultiModelSummaries((previous) => ({
        ...previous,
        [summary.modelId]: summary,
      }));
    },
    [],
  );

  const handleMultiModelHasMessagesChange = useCallback(
    (modelId: string, hasMessages: boolean) => {
      setMultiModelHasMessages((previous) => ({
        ...previous,
        [modelId]: hasMessages,
      }));
    },
    [],
  );

  const queueBroadcastRequest = useCallback(
    (
      request: Omit<BroadcastChatTurnRequest, "id">,
      captureProps?: Record<string, unknown>,
    ) => {
      posthog.capture("app_builder_send_message", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
        multi_model_enabled: isMultiModelMode,
        multi_model_count: isMultiModelMode ? resolvedSelectedModels.length : 1,
        ...(captureProps ?? {}),
      });

      setBroadcastRequest({
        ...request,
        id: Date.now(),
      });
    },
    [
      isMultiModelMode,
      posthog,
      resolvedSelectedModels.length,
      selectedModel?.id,
      selectedModel?.name,
      selectedModel?.provider,
    ],
  );

  const mergedToolRenderOverrides = useMemo(
    () => ({
      ...injectedToolRenderOverrides,
      ...externalToolRenderOverrides,
    }),
    [injectedToolRenderOverrides, externalToolRenderOverrides],
  );

  // Placeholder: Chat tab strings for multi-model; playground default for single-model
  let placeholder = showPostConnectGuide
    ? MINIMAL_CHAT_COMPOSER_PLACEHOLDER
    : isMultiModelMode
      ? DEFAULT_CHAT_COMPOSER_PLACEHOLDER
      : "Try a prompt that could call your tools...";
  if (disableChatInput) {
    placeholder = disabledInputPlaceholder;
  }
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = isMultiModelMode
      ? "Sign in to use free chat"
      : "Sign in to use chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const showMultiModelStarterPrompts = !shouldShowUpsell && !isAuthLoading;
  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  // Submit handler
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hasContent =
      composer.input.trim() ||
      mcpPromptResults.length > 0 ||
      fileAttachments.length > 0;
    if (hasContent && !sendBlocked) {
      if (!(await ensureSelectedServerReadyForChat())) {
        return;
      }

      if (
        !isMultiModelMode &&
        displayMode === "fullscreen" &&
        isWidgetFullscreen
      ) {
        setIsFullscreenChatOpen(true);
      }

      // Include any pending model context from widgets (SEP-1865 ui/update-model-context)
      // Sent as "user" messages for compatibility with model provider APIs
      const contextMessages = modelContextQueue.map(
        ({ toolCallId, context }) => ({
          id: `model-context-${toolCallId}-${Date.now()}`,
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: `Widget ${toolCallId} context: ${JSON.stringify(context)}`,
            },
          ],
          metadata: {
            source: "widget-model-context",
            toolCallId,
          },
        }),
      );

      // Convert file attachments to FileUIPart[] format for the AI SDK
      const files =
        fileAttachments.length > 0
          ? await attachmentsToFileUIParts(fileAttachments)
          : undefined;

      if (isMultiModelMode) {
        queueBroadcastRequest({
          text: composer.input,
          files,
          prependMessages: [],
        });
        setModelContextQueue([]);
      } else {
        if (contextMessages.length > 0) {
          setMessages((prev) => [...prev, ...contextMessages]);
        }
        queueBroadcastRequest(
          {
            text: composer.input,
            files,
            prependMessages: [],
          },
          { single_model_send: true },
        );
        sendMessage({ text: composer.input, files });
        setModelContextQueue([]); // Clear after sending
      }

      composer.setInput("");
      setMcpPromptResults([]);
      // Revoke object URLs and clear file attachments
      revokeFileAttachmentUrls(fileAttachments);
      setFileAttachments([]);

      // Notify onboarding that the first message was sent
      onFirstMessageSent?.();
    }
  };

  const errorMessage = formatErrorMessage(error);

  const handleMultiModelStarterPrompt = useCallback(
    (prompt: string) => {
      if (composerDisabled || sendBlocked) {
        composer.setInput(prompt);
        return;
      }
      void (async () => {
        if (!(await ensureSelectedServerReadyForChat())) {
          composer.setInput(prompt);
          return;
        }
        queueBroadcastRequest({
          text: prompt,
          prependMessages: [],
        });
        composer.setInput("");
        revokeFileAttachmentUrls(fileAttachments);
        setFileAttachments([]);
        onFirstMessageSent?.();
      })();
    },
    [
      composer,
      composerDisabled,
      ensureSelectedServerReadyForChat,
      fileAttachments,
      onFirstMessageSent,
      queueBroadcastRequest,
      sendBlocked,
    ],
  );
  const traceViewerTrace = effectiveLiveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const showLiveTracePending =
    activeTraceViewMode === "timeline" &&
    !hasLiveTimelineContent &&
    !preludeTraceEnvelope?.spans?.length;

  // Shared chat input props
  const sharedChatInputProps = {
    value: composer.input,
    onChange: composer.handleInputChange,
    onSubmit,
    stop: stopActiveChat,
    disabled: composerDisabled,
    isLoading: isStreamingActive,
    placeholder,
    currentModel: selectedModel,
    availableModels,
    onModelChange: handleSingleModelChange,
    onModelSelectorOpenChange,
    multiModelEnabled: isMultiModelMode,
    selectedModels: resolvedSelectedModels,
    onSelectedModelsChange: handleSelectedModelsChange,
    onMultiModelEnabledChange: handleMultiModelEnabledChange,
    enableMultiModel: canEnableMultiModel,
    systemPrompt,
    onSystemPromptChange: setSystemPrompt,
    temperature,
    onTemperatureChange: setTemperature,
    onResetChat: handleResetAllChats,
    submitDisabled:
      disableChatInput ||
      submitBlocked ||
      composer.submitGatedByServer ||
      isPreparingServerForSend,
    tokenUsage,
    selectedServers,
    mcpToolsTokenCount: null,
    mcpToolsTokenCountLoading: false,
    connectedOrConnectingServerConfigs: { [serverName]: { name: serverName } },
    systemPromptTokenCount: null,
    systemPromptTokenCountLoading: false,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
    skillResults,
    onChangeSkillResults: setSkillResults,
    fileAttachments,
    onChangeFileAttachments: setFileAttachments,
    requireToolApproval,
    onRequireToolApprovalChange: handleRequireToolApprovalChange,
    pulseSubmit: composer.sendButtonOnboardingPulse,
    minimalMode: showPostConnectGuide,
    moveCaretToEndTrigger: composer.moveCaretToEndTrigger,
    allServerConfigs: playgroundServerSelectorProps?.serverConfigs,
    onServerToggle: handlePlaygroundServerToggle,
    onReconnectServer: playgroundServerSelectorProps?.onReconnect,
    onAddServer: playgroundServerSelectorProps?.onConnect,
  };

  // Check if widget should take over the full container
  // Mobile: both fullscreen and pip take over
  // Tablet: only fullscreen takes over (pip stays floating)
  const isMobileFullTakeover =
    storeDeviceType === "mobile" &&
    (displayMode === "fullscreen" || displayMode === "pip");
  const isTabletFullscreenTakeover =
    storeDeviceType === "tablet" && displayMode === "fullscreen";
  const isWidgetFullTakeover =
    isMobileFullTakeover || isTabletFullscreenTakeover;

  const showFullscreenChatOverlay =
    displayMode === "fullscreen" &&
    isWidgetFullscreen &&
    storeDeviceType === "desktop" &&
    !isWidgetFullTakeover;

  useEffect(() => {
    if (!showFullscreenChatOverlay) setIsFullscreenChatOpen(false);
  }, [showFullscreenChatOverlay]);

  const showSingleModelEmptyStateComposer =
    !isAuthLoading &&
    !shouldShowUpsell &&
    (showPostConnectGuide || !showFullscreenChatOverlay);

  // Thread content - single ChatInput that persists across empty/non-empty states
  const threadContent = (
    <div className="relative flex flex-col flex-1 min-h-0">
      {isThreadEmpty ? (
        // Empty state — centered (welcome + composer, or post-connect guide)
        <div
          data-testid="playground-empty-state-shell"
          className={cn(
            "flex flex-1 min-h-0 overflow-hidden",
            hostStyleFamily === "chatgpt"
              ? effectiveThreadTheme === "dark"
                ? "bg-[#212121] text-neutral-50"
                : "bg-white text-neutral-950"
              : effectiveThreadTheme === "dark"
                ? "bg-[#262624] text-[#F1F0ED]"
                : "bg-[#FAF9F5] text-[rgba(61,57,41,1)]",
          )}
        >
          <div
            className="flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden px-4"
            data-testid="playground-empty-state-body"
          >
            <div
              className={cn(
                "w-full max-w-4xl shrink-0",
                !showPostConnectGuide && "py-8",
              )}
            >
              <div
                className={cn("w-full", !showPostConnectGuide && "text-center")}
              >
                {isAuthLoading ? (
                  <div className="space-y-4 text-center">
                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                    <p className="text-sm text-muted-foreground">Loading...</p>
                  </div>
                ) : shouldShowUpsell ? (
                  <div className="text-center">
                    <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                  </div>
                ) : showPostConnectGuide ? (
                  <div className="space-y-6">
                    {errorMessage && (
                      <div className="w-full">
                        <ErrorBox
                          message={errorMessage.message}
                          errorDetails={errorMessage.details}
                          code={errorMessage.code}
                          statusCode={errorMessage.statusCode}
                          isRetryable={errorMessage.isRetryable}
                          isMCPJamPlatformError={
                            errorMessage.isMCPJamPlatformError
                          }
                          onResetChat={resetChat}
                        />
                      </div>
                    )}
                    <PostConnectGuide />
                  </div>
                ) : (
                  <div className="flex w-full flex-col items-center gap-8 [-webkit-user-drag:none]">
                    <div className="text-center max-w-md">
                      <img
                        src={
                          effectiveThreadTheme === "dark"
                            ? "/mcp_jam_dark.png"
                            : "/mcp_jam_light.png"
                        }
                        alt="MCPJam"
                        draggable={false}
                        className="h-10 w-auto mx-auto mb-4"
                      />
                      <div className="space-y-3">
                        <h3
                          className={cn(
                            "text-lg font-semibold",
                            hostStyleFamily === "chatgpt"
                              ? effectiveThreadTheme === "dark"
                                ? "text-white"
                                : "text-neutral-950"
                              : effectiveThreadTheme === "dark"
                                ? "text-[#F1F0ED]"
                                : "text-[rgba(61,57,41,1)]",
                          )}
                        >
                          This is your playground for MCP.
                        </h3>
                        <p
                          className={cn(
                            "text-base leading-7",
                            hostStyleFamily === "chatgpt"
                              ? effectiveThreadTheme === "dark"
                                ? "text-neutral-400"
                                : "text-neutral-600"
                              : effectiveThreadTheme === "dark"
                                ? "text-[#F1F0ED]/80"
                                : "text-[rgba(61,57,41,0.72)]",
                          )}
                        >
                          Test prompts, inspect tools, and debug AI-powered
                          apps. Type a message here, or run a tool on the left.
                        </p>
                      </div>
                    </div>
                    {errorMessage && (
                      <div className="w-full">
                        <ErrorBox
                          message={errorMessage.message}
                          errorDetails={errorMessage.details}
                          code={errorMessage.code}
                          statusCode={errorMessage.statusCode}
                          isRetryable={errorMessage.isRetryable}
                          isMCPJamPlatformError={
                            errorMessage.isMCPJamPlatformError
                          }
                          onResetChat={resetChat}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {showSingleModelEmptyStateComposer && (
                <div
                  className={cn(
                    "w-full shrink-0",
                    showPostConnectGuide ? "pt-6" : "pt-8",
                  )}
                >
                  <ChatInput {...sharedChatInputProps} hasMessages={false} />
                  {!showPostConnectGuide && composer.sendNuxCtaVisible && (
                    <HandDrawnSendHint
                      hostStyle={hostStyle}
                      theme={effectiveThreadTheme}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        // Thread with messages
        <StickToBottom
          className="relative flex flex-1 flex-col min-h-0"
          resize="smooth"
          initial="smooth"
        >
          <div className="relative flex-1 min-h-0">
            <StickToBottom.Content className="flex flex-col min-h-0">
              <Thread
                messages={messages}
                sendFollowUpMessage={handleSendFollowUp}
                model={selectedModel}
                isLoading={isStreaming}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={handleWidgetStateChange}
                onModelContextUpdate={handleModelContextUpdate}
                displayMode={displayMode}
                onDisplayModeChange={handleDisplayModeChange}
                onFullscreenChange={setIsWidgetFullscreen}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocol ?? undefined
                }
                onToolApprovalResponse={addToolApprovalResponse}
                toolRenderOverrides={mergedToolRenderOverrides}
                showSaveViewButton={!hideSaveViewButton}
                loadingIndicatorVariant={loadingIndicatorVariant}
              />
              {/* Invoking indicator while tool execution is in progress */}
              {isExecuting && executingToolName && (
                <InvokingIndicator
                  toolName={executingToolName}
                  customMessage={invokingMessage}
                />
              )}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </div>
        </StickToBottom>
      )}

      {/* Footer ChatInput: with messages, or empty when center has no composer
          (auth loading / upsell). Otherwise empty thread uses centered composer only. */}
      {!isWidgetFullTakeover &&
        !showFullscreenChatOverlay &&
        (!isThreadEmpty || shouldShowUpsell || isAuthLoading) && (
          <div
            className={cn(
              "mx-auto w-full max-w-4xl shrink-0",
              isThreadEmpty ? "px-4 pb-4" : "p-3",
            )}
          >
            {errorMessage && (
              <div className="pb-3">
                <ErrorBox
                  message={errorMessage.message}
                  errorDetails={errorMessage.details}
                  code={errorMessage.code}
                  statusCode={errorMessage.statusCode}
                  isRetryable={errorMessage.isRetryable}
                  isMCPJamPlatformError={errorMessage.isMCPJamPlatformError}
                  onResetChat={resetChat}
                />
              </div>
            )}
            <ChatInput {...sharedChatInputProps} hasMessages={!isThreadEmpty} />
          </div>
        )}

      {/* Fullscreen overlay chat (input pinned + collapsible thread) */}
      {showFullscreenChatOverlay && (
        <FullscreenChatOverlay
          messages={messages}
          open={isFullscreenChatOpen}
          onOpenChange={setIsFullscreenChatOpen}
          input={composer.input}
          onInputChange={composer.setInput}
          placeholder={placeholder}
          disabled={composerDisabled}
          canSend={!sendBlocked && composer.input.trim().length > 0}
          isThinking={isStreamingActive}
          loadingIndicatorVariant={loadingIndicatorVariant}
          onStop={stopActiveChat}
          onSend={() => {
            void (async () => {
              if (sendBlocked) {
                return;
              }
              if (!(await ensureSelectedServerReadyForChat())) {
                return;
              }
              sendMessage({ text: composer.input });
              composer.setInput("");
              setMcpPromptResults([]);
            })();
          }}
        />
      )}
    </div>
  );

  // Device frame container - display mode is passed to widgets via Thread
  return (
    <div
      className={cn(
        "h-full flex flex-col overflow-hidden",
        showPostConnectGuide || isMultiModelLayoutMode
          ? "bg-background"
          : "bg-muted/20",
      )}
    >
      {/* Device frame header — hidden during onboarding */}
      {!showPostConnectGuide && (
        <>
          <div
            className={cn(
              "@container/playground-header relative flex h-11 min-w-0 w-full items-center justify-center border-b border-border px-3 text-xs text-muted-foreground flex-shrink-0",
              isMultiModelLayoutMode ? "bg-background" : "bg-background/50",
              effectiveHasMessages && "pr-10 sm:pr-11",
            )}
            data-testid="playground-main-header"
          >
            <div className="flex min-w-0 flex-1 justify-center overflow-hidden">
              <HostContextHeader
                activeWorkspaceId={activeWorkspaceId}
                onSaveHostContext={onSaveHostContext}
                protocol={selectedProtocol}
                showThemeToggle
              />
            </div>

            {effectiveHasMessages && (
              <div className="absolute right-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowClearConfirm(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Clear chat</p>
                    <p className="text-xs text-muted-foreground">
                      {navigator.platform.includes("Mac")
                        ? "⌘⇧K"
                        : "Ctrl+Shift+K"}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>

          {showTraceViewTabs ? (
            <ChatTraceViewModeHeaderBar
              mode={activeTraceViewMode}
              onModeChange={(mode) => {
                if (mode === "tools") {
                  return;
                }
                setTraceViewMode(mode);
              }}
            />
          ) : null}
        </>
      )}

      <ConfirmChatResetDialog
        open={showClearConfirm}
        onCancel={() => setShowClearConfirm(false)}
        onConfirm={handleClearChat}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        {isMultiModelLayoutMode ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            {showMultiModelTraceEmptyPanel && multiModelTracePanelModel ? (
              <MultiModelEmptyTraceDiagnosticsPanel
                activeTraceViewMode={activeTraceViewMode}
                effectiveHasMessages={effectiveHasMessages}
                hasLiveTimelineContent={hasLiveTimelineContent}
                traceViewerTrace={traceViewerTrace}
                model={multiModelTracePanelModel}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                traceStartedAtMs={liveTraceEnvelope?.traceStartedAtMs ?? null}
                traceEndedAtMs={liveTraceEnvelope?.traceEndedAtMs ?? null}
                rawRequestPayloadHistory={{
                  entries: requestPayloadHistory,
                  hasUiMessages: effectiveHasMessages,
                }}
                rawEmptyTestId="playground-multi-empty-raw-pending"
                timelineEmptyTestId="playground-multi-empty-trace-pending"
                onRevealNavigateToChat={() => setTraceViewMode("chat")}
                errorFooterSlot={
                  errorMessage ? (
                    <div className="max-w-4xl mx-auto px-4 pt-4">
                      <ErrorBox
                        message={errorMessage.message}
                        errorDetails={errorMessage.details}
                        code={errorMessage.code}
                        statusCode={errorMessage.statusCode}
                        isRetryable={errorMessage.isRetryable}
                        isMCPJamPlatformError={
                          errorMessage.isMCPJamPlatformError
                        }
                        onResetChat={handleResetAllChats}
                      />
                    </div>
                  ) : null
                }
                chatInputSlot={
                  <ChatInput {...sharedChatInputProps} hasMessages={false} />
                }
              />
            ) : null}

            {!effectiveHasMessages && !showMultiModelTraceEmptyPanel ? (
              <MultiModelStartersEmptyLayout
                isAuthLoading={isAuthLoading}
                showStarterPrompts={showMultiModelStarterPrompts}
                authPrimarySlot={
                  isAuthLoading ? (
                    <div className="text-center space-y-4">
                      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                      <p className="text-sm text-muted-foreground">
                        Loading...
                      </p>
                    </div>
                  ) : shouldShowUpsell ? (
                    <div className="space-y-4">
                      <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                    </div>
                  ) : null
                }
                onStarterPrompt={handleMultiModelStarterPrompt}
                chatInputSlot={
                  <ChatInput {...sharedChatInputProps} hasMessages={false} />
                }
              />
            ) : null}

            <div
              data-testid="playground-multi-model-compare-section"
              className={cn(
                "flex flex-1 min-h-0 flex-col overflow-hidden",
                !effectiveHasMessages && "hidden",
              )}
              aria-hidden={!effectiveHasMessages}
            >
              <div className="flex min-h-64 flex-1 flex-col overflow-hidden px-4 py-4">
                <div
                  data-testid="playground-multi-model-grid"
                  className={cn(
                    "grid h-full min-h-0 w-full min-w-0 gap-4 auto-rows-[minmax(0,1fr)] [&>*]:min-h-0",
                    resolvedSelectedModels.length <= 1 && "grid-cols-1",
                    resolvedSelectedModels.length === 2 &&
                      "grid-cols-1 xl:grid-cols-2",
                    resolvedSelectedModels.length >= 3 &&
                      "grid-cols-1 xl:grid-cols-3",
                  )}
                >
                  {resolvedSelectedModels.map((model) => (
                    <MultiModelPlaygroundCard
                      key={`${multiModelSessionGeneration}:${String(model.id)}`}
                      model={model}
                      comparisonSummaries={Object.values(multiModelSummaries)}
                      selectedServers={selectedServers}
                      broadcastRequest={broadcastRequest}
                      deterministicExecutionRequest={
                        deterministicExecutionRequest
                      }
                      stopRequestId={stopBroadcastRequestId}
                      executionConfig={{
                        systemPrompt,
                        temperature,
                        requireToolApproval,
                      }}
                      hostedContext={{
                        workspaceId: convexWorkspaceId,
                        selectedServerIds: hostedSelectedServerIds,
                        oauthTokens: hostedOAuthTokens,
                      }}
                      displayMode={displayMode}
                      onDisplayModeChange={handleDisplayModeChange}
                      hostStyle={hostStyle}
                      effectiveThreadTheme={effectiveThreadTheme}
                      deviceType={storeDeviceType}
                      selectedProtocol={selectedProtocol}
                      hideSaveViewButton={hideSaveViewButton}
                      onWidgetStateChange={onWidgetStateChange}
                      toolRenderOverrides={externalToolRenderOverrides}
                      isExecuting={isExecuting}
                      executingToolName={executingToolName}
                      invokingMessage={invokingMessage}
                      onSummaryChange={handleMultiModelSummaryChange}
                      onHasMessagesChange={handleMultiModelHasMessagesChange}
                      showComparisonChrome={resolvedSelectedModels.length > 1}
                      suppressThreadEmptyHint={false}
                      compareEnterVersion={multiCompareEnterVersion}
                      compareEnterMessages={multiCompareEnterMessages}
                      addColumnSeed={
                        multiAddColumnSeeds[String(model.id)] ?? null
                      }
                      onTranscriptSync={handleMultiModelTranscriptSync}
                    />
                  ))}
                </div>
              </div>

              {!showMultiModelTraceEmptyPanel ? (
                <div className="shrink-0 border-t border-border bg-background/80 backdrop-blur-sm">
                  {!isAuthLoading ? (
                    <div className="w-full p-4">
                      <ChatInput
                        {...sharedChatInputProps}
                        hasMessages={effectiveHasMessages}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {showLiveTraceDiagnostics && (
              <ChatboxHostStyleProvider value={hostStyle}>
                <ChatboxHostThemeProvider value={effectiveThreadTheme}>
                  <div
                    className={cn(
                      "flex h-full min-h-0 flex-col overflow-hidden",
                      effectiveThreadTheme === "dark" && "dark",
                    )}
                    data-testid="playground-trace-diagnostics"
                  >
                    {activeTraceViewMode === "raw" && !showLiveTracePending ? (
                      <StickToBottom
                        className="flex flex-1 min-h-0 flex-col overflow-hidden"
                        resize="smooth"
                        initial="smooth"
                      >
                        <div className="relative flex flex-1 min-h-0 overflow-hidden">
                          <StickToBottom.Content className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4">
                            <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
                              {isThreadEmpty ? (
                                <LiveTraceRawEmptyState testId="playground-live-raw-pending" />
                              ) : (
                                <TraceViewer
                                  trace={traceViewerTrace}
                                  model={selectedModel}
                                  toolsMetadata={toolsMetadata}
                                  toolServerMap={toolServerMap}
                                  forcedViewMode={activeTraceViewMode}
                                  hideToolbar
                                  fillContent
                                  onRevealNavigateToChat={() =>
                                    setTraceViewMode("chat")
                                  }
                                  sendFollowUpMessage={handleSendFollowUp}
                                  displayMode={displayMode}
                                  onDisplayModeChange={handleDisplayModeChange}
                                  onFullscreenChange={setIsWidgetFullscreen}
                                  rawGrowWithContent
                                  rawRequestPayloadHistory={{
                                    entries: requestPayloadHistory,
                                    hasUiMessages: !isThreadEmpty,
                                  }}
                                />
                              )}
                            </div>
                          </StickToBottom.Content>
                          <ScrollToBottomButton />
                        </div>
                      </StickToBottom>
                    ) : (
                      <div className="flex-1 min-h-0 overflow-hidden px-4 py-4">
                        <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
                          {showLiveTracePending ? (
                            <LiveTraceTimelineEmptyState testId="playground-live-trace-pending" />
                          ) : (
                            <TraceViewer
                              trace={traceViewerTrace}
                              model={selectedModel}
                              toolsMetadata={toolsMetadata}
                              toolServerMap={toolServerMap}
                              forcedViewMode={activeTraceViewMode}
                              hideToolbar
                              fillContent
                              onRevealNavigateToChat={() =>
                                setTraceViewMode("chat")
                              }
                              sendFollowUpMessage={handleSendFollowUp}
                              displayMode={displayMode}
                              onDisplayModeChange={handleDisplayModeChange}
                              onFullscreenChange={setIsWidgetFullscreen}
                              rawRequestPayloadHistory={{
                                entries: requestPayloadHistory,
                                hasUiMessages: !isThreadEmpty,
                              }}
                            />
                          )}
                        </div>
                      </div>
                    )}
                    <div className="flex-shrink-0 border-t border-border bg-background/70">
                      <div className="max-w-4xl mx-auto w-full p-3">
                        {errorMessage && (
                          <div className="pb-3">
                            <ErrorBox
                              message={errorMessage.message}
                              errorDetails={errorMessage.details}
                              code={errorMessage.code}
                              statusCode={errorMessage.statusCode}
                              isRetryable={errorMessage.isRetryable}
                              isMCPJamPlatformError={
                                errorMessage.isMCPJamPlatformError
                              }
                              onResetChat={resetChat}
                            />
                          </div>
                        )}
                        <ChatInput
                          {...sharedChatInputProps}
                          hasMessages={!isThreadEmpty}
                        />
                      </div>
                    </div>
                  </div>
                </ChatboxHostThemeProvider>
              </ChatboxHostStyleProvider>
            )}

            {/* Device frame container */}
            <div
              className="flex h-full items-center justify-center min-h-0 overflow-auto"
              style={showLiveTraceDiagnostics ? { display: "none" } : undefined}
            >
              <ChatboxHostStyleProvider value={hostStyle}>
                <ChatboxHostThemeProvider value={effectiveThreadTheme}>
                  <div
                    className={cn(
                      "chatbox-host-shell app-theme-scope relative flex flex-col overflow-hidden",
                      effectiveThreadTheme === "dark" && "dark",
                    )}
                    data-testid="playground-thread-shell"
                    data-host-style={hostStyle}
                    data-theme-preset={themePreset}
                    data-thread-theme={effectiveThreadTheme}
                    style={{
                      width: showPostConnectGuide ? "100%" : deviceConfig.width,
                      maxWidth: "100%",
                      height: showPostConnectGuide
                        ? "100%"
                        : isWidgetFullTakeover
                          ? "100%"
                          : deviceConfig.height,
                      maxHeight: "100%",
                      backgroundColor: showPostConnectGuide
                        ? undefined
                        : hostBackgroundColor,
                    }}
                  >
                    <div className="flex flex-col flex-1 min-h-0">
                      {threadContent}
                    </div>
                  </div>
                </ChatboxHostThemeProvider>
              </ChatboxHostStyleProvider>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
