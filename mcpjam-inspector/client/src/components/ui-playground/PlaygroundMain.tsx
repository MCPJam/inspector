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
  useCallback,
  useMemo,
  useRef,
} from "react";
import { ArrowDown, Braces, Loader2, Trash2 } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { formatErrorMessage } from "@/components/chat-v2/shared/chat-helpers";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import { MultiModelStartersEmptyLayout } from "@/components/chat-v2/multi-model-starters-empty";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
import { useChatSession } from "@/hooks/use-chat-session";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { CLAUDE_DESKTOP_CHAT_BACKGROUND } from "@/config/claude-desktop-host-context";
import { CHATGPT_CHAT_BACKGROUND } from "@/config/chatgpt-host-context";
import {
  DisplayContextHeader,
  PRESET_DEVICE_CONFIGS,
} from "@/components/shared/DisplayContextHeader";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { Settings2 } from "lucide-react";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { useConvexAuth } from "convex/react";
import { useWorkspaceServers } from "@/hooks/useViews";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import { useClientConfigStore } from "@/stores/client-config-store";
import { extractEffectiveHostDisplayMode } from "@/lib/client-config";
import { PostConnectGuide } from "@/components/app-builder/PostConnectGuide";
import {
  SandboxHostStyleProvider,
  SandboxHostThemeProvider,
} from "@/contexts/sandbox-host-style-context";
import { useComposerOnboarding } from "@/hooks/use-composer-onboarding";
import { useDebouncedXRayPayload } from "@/hooks/use-debounced-x-ray-payload";
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
import {
  type BroadcastChatTurnRequest,
} from "@/components/chat-v2/multi-model-chat-card";
import {
  type MultiModelCardSummary,
} from "@/components/chat-v2/model-compare-card-header";
import {
  MultiModelPlaygroundCard,
  type PlaygroundDeterministicExecutionRequest,
} from "@/components/ui-playground/multi-model-playground-card";

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
};

type ThreadThemeMode = "light" | "dark";

interface PlaygroundMainProps {
  serverName: string;
  enableTraceViews?: boolean;
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

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 flex bottom-12 justify-center animate-in slide-in-from-bottom fade-in duration-200">
      <button
        type="button"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border bg-background/90 px-2 py-2 text-xs font-medium shadow-sm transition hover:bg-accent"
        onClick={() => scrollToBottom({ animation: "smooth" })}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

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
  serverName,
  enableTraceViews = false,
  enableMultiModelChat = false,
  onWidgetStateChange,
  playgroundServerSelectorProps,
  isExecuting,
  executingToolName,
  invokingMessage,
  pendingExecution,
  onExecutionInjected,
  toolRenderOverrides: externalToolRenderOverrides = {},
  // Device/locale/timezone props are now managed via the store by DisplayContextHeader
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
  // Device config from store (managed by DisplayContextHeader)
  const storeDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const hostContext = useClientConfigStore((s) => s.draftConfig?.hostContext);
  const patchHostContext = useClientConfigStore((s) => s.patchHostContext);

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
    liveTraceEnvelope,
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
    hostedWorkspaceId: convexWorkspaceId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    onReset: () => composerOnResetRef.current(),
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
  const hostStyle = useUIPlaygroundStore((s) => s.hostStyle);
  const globalThemeMode = usePreferencesStore(
    (s) => s.themeMode,
  ) as ThreadThemeMode;
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const [threadThemeOverride, setThreadThemeOverride] =
    useState<ThreadThemeMode | null>(null);
  const effectiveThreadTheme = threadThemeOverride ?? globalThemeMode;
  const chatBg =
    hostStyle === "chatgpt"
      ? CHATGPT_CHAT_BACKGROUND
      : CLAUDE_DESKTOP_CHAT_BACKGROUND;
  const hostBackgroundColor = chatBg[effectiveThreadTheme];
  const displayMode =
    extractEffectiveHostDisplayMode(hostContext) ?? displayModeProp;

  // The App Builder theme toggle is intentionally local to the emulated thread
  // and composer surface. It should not change MCPJam's global theme or leak
  // into other tabs.
  const toggleLocalThreadTheme = useCallback(() => {
    setThreadThemeOverride((currentThemeOverride) => {
      const currentTheme = currentThemeOverride ?? globalThemeMode;
      const nextTheme: ThreadThemeMode =
        currentTheme === "dark" ? "light" : "dark";

      return nextTheme === globalThemeMode ? null : nextTheme;
    });
  }, [globalThemeMode]);

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
      .filter((model): model is ModelDefinition => !!model);

    if (persistedModels.length > 0) {
      return persistedModels.slice(0, 3);
    }

    return selectedModel ? [selectedModel] : [];
  }, [multiModelAvailableModels, selectedModel, selectedModelIds]);
  const canEnableMultiModel = enableMultiModelChat && availableModels.length > 1;
  const isMultiModelMode = canEnableMultiModel && multiModelEnabled;
  const effectiveHasMessages = isMultiModelMode
    ? Object.values(multiModelHasMessages).some(Boolean)
    : !isThreadEmpty;
  const preludeTraceEnvelope = useMemo(
    () => buildPreludeTraceEnvelope(preludeTraceExecutions),
    [preludeTraceExecutions],
  );
  const effectiveLiveTraceEnvelope =
    hasTraceSnapshot ? liveTraceEnvelope : preludeTraceEnvelope ?? liveTraceEnvelope;
  // Match ChatTabV2 `showTopTraceViewTabs`: keep Trace/Chat/Raw while multi-model is
  // empty; hide the top bar once compare columns are active (per-card trace tabs take over).
  const showTraceViewTabs =
    enableTraceViews &&
    traceViewsSupported &&
    (!isMultiModelMode || !effectiveHasMessages);
  const activeTraceViewMode: PlaygroundTraceViewMode = showTraceViewTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const isAnyMultiModelStreaming =
    isMultiModelMode &&
    Object.values(multiModelSummaries).some(
      (summary) => summary.status === "running",
    );

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

  useEffect(() => {
    if (!canEnableMultiModel && multiModelEnabled) {
      setMultiModelEnabled(false);
      setSelectedModelIds(selectedModel ? [String(selectedModel.id)] : []);
      return;
    }

    const sanitizedIds = resolvedSelectedModels.map((model) => String(model.id));
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
        Object.entries(previous).filter(([modelId]) => activeModelIds.has(modelId)),
      ),
    );
    setMultiModelHasMessages((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) => activeModelIds.has(modelId)),
      ),
    );
  }, [resolvedSelectedModels]);

  useEffect(() => {
    if (!enableTraceViews || !traceViewsSupported) {
      setTraceViewMode("chat");
    }
  }, [enableTraceViews, traceViewsSupported]);

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
      setDeterministicExecutionRequest({
        id: requestId,
        toolName: pendingExecution.toolName,
        params: pendingExecution.params,
        result: pendingExecution.result,
        toolMeta: pendingExecution.toolMeta,
        state: pendingExecution.state,
        errorText: pendingExecution.errorText,
        renderOverride: pendingExecution.renderOverride,
        toolCallId:
          pendingExecution.toolCallId ?? `playground-tool-${requestId}`,
        replaceExisting: pendingExecution.replaceExisting,
      });
      onExecutionInjected();
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

  // Handle follow-up messages from widgets
  const handleSendFollowUp = useCallback(
    (text: string) => {
      sendMessage({ text });
    },
    [sendMessage],
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
    setBroadcastRequest(null);
    setDeterministicExecutionRequest(null);
    setStopBroadcastRequestId(0);
    setMultiModelSessionGeneration((previous) => previous + 1);
    setMultiModelSummaries({});
    setMultiModelHasMessages({});
  }, []);

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
      handleResetAllChats();
    },
    [
      handleResetAllChats,
      setMultiModelEnabled,
      setSelectedModel,
      setSelectedModelIds,
    ],
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
      handleResetAllChats();
    },
    [handleResetAllChats, selectedModel, setSelectedModel, setSelectedModelIds],
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
        multi_model_count: isMultiModelMode
          ? resolvedSelectedModels.length
          : 1,
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

  // Placeholder text
  let placeholder = "Try a prompt that could call your tools...";
  if (disableChatInput) {
    placeholder = disabledInputPlaceholder;
  }
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use chat";
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
    if (
      hasContent &&
      !(isMultiModelMode ? isAnyMultiModelStreaming : status !== "ready") &&
      !submitBlocked &&
      !composer.submitGatedByServer
    ) {
      if (!isMultiModelMode && displayMode === "fullscreen" && isWidgetFullscreen) {
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
  const inputDisabled = isMultiModelMode
    ? disableChatInput || isAnyMultiModelStreaming || submitBlocked
    : disableChatInput || status !== "ready" || submitBlocked;

  const handleMultiModelStarterPrompt = useCallback(
    (prompt: string) => {
      if (submitBlocked || inputDisabled) {
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
    },
    [
      composer,
      fileAttachments,
      inputDisabled,
      onFirstMessageSent,
      queueBroadcastRequest,
      submitBlocked,
    ],
  );
  const traceViewerTrace = effectiveLiveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const playgroundRawXRayMirror = useDebouncedXRayPayload({
    systemPrompt,
    messages,
    selectedServers,
    enabled:
      traceViewsSupported &&
      showLiveTraceDiagnostics &&
      (isMultiModelMode ? !effectiveHasMessages : !isThreadEmpty),
  });
  const showLiveTracePending =
    activeTraceViewMode === "timeline" &&
    !hasLiveTimelineContent &&
    !preludeTraceEnvelope?.spans?.length;

  // Shared chat input props
  const sharedChatInputProps = {
    value: composer.input,
    onChange: composer.handleInputChange,
    onSubmit,
    stop: isMultiModelMode
      ? () => setStopBroadcastRequestId((previous) => previous + 1)
      : stop,
    disabled: inputDisabled,
    isLoading: isMultiModelMode ? isAnyMultiModelStreaming : isStreaming,
    placeholder,
    currentModel: selectedModel,
    availableModels,
    onModelChange: handleSingleModelChange,
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
    submitDisabled: submitBlocked || composer.submitGatedByServer,
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

  // Thread content - single ChatInput that persists across empty/non-empty states
  const threadContent = (
    <div className="relative flex flex-col flex-1 min-h-0">
      {isThreadEmpty ? (
        // Empty state — centered (welcome + composer, or post-connect guide)
        <div
          className={cn(
            "flex-1 flex overflow-y-auto overflow-x-hidden px-4 min-h-0",
            "items-center justify-center",
            hostStyle === "chatgpt"
              ? effectiveThreadTheme === "dark"
                ? "bg-[#212121] text-neutral-50"
                : "bg-white text-neutral-950"
              : effectiveThreadTheme === "dark"
                ? "bg-[#262624] text-[#F1F0ED]"
                : "bg-[#FAF9F5] text-[rgba(61,57,41,1)]",
          )}
        >
          <div
            className={cn(
              "mx-auto w-full max-w-4xl text-center",
              !showPostConnectGuide && "py-8",
            )}
          >
            {isAuthLoading ? (
              <div className="space-y-4">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                <p className="text-sm text-muted-foreground">Loading...</p>
              </div>
            ) : shouldShowUpsell ? (
              <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
            ) : showPostConnectGuide ? (
              <>
                <PostConnectGuide />
                <ChatInput {...sharedChatInputProps} hasMessages={false} />
              </>
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
                        hostStyle === "chatgpt"
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
                        hostStyle === "chatgpt"
                          ? effectiveThreadTheme === "dark"
                            ? "text-neutral-400"
                            : "text-neutral-600"
                          : effectiveThreadTheme === "dark"
                            ? "text-[#F1F0ED]/80"
                            : "text-[rgba(61,57,41,0.72)]",
                      )}
                    >
                      Test prompts, inspect tools, and debug AI-powered apps.
                      Type a message here, or run a tool on the left.
                    </p>
                  </div>
                </div>
                {!isWidgetFullTakeover && !showFullscreenChatOverlay && (
                  <div className="w-full shrink-0">
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
                    <ChatInput {...sharedChatInputProps} hasMessages={false} />
                    {composer.sendNuxCtaVisible && (
                      <HandDrawnSendHint
                        hostStyle={hostStyle}
                        theme={effectiveThreadTheme}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
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
                isLoading={status === "submitted"}
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
          disabled={inputDisabled}
          canSend={
            !disableChatInput &&
            status === "ready" &&
            !submitBlocked &&
            composer.input.trim().length > 0
          }
          isThinking={status === "submitted"}
          onSend={() => {
            sendMessage({ text: composer.input });
            composer.setInput("");
            setMcpPromptResults([]);
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
        showPostConnectGuide ? "bg-background" : "bg-muted/20",
      )}
    >
      {/* Device frame header — hidden during onboarding */}
      {!showPostConnectGuide && (
        <>
          <div
            className="relative flex h-11 items-center justify-center px-3 border-b border-border bg-background/50 text-xs text-muted-foreground flex-shrink-0"
            data-testid="playground-main-header"
          >
            <DisplayContextHeader
              protocol={selectedProtocol}
              showThemeToggle
              themeModeOverride={effectiveThreadTheme}
              onThemeToggleOverride={toggleLocalThreadTheme}
            />

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
        {isMultiModelMode ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              <div className="flex-1 min-h-0 overflow-auto px-4 py-4">
                <div className="flex min-h-full w-full min-w-0 flex-col">
                  {!effectiveHasMessages ? (
                    showLiveTraceDiagnostics && !showPostConnectGuide ? (
                      <MultiModelEmptyTraceDiagnosticsPanel
                        activeTraceViewMode={activeTraceViewMode}
                        effectiveHasMessages={effectiveHasMessages}
                        hasLiveTimelineContent={hasLiveTimelineContent}
                        traceViewerTrace={traceViewerTrace}
                        model={selectedModel}
                        toolsMetadata={toolsMetadata}
                        toolServerMap={toolServerMap}
                        traceStartedAtMs={
                          liveTraceEnvelope?.traceStartedAtMs ?? null
                        }
                        traceEndedAtMs={liveTraceEnvelope?.traceEndedAtMs ?? null}
                        rawXRayMirror={{
                          payload: playgroundRawXRayMirror.payload,
                          loading: playgroundRawXRayMirror.loading,
                          error: playgroundRawXRayMirror.error,
                          refetch: playgroundRawXRayMirror.refetch,
                          hasUiMessages: playgroundRawXRayMirror.hasMessages,
                        }}
                        rawEmptyTestId="playground-multi-empty-raw-pending"
                        timelineEmptyTestId="playground-multi-empty-trace-pending"
                        onRevealNavigateToChat={() =>
                          setTraceViewMode("chat")
                        }
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
                          <ChatInput
                            {...sharedChatInputProps}
                            hasMessages={false}
                          />
                        }
                      />
                    ) : (
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
                          <ChatInput
                            {...sharedChatInputProps}
                            hasMessages={false}
                          />
                        }
                      />
                    )
                  ) : null}

                  <div
                    className={cn(
                      "grid min-h-0 min-w-0 gap-4 auto-rows-[minmax(0,1fr)] [&>*]:min-h-0",
                      resolvedSelectedModels.length <= 1 && "grid-cols-1",
                      resolvedSelectedModels.length === 2 &&
                        "grid-cols-1 xl:grid-cols-2",
                      resolvedSelectedModels.length >= 3 &&
                        "grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3",
                      !effectiveHasMessages && "hidden",
                    )}
                    aria-hidden={!effectiveHasMessages}
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
                        initialSystemPrompt={systemPrompt}
                        initialTemperature={temperature}
                        initialRequireToolApproval={requireToolApproval}
                        hostedWorkspaceId={convexWorkspaceId}
                        hostedSelectedServerIds={hostedSelectedServerIds}
                        hostedOAuthTokens={hostedOAuthTokens}
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
                        showComparisonChrome={
                          resolvedSelectedModels.length > 1
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>

              {effectiveHasMessages ? (
                <div className="shrink-0 border-t border-border bg-background/80 backdrop-blur-sm">
                  <div className="w-full p-4">
                    <ChatInput
                      {...sharedChatInputProps}
                      hasMessages={effectiveHasMessages}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <>
            {showLiveTraceDiagnostics && (
              <SandboxHostStyleProvider value={hostStyle}>
                <SandboxHostThemeProvider value={effectiveThreadTheme}>
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
                                  rawGrowWithContent
                                  rawXRayMirror={{
                                    payload: playgroundRawXRayMirror.payload,
                                    loading: playgroundRawXRayMirror.loading,
                                    error: playgroundRawXRayMirror.error,
                                    refetch: playgroundRawXRayMirror.refetch,
                                    hasUiMessages:
                                      playgroundRawXRayMirror.hasMessages,
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
                              rawXRayMirror={{
                                payload: playgroundRawXRayMirror.payload,
                                loading: playgroundRawXRayMirror.loading,
                                error: playgroundRawXRayMirror.error,
                                refetch: playgroundRawXRayMirror.refetch,
                                hasUiMessages:
                                  playgroundRawXRayMirror.hasMessages,
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
                </SandboxHostThemeProvider>
              </SandboxHostStyleProvider>
            )}

            {/* Device frame container */}
            <div
              className="flex h-full items-center justify-center min-h-0 overflow-auto"
              style={showLiveTraceDiagnostics ? { display: "none" } : undefined}
            >
              <SandboxHostStyleProvider value={hostStyle}>
                <SandboxHostThemeProvider value={effectiveThreadTheme}>
                  <div
                    className={cn(
                      "sandbox-host-shell app-theme-scope relative flex flex-col overflow-hidden",
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
                      transform: isWidgetFullscreen ? "none" : "translateZ(0)",
                      backgroundColor: showPostConnectGuide
                        ? undefined
                        : hostBackgroundColor,
                    }}
                  >
                    <div
                      className="flex flex-col flex-1 min-h-0"
                    >
                      {threadContent}
                    </div>
                  </div>
                </SandboxHostThemeProvider>
              </SandboxHostStyleProvider>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
