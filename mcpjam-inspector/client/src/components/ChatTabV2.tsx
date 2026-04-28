import {
  FormEvent,
  useMemo,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
} from "react";
import type { UIMessage } from "ai";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { toast } from "sonner";
import { ModelDefinition } from "@/shared/types";
import { LoggerView } from "./logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import type { DialogElicitation } from "@/components/ToolsTab";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { Thread } from "@/components/chat-v2/thread";
import { type ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import type { LoadingIndicatorVariant } from "@/components/chat-v2/shared/loading-indicator-content";
import { ServerWithName } from "@/hooks/use-app-state";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { usePostHog, useFeatureFlagEnabled } from "posthog-js/react";
import {
  detectEnvironment,
  detectPlatform,
  standardEventProps,
} from "@/lib/PosthogUtils";
import { ErrorBox } from "@/components/chat-v2/error";
import { StickToBottom } from "use-stick-to-bottom";
import { type MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import {
  type FileAttachment,
  attachmentsToFileUIParts,
  revokeFileAttachmentUrls,
} from "@/components/chat-v2/chat-input/attachments/file-utils";
import {
  STARTER_PROMPTS,
  formatErrorMessage,
  buildMcpPromptMessages,
  buildSkillToolMessages,
  DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
  MINIMAL_CHAT_COMPOSER_PLACEHOLDER,
  cloneUiMessages,
} from "@/components/chat-v2/shared/chat-helpers";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import { MultiModelStartersEmptyLayout } from "@/components/chat-v2/multi-model-starters-empty";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { useChatSession } from "@/hooks/use-chat-session";
import type { ChatSessionResetReason } from "@/hooks/use-chat-session";
import { useDirectChatSessionSubscription } from "@/hooks/use-direct-chat-session-subscription";
import { addTokenToUrl, authFetch } from "@/lib/session-token";
import { cn } from "@/lib/utils";
import { WebApiError } from "@/lib/apis/web/base";
import { useSharedAppState } from "@/state/app-state-context";
import { ChatHistoryRail } from "@/components/chat-v2/history/ChatHistoryRail";
import {
  chatHistoryAction,
  getChatHistoryDetail,
  type ChatHistoryDetailSession,
  type ChatHistorySession,
  type ChatHistoryTurnTrace,
  type ChatHistoryWidgetSnapshot,
} from "@/lib/apis/web/chat-history-api";
import { useWorkspaceServers } from "@/hooks/useViews";
import { HOSTED_MODE } from "@/lib/config";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import { useModelSelectorLayoutLock } from "@/hooks/use-model-selector-layout-lock";
import { ChatTraceViewModeHeaderBar } from "@/components/evals/trace-view-mode-tabs";
import { SingleModelTraceDiagnosticsBody } from "@/components/evals/single-model-trace-diagnostics-body";
import {
  type BroadcastChatTurnRequest,
  MultiModelChatCard,
} from "@/components/chat-v2/multi-model-chat-card";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import {
  hasSameStringArray,
  resolveRestorableServerNames,
  shouldPreserveGuestServerSelection,
} from "@/components/chat-v2/history/session-restore";
import {
  getChatComposerInteractivity,
  useChatStopControls,
} from "@/hooks/use-chat-stop-controls";
import type { ChatboxHostStyle } from "@/lib/chatbox-host-style";

interface ChatTabProps {
  connectedOrConnectingServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
  /** All workspace servers (for the "+" dropdown server toggles). */
  allServerConfigs?: Record<string, ServerWithName>;
  /** Toggle a server on/off for multi-select. */
  onServerToggle?: (serverName: string) => void;
  /** Reconnect a disconnected server. */
  onReconnectServer?: (serverName: string) => Promise<void>;
  /** Add a new server (opens add-server modal). */
  onAddServer?: (formData: import("@/shared/types").ServerFormData) => void;
  onSelectedServerNamesChange?: (names: string[]) => void;
  onHasMessagesChange?: (hasMessages: boolean) => void;
  enableMultiModelChat?: boolean;
  minimalMode?: boolean;
  hostedWorkspaceIdOverride?: string;
  hostedSelectedServerIdsOverride?: string[];
  hostedOAuthTokensOverride?: Record<string, string>;
  hostedContext?: HostedRuntimeContext;
  executionConfig?: ExecutionConfig;
  reasoningDisplayMode?: ReasoningDisplayMode;
  loadingIndicatorVariant?: LoadingIndicatorVariant;
  showHostStyleSelector?: boolean;
  hostStyle?: ChatboxHostStyle;
  onHostStyleChange?: (hostStyle: ChatboxHostStyle) => void;
  onOAuthRequired?: (details?: HostedOAuthRequiredDetails) => void;
  /** When true, blocks sending until chatbox onboarding/OAuth completes. */
  chatboxComposerBlocked?: boolean;
  chatboxComposerBlockedReason?: string;
  /** Optional (off-by-default) servers the tester can attach from minimal chat. */
  chatboxOptionalInventory?: Array<{
    serverId: string;
    serverName: string;
    useOAuth: boolean;
  }>;
  onEnableChatboxOptionalServer?: (serverId: string) => void;
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
}

type ChatTraceViewMode = "chat" | "timeline" | "raw";
const RESUMED_THREAD_REFRESH_RETRIES = 2;

export function ChatTabV2({
  connectedOrConnectingServerConfigs,
  selectedServerNames,
  allServerConfigs,
  onServerToggle,
  onReconnectServer,
  onAddServer,
  onSelectedServerNamesChange,
  onHasMessagesChange,
  enableMultiModelChat = false,
  minimalMode = false,
  hostedWorkspaceIdOverride,
  hostedSelectedServerIdsOverride,
  hostedOAuthTokensOverride,
  hostedContext,
  executionConfig,
  reasoningDisplayMode = "inline",
  loadingIndicatorVariant,
  showHostStyleSelector = false,
  hostStyle,
  onHostStyleChange,
  onOAuthRequired,
  chatboxComposerBlocked = false,
  chatboxComposerBlockedReason,
  chatboxOptionalInventory,
  onEnableChatboxOptionalServer,
  evalChatHandoff,
  onEvalChatHandoffConsumed,
}: ChatTabProps) {
  const { signUp } = useAuth();
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const appState = useSharedAppState();
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const posthog = usePostHog();
  const chatHistoryRailEnabled = useFeatureFlagEnabled("chat-history-rail");
  const sharedThreadsEnabled =
    useFeatureFlagEnabled("shared-threads-enabled") === true;

  // Local state for ChatTabV2-specific features
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    []
  );
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [widgetStateQueue, setWidgetStateQueue] = useState<
    { toolCallId: string; state: unknown }[]
  >([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [elicitationQueue, setElicitationQueue] = useState<DialogElicitation[]>(
    []
  );
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [, setIsWidgetFullscreen] = useState(false);
  const [broadcastRequest, setBroadcastRequest] =
    useState<BroadcastChatTurnRequest | null>(null);
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
  const [activeHistorySessionId, setActiveHistorySessionId] = useState<
    string | null
  >(null);
  const [loadingHistorySessionId, setLoadingHistorySessionId] = useState<
    string | null
  >(null);
  const [pendingDirectVisibility, setPendingDirectVisibility] = useState<
    "private" | "workspace"
  >("private");
  const historyRefreshSignal = 0;

  const [traceViewMode, setTraceViewMode] = useState<ChatTraceViewMode>("chat");
  const [revealedInChat, setRevealedInChat] = useState(false);
  const pendingHistoryServerSyncRef = useRef<string[] | null>(null);
  const historySelectionRequestIdRef = useRef(0);
  const resumedThreadSendBaselineRef = useRef<{
    sessionId: string;
    version: number;
  } | null>(null);
  const activeHistorySessionIdRef = useRef<string | null>(null);
  const reactiveHistoryLoadRequestIdRef = useRef(0);
  const lastAppliedReactiveVersionRef = useRef<{
    sessionId: string;
    version: number;
  } | null>(null);
  const hasUnsavedDraftRef = useRef(false);

  /** Invalidate reactive history loads immediately (refs otherwise lag behind state until useEffect). */
  const invalidatePendingReactiveHistoryLoad = useCallback(() => {
    activeHistorySessionIdRef.current = null;
    reactiveHistoryLoadRequestIdRef.current += 1;
    lastAppliedReactiveVersionRef.current = null;
  }, []);

  const cancelPendingHistorySelection = useCallback(() => {
    historySelectionRequestIdRef.current += 1;
    pendingHistoryServerSyncRef.current = null;
    setLoadingHistorySessionId(null);
    invalidatePendingReactiveHistoryLoad();
    setActiveHistorySessionId(null);
  }, [invalidatePendingReactiveHistoryLoad]);

  // Filter to only connected servers
  const selectedConnectedServerNames = useMemo(
    () =>
      selectedServerNames.filter(
        (name) =>
          connectedOrConnectingServerConfigs[name]?.connectionStatus ===
          "connected"
      ),
    [selectedServerNames, connectedOrConnectingServerConfigs]
  );
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const convexWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;
  const { serversById, serversByName } = useWorkspaceServers({
    isAuthenticated: isConvexAuthenticated,
    workspaceId: convexWorkspaceId,
  });
  const hostedSelectedServerIds = useMemo(
    () =>
      selectedConnectedServerNames
        .map((serverName) => serversByName.get(serverName))
        .filter((serverId): serverId is string => !!serverId),
    [selectedConnectedServerNames, serversByName]
  );
  const hostedOAuthTokens = useMemo(
    () =>
      buildOAuthTokensByServerId(
        selectedConnectedServerNames,
        (name) => serversByName.get(name),
        (name) => appState.servers[name]?.oauthTokens?.access_token
      ),
    [selectedConnectedServerNames, serversByName, appState.servers]
  );
  const hostedShareToken = hostedContext?.shareToken;
  const hostedChatboxToken = hostedContext?.chatboxToken;
  const hostedChatboxSurface = hostedContext?.chatboxSurface;
  const effectiveHostedWorkspaceId =
    hostedWorkspaceIdOverride ?? convexWorkspaceId;
  const effectiveHostedSelectedServerIds =
    hostedSelectedServerIdsOverride ?? hostedSelectedServerIds;
  const effectiveHostedOAuthTokens = hostedChatboxToken
    ? undefined
    : hostedOAuthTokensOverride ?? hostedOAuthTokens;
  const isHostedDirectGuest =
    HOSTED_MODE &&
    !isConvexAuthenticated &&
    !effectiveHostedWorkspaceId &&
    !hostedShareToken &&
    !hostedChatboxToken;

  // Use shared chat session hook
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
    isSessionBootstrapComplete,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    toolsMetadata,
    toolServerMap,
    tokenUsage,
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,
    resetChat: baseResetChat,
    startChatWithMessages,
    loadChatSession,
    syncResumedVersion,
    resumedVersion,
    restoredToolRenderOverrides,
    liveTraceEnvelope,
    requestPayloadHistory,
    hasTraceSnapshot,
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    disableForAuthentication,
    submitBlocked: baseSubmitBlocked,
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse,
  } = useChatSession({
    selectedServers: selectedConnectedServerNames,
    directVisibility: pendingDirectVisibility,
    hostedContext: {
      ...hostedContext,
      workspaceId: effectiveHostedWorkspaceId,
      selectedServerIds: effectiveHostedSelectedServerIds,
      oauthTokens: effectiveHostedOAuthTokens,
    },
    executionConfig,
    minimalMode,
    onReset: (reason?: ChatSessionResetReason) => {
      if (reason === "auth-bootstrap" || reason === "hydrate") {
        return;
      }
      setModelContextQueue([]);
      setWidgetStateQueue([]);
      if (reason === "servers-changed") {
        return;
      }
      setInput("");
      setMcpPromptResults([]);
      setSkillResults([]);
      revokeFileAttachmentUrls(fileAttachments);
      setFileAttachments([]);
      cancelPendingHistorySelection();
    },
  });

  // Chat history handlers
  const showHistoryRail =
    HOSTED_MODE &&
    !minimalMode &&
    !hostedShareToken &&
    !hostedChatboxToken &&
    chatHistoryRailEnabled;
  const {
    session: reactiveHistorySession,
    widgetSnapshots: reactiveHistoryWidgetSnapshots,
  } = useDirectChatSessionSubscription({
    sessionId: activeHistorySessionId,
    workspaceId: effectiveHostedWorkspaceId,
    enabled:
      showHistoryRail &&
      isConvexAuthenticated &&
      !!activeHistorySessionId &&
      !isStreaming,
  });
  const [isHistorySidebarVisible, setIsHistorySidebarVisible] = useState(false);

  useEffect(() => {
    if (!showHistoryRail) {
      setIsHistorySidebarVisible(true);
    }
  }, [showHistoryRail]);

  const historyRailTakesLayoutSpace =
    showHistoryRail && isHistorySidebarVisible;
  const hasConversationMessages = messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant"
  );

  const hasUnsavedDraft =
    !!input.trim() ||
    mcpPromptResults.length > 0 ||
    skillResults.length > 0 ||
    fileAttachments.length > 0;

  useEffect(() => {
    hasUnsavedDraftRef.current = hasUnsavedDraft;
  }, [hasUnsavedDraft]);

  const handleOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      const resolvedServerName =
        typeof details?.serverName === "string" && details.serverName.trim()
          ? details.serverName.trim()
          : selectedConnectedServerNames.length === 1
          ? selectedConnectedServerNames[0]
          : null;

      if (!onOAuthRequired) {
        return;
      }

      onOAuthRequired(
        resolvedServerName && resolvedServerName !== details?.serverName
          ? { ...details, serverName: resolvedServerName }
          : details
      );
    },
    [onOAuthRequired, selectedConnectedServerNames]
  );

  useEffect(() => {
    activeHistorySessionIdRef.current = activeHistorySessionId;
  }, [activeHistorySessionId]);

  useEffect(() => {
    reactiveHistoryLoadRequestIdRef.current += 1;
    lastAppliedReactiveVersionRef.current = null;
  }, [activeHistorySessionId]);

  useEffect(() => {
    if (!activeHistorySessionId || resumedVersion === null) {
      return;
    }

    const lastApplied = lastAppliedReactiveVersionRef.current;
    if (
      lastApplied?.sessionId === activeHistorySessionId &&
      lastApplied.version >= resumedVersion
    ) {
      return;
    }

    lastAppliedReactiveVersionRef.current = {
      sessionId: activeHistorySessionId,
      version: resumedVersion,
    };
  }, [activeHistorySessionId, resumedVersion]);

  const [discardDraftDialogOpen, setDiscardDraftDialogOpen] = useState(false);
  const discardDraftResolveRef = useRef<((allow: boolean) => void) | null>(
    null
  );
  const discardDraftSettledRef = useRef(false);

  const settleDiscardDraft = useCallback((confirmed: boolean) => {
    if (discardDraftSettledRef.current) {
      return;
    }
    discardDraftSettledRef.current = true;
    const resolve = discardDraftResolveRef.current;
    discardDraftResolveRef.current = null;
    resolve?.(confirmed);
    setDiscardDraftDialogOpen(false);
  }, []);

  const ensureDiscardDraftConfirmed = useCallback((): Promise<boolean> => {
    if (!hasUnsavedDraft) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      discardDraftSettledRef.current = false;
      discardDraftResolveRef.current = resolve;
      setDiscardDraftDialogOpen(true);
    });
  }, [hasUnsavedDraft]);

  const clearComposerDraft = useCallback(() => {
    setInput("");
    setMcpPromptResults([]);
    setSkillResults([]);
    revokeFileAttachmentUrls(fileAttachments);
    setFileAttachments([]);
    setModelContextQueue([]);
    setWidgetStateQueue([]);
  }, [fileAttachments]);

  const detachHistorySession = useCallback(
    (toastMessage: string) => {
      resumedThreadSendBaselineRef.current = null;
      cancelPendingHistorySelection();
      setPendingDirectVisibility("private");
      syncResumedVersion(null);
      if (hasConversationMessages) {
        startChatWithMessages(cloneUiMessages(messages), {
          toolRenderOverrides: restoredToolRenderOverrides,
        });
      }
      toast.error(toastMessage);
    },
    [
      hasConversationMessages,
      messages,
      restoredToolRenderOverrides,
      startChatWithMessages,
      syncResumedVersion,
      cancelPendingHistorySelection,
    ]
  );

  const markHistorySessionRead = useCallback(async (sessionId: string) => {
    try {
      await chatHistoryAction("mark-read", sessionId);
    } catch {
      // Best-effort: unread state should not block chat usage.
    }
  }, []);

  const loadHistorySession = useCallback(
    async (
      detail: ChatHistoryDetailSession,
      widgetSnapshots?: ChatHistoryWidgetSnapshot[],
      options?: {
        shouldRestoreComposerState?: () => boolean;
        shouldApply?: () => boolean;
        turnTraces?: ChatHistoryTurnTrace[];
      }
    ) => {
      await loadChatSession(
        {
          chatSessionId: detail.chatSessionId,
          messagesBlobUrl: detail.messagesBlobUrl,
          resumeConfig: detail.resumeConfig,
          version: detail.version,
          widgetSnapshots,
          turnTraces: options?.turnTraces,
        },
        {
          shouldRestoreResumeConfig: options?.shouldRestoreComposerState,
          shouldApply: options?.shouldApply,
        }
      );
      if (options?.shouldApply && !options.shouldApply()) {
        return;
      }
      const shouldRestoreComposerState =
        options?.shouldRestoreComposerState?.() ?? true;
      if (shouldRestoreComposerState && detail.modelId) {
        const matchingModel = availableModels.find(
          (model) => String(model.id) === detail.modelId
        );
        if (matchingModel) {
          setSelectedModel(matchingModel);
        }
      }
      setActiveHistorySessionId(detail._id);
      setPendingDirectVisibility(detail.directVisibility);
      syncResumedVersion(detail.version);
      lastAppliedReactiveVersionRef.current = {
        sessionId: detail._id,
        version: detail.version,
      };
      void markHistorySessionRead(detail._id);
    },
    [
      availableModels,
      loadChatSession,
      markHistorySessionRead,
      setSelectedModel,
      syncResumedVersion,
    ]
  );

  const refreshCurrentHistorySession = useCallback(
    async ({ retries = 0, markRead = false } = {}) => {
      if (!showHistoryRail) {
        return null;
      }

      if (!hasConversationMessages && !activeHistorySessionId) {
        return null;
      }

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const detail = await getChatHistoryDetail({
            sessionId: activeHistorySessionId ?? undefined,
            chatSessionId,
            workspaceId: effectiveHostedWorkspaceId ?? undefined,
          });
          setActiveHistorySessionId(detail.session._id);
          syncResumedVersion(detail.session.version);
          if (markRead) {
            void markHistorySessionRead(detail.session._id);
          }
          return detail.session;
        } catch (error) {
          if (attempt < retries) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            continue;
          }
          if (
            error instanceof WebApiError &&
            (error.status === 403 || error.status === 404)
          ) {
            return null;
          }
          throw error;
        }
      }

      return null;
    },
    [
      activeHistorySessionId,
      chatSessionId,
      effectiveHostedWorkspaceId,
      hasConversationMessages,
      markHistorySessionRead,
      showHistoryRail,
      syncResumedVersion,
    ]
  );

  const refreshHistorySessionAfterStream = useCallback(
    async (
      resumedThreadSendBaseline: {
        sessionId: string;
        version: number;
      } | null
    ) => {
      const maxAttempts = resumedThreadSendBaseline
        ? RESUMED_THREAD_REFRESH_RETRIES + 1
        : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const detail = await refreshCurrentHistorySession({
            markRead: true,
          });

          if (
            !resumedThreadSendBaseline ||
            (detail &&
              detail._id === resumedThreadSendBaseline.sessionId &&
              detail.version > resumedThreadSendBaseline.version)
          ) {
            return detail;
          }
        } catch (error) {
          if (attempt >= maxAttempts - 1) {
            throw error;
          }
        }

        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }

      return null;
    },
    [refreshCurrentHistorySession]
  );

  useEffect(() => {
    if (!showHistoryRail || !activeHistorySessionId || isStreaming) {
      return;
    }

    if (reactiveHistorySession === undefined) {
      return;
    }

    if (reactiveHistorySession === null) {
      detachHistorySession(
        "This chat is no longer available. Continuing locally in a new thread."
      );
      return;
    }

    if (reactiveHistoryWidgetSnapshots === undefined) {
      return;
    }

    const lastApplied = lastAppliedReactiveVersionRef.current;
    if (
      lastApplied?.sessionId === reactiveHistorySession._id &&
      lastApplied.version >= reactiveHistorySession.version
    ) {
      return;
    }

    const requestId = reactiveHistoryLoadRequestIdRef.current + 1;
    reactiveHistoryLoadRequestIdRef.current = requestId;

    void loadHistorySession(
      reactiveHistorySession,
      reactiveHistoryWidgetSnapshots,
      {
        shouldRestoreComposerState: () =>
          !hasUnsavedDraftRef.current &&
          activeHistorySessionIdRef.current === reactiveHistorySession._id,
        shouldApply: () =>
          reactiveHistoryLoadRequestIdRef.current === requestId &&
          activeHistorySessionIdRef.current === reactiveHistorySession._id,
        // Intentionally omit turnTraces here: loadChatSession treats
        // `undefined` as "preserve existing trace state", so the live
        // trace viewer is not wiped by reactive session refreshes. Traces
        // are seeded once via the REST detail path on thread selection.
      }
    ).catch((error) => {
      console.error("[ChatTabV2] Failed to apply reactive chat history", error);
    });
  }, [
    activeHistorySessionId,
    detachHistorySession,
    isStreaming,
    loadHistorySession,
    reactiveHistorySession,
    reactiveHistoryWidgetSnapshots,
    showHistoryRail,
  ]);

  const ensureThreadReadyForSend = useCallback(async () => {
    let detail: ChatHistoryDetailSession | null = null;
    try {
      detail = await refreshCurrentHistorySession();
    } catch (error) {
      console.error(
        "[ChatTabV2] Failed to sync chat history before send",
        error
      );
      toast.error("Failed to sync chat history. Try again.");
      return false;
    }
    if (detail) {
      return true;
    }

    if (activeHistorySessionId) {
      detachHistorySession(
        "This chat is no longer available. Your draft stayed local, and the next send will start a new thread."
      );
      return false;
    }

    return true;
  }, [
    activeHistorySessionId,
    detachHistorySession,
    refreshCurrentHistorySession,
  ]);

  const handleSelectThread = useCallback(
    async (session: ChatHistorySession) => {
      if (isStreaming) return;
      if (!(await ensureDiscardDraftConfirmed())) {
        return;
      }
      if (hasUnsavedDraft) {
        clearComposerDraft();
      }

      const selectionRequestId = historySelectionRequestIdRef.current + 1;
      historySelectionRequestIdRef.current = selectionRequestId;
      pendingHistoryServerSyncRef.current = null;
      setActiveHistorySessionId(session._id);
      setLoadingHistorySessionId(session._id);

      try {
        const detail = await getChatHistoryDetail({
          sessionId: session._id,
          chatSessionId: session.chatSessionId,
          workspaceId: effectiveHostedWorkspaceId ?? undefined,
        });

        if (historySelectionRequestIdRef.current !== selectionRequestId) {
          return;
        }

        const desiredServerNames = resolveRestorableServerNames(
          detail.session.resumeConfig?.selectedServers,
          serversById,
          Object.keys(appState.servers)
        );
        const syncedServerNames =
          isHostedDirectGuest &&
          shouldPreserveGuestServerSelection(
            detail.session.resumeConfig?.selectedServers,
            desiredServerNames,
            selectedServerNames
          )
            ? [...selectedServerNames]
            : desiredServerNames;
        const hasSavedServerSelection = Array.isArray(
          detail.session.resumeConfig?.selectedServers
        );

        await loadHistorySession(detail.session, detail.widgetSnapshots, {
          turnTraces: detail.turnTraces,
        });

        if (
          historySelectionRequestIdRef.current !== selectionRequestId ||
          !hasSavedServerSelection ||
          !onSelectedServerNamesChange ||
          hasSameStringArray(selectedServerNames, syncedServerNames)
        ) {
          return;
        }

        pendingHistoryServerSyncRef.current = syncedServerNames;
        onSelectedServerNamesChange(syncedServerNames);
      } catch (err) {
        if (historySelectionRequestIdRef.current === selectionRequestId) {
          invalidatePendingReactiveHistoryLoad();
          setActiveHistorySessionId(null);
        }
        console.error("[ChatTabV2] Failed to load chat session", err);
        toast.error("Failed to load chat history.");
      } finally {
        if (historySelectionRequestIdRef.current === selectionRequestId) {
          setLoadingHistorySessionId(null);
        }
      }
    },
    [
      appState.servers,
      clearComposerDraft,
      ensureDiscardDraftConfirmed,
      effectiveHostedWorkspaceId,
      hasUnsavedDraft,
      isHostedDirectGuest,
      isStreaming,
      loadHistorySession,
      onSelectedServerNamesChange,
      selectedServerNames,
      serversById,
      invalidatePendingReactiveHistoryLoad,
    ]
  );

  const handleNewChat = useCallback(
    async (options?: { shared?: boolean }) => {
      if (isStreaming) return;
      if (!(await ensureDiscardDraftConfirmed())) {
        return;
      }
      if (hasUnsavedDraft) {
        clearComposerDraft();
      }
      resumedThreadSendBaselineRef.current = null;
      cancelPendingHistorySelection();
      syncResumedVersion(null);
      baseResetChat();
      setPendingDirectVisibility(options?.shared ? "workspace" : "private");
    },
    [
      baseResetChat,
      cancelPendingHistorySelection,
      clearComposerDraft,
      ensureDiscardDraftConfirmed,
      hasUnsavedDraft,
      isStreaming,
      syncResumedVersion,
    ]
  );

  const handleArchiveAllComplete = useCallback(
    (hadActiveHistorySelection: boolean) => {
      if (!hadActiveHistorySelection) return;
      if (hasUnsavedDraft) {
        clearComposerDraft();
      }
      cancelPendingHistorySelection();
      syncResumedVersion(null);
      baseResetChat();
      setPendingDirectVisibility("private");
    },
    [
      baseResetChat,
      cancelPendingHistorySelection,
      clearComposerDraft,
      hasUnsavedDraft,
      syncResumedVersion,
    ]
  );

  const handleHistorySessionAction = useCallback(
    async ({
      action,
      session,
    }: {
      action:
        | "rename"
        | "archive"
        | "unarchive"
        | "share"
        | "unshare"
        | "pin"
        | "unpin";
      session: ChatHistorySession;
    }) => {
      if (action === "unshare" && session._id === activeHistorySessionId) {
        try {
          const detail = await refreshCurrentHistorySession();
          if (!detail) {
            detachHistorySession(
              "This chat is no longer shared with you. Continuing locally in a new thread."
            );
          }
        } catch (error) {
          console.error("[ChatTabV2] Failed to refresh unshared chat", error);
        }
      }
    },
    [activeHistorySessionId, detachHistorySession, refreshCurrentHistorySession]
  );

  const previousSelectedServerNamesRef = useRef(selectedServerNames);
  useEffect(() => {
    const previousSelectedServerNames = previousSelectedServerNamesRef.current;
    previousSelectedServerNamesRef.current = selectedServerNames;

    const pendingHistoryServerSync = pendingHistoryServerSyncRef.current;
    if (
      pendingHistoryServerSync &&
      hasSameStringArray(pendingHistoryServerSync, selectedServerNames)
    ) {
      pendingHistoryServerSyncRef.current = null;
      return;
    }

    if (hasSameStringArray(previousSelectedServerNames, selectedServerNames)) {
      return;
    }
  }, [selectedServerNames]);

  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    const wasStreaming =
      previousStatus === "submitted" || previousStatus === "streaming";
    const isNowStreaming = status === "submitted" || status === "streaming";
    const hasStartedStream = !wasStreaming && isNowStreaming;

    if (hasStartedStream) {
      resumedThreadSendBaselineRef.current =
        showHistoryRail && activeHistorySessionId && resumedVersion !== null
          ? {
              sessionId: activeHistorySessionId,
              version: resumedVersion,
            }
          : null;
      return;
    }

    if (!wasStreaming) {
      return;
    }

    if (status === "error") {
      resumedThreadSendBaselineRef.current = null;
      return;
    }

    const resumedThreadSendBaseline = resumedThreadSendBaselineRef.current;
    resumedThreadSendBaselineRef.current = null;
    const hasCompletedStream = status === "ready";

    if (!hasCompletedStream || !showHistoryRail) {
      return;
    }

    if (activeHistorySessionId) {
      void markHistorySessionRead(activeHistorySessionId);
    }

    const timerId = window.setTimeout(() => {
      void (async () => {
        const detail = await refreshHistorySessionAfterStream(
          resumedThreadSendBaseline
        );

        if (
          resumedThreadSendBaseline &&
          (!detail ||
            detail._id !== resumedThreadSendBaseline.sessionId ||
            detail.version <= resumedThreadSendBaseline.version)
        ) {
          detachHistorySession(
            "This chat changed elsewhere. This reply stayed local, and your next send will continue in a new thread."
          );
        }
      })().catch((error) => {
        console.error("[ChatTabV2] Failed to refresh chat history", error);
      });
    }, 250);

    return () => window.clearTimeout(timerId);
  }, [
    activeHistorySessionId,
    detachHistorySession,
    markHistorySessionRead,
    refreshHistorySessionAfterStream,
    resumedVersion,
    showHistoryRail,
    status,
  ]);

  // Check if thread is empty
  const isThreadEmpty = !hasConversationMessages;
  const multiModelAvailableModels = useMemo(
    () => new Map(availableModels.map((model) => [String(model.id), model])),
    [availableModels]
  );
  const resolvedSelectedModels = useMemo(() => {
    const persistedModels = selectedModelIds
      .map((modelId) => multiModelAvailableModels.get(modelId))
      .filter((model): model is ModelDefinition => !!model && !model.disabled);

    if (persistedModels.length > 0) {
      return persistedModels.slice(0, 3);
    }

    return selectedModel ? [selectedModel] : [];
  }, [
    availableModels,
    multiModelAvailableModels,
    selectedModel,
    selectedModelIds,
  ]);
  const canEnableMultiModel =
    enableMultiModelChat &&
    !minimalMode &&
    !executionConfig?.modelId &&
    !hostedShareToken &&
    !hostedChatboxToken &&
    !hostedChatboxSurface &&
    availableModels.length > 1;
  // When viewing a history session, fall back to single-model rendering so
  // the ChatTabV2 messages (which hold the hydrated transcript) are displayed.
  // The user can still toggle multi-model for new chats afterward.
  const isMultiModelMode =
    canEnableMultiModel && multiModelEnabled && !activeHistorySessionId;
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
    []
  );

  const clearMultiModelUiState = useCallback(() => {
    setBroadcastRequest(null);
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
            (m) => m.role === "user" || m.role === "assistant"
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
  const showTopTraceViewTabs =
    traceViewsSupported &&
    !minimalMode &&
    (!isMultiModelLayoutMode || !effectiveHasMessages);
  const activeTraceViewMode: ChatTraceViewMode = showTopTraceViewTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const appliedEvalChatHandoffIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!traceViewsSupported) {
      setTraceViewMode("chat");
      setRevealedInChat(false);
    }
  }, [traceViewsSupported]);

  useEffect(() => {
    if (!canEnableMultiModel && multiModelEnabled) {
      setMultiModelEnabled(false);
      setSelectedModelIds(selectedModel ? [String(selectedModel.id)] : []);
      return;
    }

    const sanitizedIds = resolvedSelectedModels.map((model) =>
      String(model.id)
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
          : []
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
      resolvedSelectedModels.map((model) => String(model.id))
    );

    setMultiModelSummaries((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) =>
          activeModelIds.has(modelId)
        )
      )
    );
    setMultiModelHasMessages((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) =>
          activeModelIds.has(modelId)
        )
      )
    );
  }, [resolvedSelectedModels]);

  useEffect(() => {
    setTraceViewMode("chat");
    setRevealedInChat(false);
  }, [chatSessionId]);

  useEffect(() => {
    if (!evalChatHandoff) {
      return;
    }

    if (!isSessionBootstrapComplete) {
      return;
    }

    if (appliedEvalChatHandoffIdRef.current === evalChatHandoff.id) {
      return;
    }

    let matchingModel = null;
    if (evalChatHandoff.modelId) {
      matchingModel = availableModels.find(
        (model) => String(model.id) === evalChatHandoff.modelId
      );
      if (!matchingModel && availableModels.length === 0) {
        return;
      }
    }

    if (matchingModel) {
      setMultiModelEnabled(false);
      setSelectedModelIds([String(matchingModel.id)]);
      setSelectedModel(matchingModel);
    } else if (selectedModel) {
      setMultiModelEnabled(false);
      setSelectedModelIds([String(selectedModel.id)]);
    }

    startChatWithMessages(evalChatHandoff.messages);
    appliedEvalChatHandoffIdRef.current = evalChatHandoff.id;

    if (typeof evalChatHandoff.systemPrompt === "string") {
      setSystemPrompt(evalChatHandoff.systemPrompt);
    }

    if (typeof evalChatHandoff.temperature === "number") {
      setTemperature(evalChatHandoff.temperature);
    }

    if (typeof evalChatHandoff.requireToolApproval === "boolean") {
      setRequireToolApproval(evalChatHandoff.requireToolApproval);
    }

    setInput("");
    onEvalChatHandoffConsumed?.(evalChatHandoff.id);
  }, [
    availableModels,
    evalChatHandoff,
    isSessionBootstrapComplete,
    onEvalChatHandoffConsumed,
    selectedModel,
    setMultiModelEnabled,
    setSelectedModel,
    setSelectedModelIds,
    setSystemPrompt,
    setTemperature,
    setRequireToolApproval,
    startChatWithMessages,
  ]);

  // Server instructions
  const selectedServerInstructions = useMemo(() => {
    const instructions: Record<string, string> = {};
    for (const serverName of selectedServerNames) {
      const server = connectedOrConnectingServerConfigs[serverName];
      const instruction = server?.initializationInfo?.instructions;
      if (instruction) {
        instructions[serverName] = instruction;
      }
    }
    return instructions;
  }, [connectedOrConnectingServerConfigs, selectedServerNames]);

  // Keep server instruction system messages in sync with selected servers
  useEffect(() => {
    setMessages((prev) => {
      const filtered = prev.filter(
        (msg) =>
          !(
            msg.role === "system" &&
            (msg as { metadata?: { source?: string } })?.metadata?.source ===
              "server-instruction"
          )
      );

      const instructionMessages = Object.entries(selectedServerInstructions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([serverName, instruction]) => ({
          id: `server-instruction-${serverName}`,
          role: "system" as const,
          parts: [
            {
              type: "text" as const,
              text: `Server ${serverName} instructions: ${instruction}`,
            },
          ],
          metadata: { source: "server-instruction", serverName },
        }));

      return [...instructionMessages, ...filtered];
    });
  }, [selectedServerInstructions, setMessages]);

  // PostHog tracking
  useEffect(() => {
    posthog.capture("chat_tab_viewed", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, [posthog]);

  // Notify parent when messages change
  useEffect(() => {
    onHasMessagesChange?.(effectiveHasMessages);
  }, [effectiveHasMessages, onHasMessagesChange]);

  // Widget state management
  const applyWidgetStateUpdates = useCallback(
    (
      prevMessages: typeof messages,
      updates: { toolCallId: string; state: unknown }[]
    ) => {
      let nextMessages = prevMessages;

      for (const { toolCallId, state } of updates) {
        const messageId = `widget-state-${toolCallId}`;

        if (state === null) {
          const filtered = nextMessages.filter((msg) => msg.id !== messageId);
          nextMessages = filtered;
          continue;
        }

        const stateText = `The state of widget ${toolCallId} is: ${JSON.stringify(
          state
        )}`;
        const existingIndex = nextMessages.findIndex(
          (msg) => msg.id === messageId
        );

        if (existingIndex !== -1) {
          const existingMessage = nextMessages[existingIndex];
          const existingText =
            existingMessage.parts?.[0]?.type === "text"
              ? (existingMessage.parts[0] as { text?: string }).text
              : null;

          if (existingText === stateText) {
            continue;
          }

          const updatedMessages = [...nextMessages];
          updatedMessages[existingIndex] = {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text" as const, text: stateText }],
          };
          nextMessages = updatedMessages;
          continue;
        }

        nextMessages = [
          ...nextMessages,
          {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text" as const, text: stateText }],
          },
        ];
      }

      return nextMessages;
    },
    []
  );

  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      if (status === "ready") {
        setMessages((prevMessages) =>
          applyWidgetStateUpdates(prevMessages, [{ toolCallId, state }])
        );
      } else {
        setWidgetStateQueue((prev) => [...prev, { toolCallId, state }]);
      }
    },
    [status, setMessages, applyWidgetStateUpdates]
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) return;

    setMessages((prevMessages) =>
      applyWidgetStateUpdates(prevMessages, widgetStateQueue)
    );
    setWidgetStateQueue([]);
  }, [status, widgetStateQueue, setMessages, applyWidgetStateUpdates]);

  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      }
    ) => {
      // Queue model context to be included in next message
      setModelContextQueue((prev) => {
        // Remove any existing context from same widget (overwrite pattern per SEP-1865)
        const filtered = prev.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    []
  );

  const activeElicitation = elicitationQueue[0] ?? null;

  // Elicitation SSE listener
  useEffect(() => {
    if (HOSTED_MODE) {
      return;
    }

    const es = new EventSource(addTokenToUrl("/api/mcp/elicitation/stream"));
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === "elicitation_request") {
          setElicitationQueue((previousQueue) => {
            if (
              previousQueue.some(
                (elicitation) => elicitation.requestId === data.requestId
              )
            ) {
              return previousQueue;
            }

            return [
              ...previousQueue,
              {
                requestId: data.requestId,
                message: data.message,
                schema: data.schema,
                timestamp: data.timestamp || new Date().toISOString(),
              },
            ];
          });
        } else if (data?.type === "elicitation_complete") {
          setElicitationQueue((previousQueue) =>
            previousQueue.filter(
              (elicitation) => elicitation.requestId !== data.requestId
            )
          );
        }
      } catch (error) {
        console.warn("[ChatTabV2] Failed to parse elicitation event:", error);
      }
    };
    es.onerror = () => {
      console.warn(
        "[ChatTabV2] Elicitation SSE connection error, browser will retry"
      );
    };
    return () => es.close();
  }, []);

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, unknown>
  ) => {
    if (!activeElicitation) return;
    setElicitationLoading(true);
    try {
      await authFetch("/api/mcp/elicitation/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: activeElicitation.requestId,
          action,
          content: parameters,
        }),
      });
      setElicitationQueue((previousQueue) =>
        previousQueue.filter(
          (elicitation) => elicitation.requestId !== activeElicitation.requestId
        )
      );
    } finally {
      setElicitationLoading(false);
    }
  };

  // Submit blocking with server check
  const submitBlocked = baseSubmitBlocked;
  const { isStreamingActive, stopActiveChat } = useChatStopControls({
    isMultiModelMode,
    isStreaming,
    multiModelSummaries,
    setStopBroadcastRequestId,
    stop,
  });
  // History rail: any in-flight generation for this tab (matches composer blocking).
  const historyRailStreaming = isStreamingActive;
  const { composerDisabled, sendBlocked } = getChatComposerInteractivity({
    isStreamingActive,
    composerDisabled: submitBlocked || chatboxComposerBlocked,
  });

  let placeholder = minimalMode
    ? MINIMAL_CHAT_COMPOSER_PLACEHOLDER
    : DEFAULT_CHAT_COMPOSER_PLACEHOLDER;
  if (chatboxComposerBlocked && chatboxComposerBlockedReason) {
    placeholder = chatboxComposerBlockedReason;
  } else if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use free chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const showDisabledCallout = !effectiveHasMessages && shouldShowUpsell;

  const errorMessage = formatErrorMessage(error);
  const traceViewerTrace = liveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const resetMultiModelSessions = useCallback(() => {
    clearMultiModelUiState();
    setMultiModelSessionGeneration((previous) => previous + 1);
  }, [clearMultiModelUiState]);

  const handleResetAllChats = useCallback(() => {
    posthog.capture("chat_cleared", standardEventProps("chat_tab"));
    baseResetChat();
    resetMultiModelSessions();
  }, [baseResetChat, posthog, resetMultiModelSessions]);

  const handleSingleModelChange = useCallback(
    (model: ModelDefinition) => {
      setSelectedModel(model);
      setSelectedModelIds([String(model.id)]);
      setMultiModelEnabled(false);
    },
    [setMultiModelEnabled, setSelectedModel, setSelectedModelIds]
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
          String(selectedModelItem.id)
        )
      );
    },
    [selectedModel, setSelectedModel, setSelectedModelIds]
  );

  const handleMultiModelEnabledChange = useCallback(
    (enabled: boolean) => {
      setMultiModelEnabled(enabled);
    },
    [setMultiModelEnabled]
  );

  const handleRequireToolApprovalChange = useCallback(
    (enabled: boolean) => {
      setRequireToolApproval(enabled);
      if (isMultiModelMode) {
        handleResetAllChats();
      }
    },
    [handleResetAllChats, isMultiModelMode, setRequireToolApproval]
  );

  const handleMultiModelSummaryChange = useCallback(
    (summary: MultiModelCardSummary) => {
      setMultiModelSummaries((previous) => ({
        ...previous,
        [summary.modelId]: summary,
      }));
    },
    []
  );

  const handleMultiModelHasMessagesChange = useCallback(
    (modelId: string, hasMessages: boolean) => {
      setMultiModelHasMessages((previous) => ({
        ...previous,
        [modelId]: hasMessages,
      }));
    },
    []
  );

  const queueBroadcastRequest = useCallback(
    (
      request: Omit<BroadcastChatTurnRequest, "id">,
      captureProps?: Record<string, unknown>
    ) => {
      posthog.capture("send_message", {
        location: "chat_tab",
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
    ]
  );

  // Detect OAuth-required errors and notify parent
  useEffect(() => {
    if (!onOAuthRequired || !error) return;
    const msg = error instanceof Error ? error.message : String(error);

    // Try to parse structured error with oauthRequired flag
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.details?.oauthRequired) {
        handleOAuthRequired({
          serverUrl:
            typeof parsed.details.serverUrl === "string"
              ? parsed.details.serverUrl
              : null,
          serverId:
            typeof parsed.details.serverId === "string"
              ? parsed.details.serverId
              : null,
          serverName:
            typeof parsed.details.serverName === "string"
              ? parsed.details.serverName
              : null,
        });
        return;
      }
    } catch {
      // not JSON, check message patterns
    }

    // Match known OAuth error patterns from server
    const isOAuthError =
      msg.includes("requires OAuth authentication") ||
      (msg.includes("Authentication failed") && msg.includes("invalid_token"));
    if (isOAuthError) {
      handleOAuthRequired();
    }
  }, [error, handleOAuthRequired, onOAuthRequired]);

  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hasContent =
      input.trim() ||
      mcpPromptResults.length > 0 ||
      skillResults.length > 0 ||
      fileAttachments.length > 0;
    if (hasContent && !sendBlocked) {
      const threadReady = await ensureThreadReadyForSend();
      if (!threadReady) {
        return;
      }
      // Build messages from MCP prompts
      const promptMessages = buildMcpPromptMessages(
        mcpPromptResults
      ) as UIMessage[];

      // Build messages from skills
      const skillMessages = buildSkillToolMessages(skillResults) as UIMessage[];
      const prependMessages = [...promptMessages, ...skillMessages];

      const files =
        fileAttachments.length > 0
          ? await attachmentsToFileUIParts(fileAttachments)
          : undefined;

      if (isMultiModelMode) {
        queueBroadcastRequest({
          text: input,
          files,
          prependMessages,
        });
      } else {
        if (promptMessages.length > 0) {
          setMessages((prev) => [...prev, ...promptMessages]);
        }

        if (skillMessages.length > 0) {
          setMessages((prev) => [...prev, ...skillMessages]);
        }

        const contextMessages = modelContextQueue.map(
          ({ toolCallId, context }) => ({
            id: `model-context-${toolCallId}-${Date.now()}`,
            role: "user" as const,
            parts: [
              {
                type: "text" as const,
                text: `Widget ${toolCallId} context: ${JSON.stringify(
                  context
                )}`,
              },
            ],
            metadata: {
              source: "widget-model-context",
              toolCallId,
            },
          })
        );

        if (contextMessages.length > 0) {
          setMessages((prev) => [...prev, ...(contextMessages as UIMessage[])]);
        }

        posthog.capture("send_message", {
          location: "chat_tab",
          platform: detectPlatform(),
          environment: detectEnvironment(),
          model_id: selectedModel?.id ?? null,
          model_name: selectedModel?.name ?? null,
          model_provider: selectedModel?.provider ?? null,
          multi_model_enabled: false,
          multi_model_count: 1,
          single_model_send: true,
        });
        sendMessage({ text: input, files });
        setModelContextQueue([]);
      }

      setInput("");
      setMcpPromptResults([]);
      setSkillResults([]);
      revokeFileAttachmentUrls(fileAttachments);
      setFileAttachments([]);
    }
  };

  const handleStarterPrompt = async (prompt: string) => {
    posthog.capture(
      "chat_starter_prompt_clicked",
      standardEventProps("chat_tab")
    );
    if (composerDisabled || sendBlocked) {
      setInput(prompt);
      return;
    }
    const threadReady = await ensureThreadReadyForSend();
    if (!threadReady) {
      return;
    }
    if (isMultiModelMode) {
      queueBroadcastRequest({
        text: prompt,
        prependMessages: [],
      });
    } else {
      posthog.capture("send_message", {
        location: "chat_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
        multi_model_enabled: false,
        multi_model_count: 1,
        single_model_send: true,
      });
      sendMessage({ text: prompt });
    }
    setInput("");
    revokeFileAttachmentUrls(fileAttachments);
    setFileAttachments([]);
  };

  const sharedChatInputProps = {
    value: input,
    onChange: setInput,
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
    submitDisabled: submitBlocked || chatboxComposerBlocked,
    tokenUsage,
    selectedServers: selectedConnectedServerNames,
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    connectedOrConnectingServerConfigs,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
    fileAttachments,
    onChangeFileAttachments: setFileAttachments,
    skillResults,
    onChangeSkillResults: setSkillResults,
    requireToolApproval,
    onRequireToolApprovalChange: handleRequireToolApprovalChange,
    minimalMode,
    showHostStyleSelector,
    hostStyle,
    onHostStyleChange,
    allServerConfigs,
    onServerToggle,
    onReconnectServer,
    onAddServer,
    chatboxAttachableServers:
      chatboxOptionalInventory && chatboxOptionalInventory.length > 0
        ? chatboxOptionalInventory
        : undefined,
    onAttachChatboxServer: onEnableChatboxOptionalServer,
  };

  const showStarterPrompts =
    !showDisabledCallout && !effectiveHasMessages && !isAuthLoading;

  return (
    <div className="flex flex-1 h-full min-h-0 flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 h-full"
      >
        {showHistoryRail && isHistorySidebarVisible ? (
          <>
            <ResizablePanel
              id="chat-history-rail"
              order={1}
              defaultSize={22}
              minSize={15}
              maxSize={35}
              collapsible
              collapsedSize={0}
              onCollapse={() => setIsHistorySidebarVisible(false)}
              className="min-h-0 min-w-0 overflow-hidden"
            >
              <ChatHistoryRail
                activeSessionId={activeHistorySessionId}
                hostStyle={hostStyle}
                isAuthenticated={isConvexAuthenticated}
                isStreaming={historyRailStreaming}
                sharedThreadsEnabled={sharedThreadsEnabled}
                workspaceId={effectiveHostedWorkspaceId}
                enabled={isSessionBootstrapComplete}
                refreshSignal={historyRefreshSignal}
                onSelectThread={handleSelectThread}
                onNewChat={handleNewChat}
                beforeResetChatAfterArchiveAll={ensureDiscardDraftConfirmed}
                onArchiveAllComplete={handleArchiveAllComplete}
                onSessionAction={handleHistorySessionAction}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        ) : showHistoryRail ? (
          <CollapsedPanelStrip
            side="left"
            onOpen={() => setIsHistorySidebarVisible(true)}
            tooltipText="Show sessions"
          />
        ) : null}
        <ResizablePanel
          id="chat-main"
          order={2}
          defaultSize={
            historyRailTakesLayoutSpace
              ? isJsonRpcPanelVisible
                ? 48
                : 78
              : minimalMode
              ? 100
              : isJsonRpcPanelVisible
              ? 70
              : 100
          }
          minSize={40}
          className="min-h-0 min-w-0 overflow-hidden"
        >
          <div className="relative flex flex-col bg-background h-full min-h-0 overflow-hidden">
            {loadingHistorySessionId && (
              <div
                className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 backdrop-blur-sm"
                role="status"
                aria-label="Loading chat"
              >
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            )}
            {isMultiModelLayoutMode ? (
              <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                {showTopTraceViewTabs ? (
                  <ChatTraceViewModeHeaderBar
                    mode={activeTraceViewMode}
                    onModeChange={(mode) => {
                      if (mode === "tools") {
                        return;
                      }
                      setTraceViewMode(mode);
                      setRevealedInChat(false);
                    }}
                  />
                ) : null}

                {!effectiveHasMessages &&
                showLiveTraceDiagnostics &&
                !minimalMode ? (
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
                    rawRequestPayloadHistory={{
                      entries: requestPayloadHistory,
                      hasUiMessages: effectiveHasMessages,
                    }}
                    rawEmptyTestId="chat-live-raw-pending"
                    timelineEmptyTestId="chat-live-trace-pending"
                    onRevealNavigateToChat={() => {
                      setTraceViewMode("chat");
                      setRevealedInChat(true);
                    }}
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
                ) : !effectiveHasMessages ? (
                  minimalMode ? (
                    <div className="flex flex-1 flex-col min-h-0">
                      <div className="flex flex-1 flex-col items-center justify-center px-4">
                        {isAuthLoading ? (
                          <div className="text-center space-y-4">
                            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                            <p className="text-sm text-muted-foreground">
                              Loading...
                            </p>
                          </div>
                        ) : showDisabledCallout ? (
                          <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                        ) : null}
                      </div>

                      {showStarterPrompts && (
                        <div className="flex flex-wrap justify-center gap-2 px-4 pb-4">
                          {STARTER_PROMPTS.map((prompt) => (
                            <button
                              key={prompt.text}
                              type="button"
                              onClick={() => handleStarterPrompt(prompt.text)}
                              className="rounded-full border border-border/40 bg-transparent px-3 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/40 hover:bg-accent cursor-pointer font-light"
                            >
                              {prompt.label}
                            </button>
                          ))}
                        </div>
                      )}

                      <div className="bg-background/80 backdrop-blur-sm border-t border-border shrink-0">
                        {!isAuthLoading && (
                          <div className="max-w-4xl mx-auto p-4">
                            <ChatInput
                              {...sharedChatInputProps}
                              hasMessages={false}
                            />
                          </div>
                        )}
                        <p className="text-center text-xs text-muted-foreground/60 pb-3 -mt-2">
                          AI can make mistakes. Please double-check responses.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <MultiModelStartersEmptyLayout
                      isAuthLoading={isAuthLoading}
                      showStarterPrompts={showStarterPrompts}
                      authPrimarySlot={
                        isAuthLoading ? (
                          <div className="text-center space-y-4">
                            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                            <p className="text-sm text-muted-foreground">
                              Loading...
                            </p>
                          </div>
                        ) : showDisabledCallout ? (
                          <div className="space-y-4">
                            <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                          </div>
                        ) : null
                      }
                      onStarterPrompt={handleStarterPrompt}
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
                    "flex flex-1 min-h-0 flex-col overflow-hidden",
                    !effectiveHasMessages && "hidden"
                  )}
                  aria-hidden={!effectiveHasMessages}
                >
                  <div className="flex min-h-64 flex-1 flex-col overflow-hidden px-4 py-4">
                    <div
                      className={cn(
                        "grid h-full min-h-0 w-full min-w-0 gap-4 auto-rows-[minmax(0,1fr)] [&>*]:min-h-0",
                        resolvedSelectedModels.length <= 1 && "grid-cols-1",
                        resolvedSelectedModels.length === 2 &&
                          "grid-cols-1 xl:grid-cols-2",
                        resolvedSelectedModels.length >= 3 &&
                          "grid-cols-1 xl:grid-cols-3"
                      )}
                    >
                      {resolvedSelectedModels.map((model) => (
                        <MultiModelChatCard
                          key={`${multiModelSessionGeneration}:${String(
                            model.id
                          )}`}
                          model={model}
                          comparisonSummaries={Object.values(
                            multiModelSummaries
                          )}
                          selectedServers={selectedConnectedServerNames}
                          selectedServerInstructions={
                            selectedServerInstructions
                          }
                          broadcastRequest={broadcastRequest}
                          stopRequestId={stopBroadcastRequestId}
                          placeholder={placeholder}
                          reasoningDisplayMode={reasoningDisplayMode}
                          executionConfig={{
                            systemPrompt,
                            temperature,
                            requireToolApproval,
                          }}
                          hostedContext={{
                            ...hostedContext,
                            workspaceId: effectiveHostedWorkspaceId,
                            selectedServerIds: effectiveHostedSelectedServerIds,
                            oauthTokens: effectiveHostedOAuthTokens,
                          }}
                          onOAuthRequired={handleOAuthRequired}
                          onSummaryChange={handleMultiModelSummaryChange}
                          onHasMessagesChange={
                            handleMultiModelHasMessagesChange
                          }
                          showComparisonChrome={
                            resolvedSelectedModels.length > 1
                          }
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

                  <div className="border-t border-border bg-background/80 backdrop-blur-sm">
                    {!isAuthLoading ? (
                      <div className="w-full p-4">
                        <ChatInput
                          {...sharedChatInputProps}
                          hasMessages={effectiveHasMessages}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <>
                {showTopTraceViewTabs ? (
                  <ChatTraceViewModeHeaderBar
                    mode={activeTraceViewMode}
                    onModeChange={(mode) => {
                      if (mode === "tools") {
                        return;
                      }
                      setTraceViewMode(mode);
                      setRevealedInChat(false);
                    }}
                  />
                ) : null}

                {(showLiveTraceDiagnostics || revealedInChat) &&
                  !minimalMode && (
                    <div className="flex flex-1 min-h-0 flex-col">
                      <SingleModelTraceDiagnosticsBody
                        activeTraceViewMode={activeTraceViewMode}
                        isThreadEmpty={isThreadEmpty}
                        showLiveTracePending={
                          activeTraceViewMode === "timeline" &&
                          !hasLiveTimelineContent
                        }
                        trace={traceViewerTrace}
                        model={selectedModel}
                        toolsMetadata={toolsMetadata}
                        toolServerMap={toolServerMap}
                        traceStartedAtMs={
                          liveTraceEnvelope?.traceStartedAtMs ?? null
                        }
                        traceEndedAtMs={
                          liveTraceEnvelope?.traceEndedAtMs ?? null
                        }
                        onRevealNavigateToChat={() => {
                          setTraceViewMode("chat");
                          setRevealedInChat(true);
                        }}
                        sendFollowUpMessage={
                          activeTraceViewMode === "chat" && revealedInChat
                            ? handleSendFollowUp
                            : undefined
                        }
                        onFullscreenChange={setIsWidgetFullscreen}
                        rawRequestPayloadHistory={{
                          entries: requestPayloadHistory,
                          hasUiMessages: !isThreadEmpty,
                        }}
                        rawEmptyTestId="chat-live-raw-pending"
                        timelineEmptyTestId="chat-live-trace-pending"
                      />

                      <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
                        {errorMessage && (
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
                              onResetChat={baseResetChat}
                            />
                          </div>
                        )}
                        <div className="max-w-4xl mx-auto p-4">
                          <ChatInput
                            {...sharedChatInputProps}
                            hasMessages={!isThreadEmpty}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                {!isThreadEmpty && (
                  <StickToBottom
                    className="relative flex flex-1 flex-col min-h-0 animate-in fade-in duration-300"
                    style={
                      showLiveTraceDiagnostics || revealedInChat
                        ? { display: "none" }
                        : undefined
                    }
                    resize="smooth"
                    initial="smooth"
                  >
                    <div className="relative flex-1 min-h-0">
                      <StickToBottom.Content className="flex flex-col min-h-0">
                        <Thread
                          messages={messages}
                          sendFollowUpMessage={(text: string) =>
                            sendMessage({ text })
                          }
                          model={selectedModel}
                          isLoading={isStreaming}
                          toolsMetadata={toolsMetadata}
                          toolServerMap={toolServerMap}
                          onWidgetStateChange={handleWidgetStateChange}
                          onModelContextUpdate={handleModelContextUpdate}
                          onFullscreenChange={setIsWidgetFullscreen}
                          enableFullscreenChatOverlay
                          fullscreenChatPlaceholder={placeholder}
                          fullscreenChatDisabled={composerDisabled}
                          fullscreenChatSendBlocked={sendBlocked}
                          onFullscreenChatStop={stopActiveChat}
                          onToolApprovalResponse={addToolApprovalResponse}
                          toolRenderOverrides={restoredToolRenderOverrides}
                          minimalMode={minimalMode}
                          loadingIndicatorVariant={loadingIndicatorVariant}
                          reasoningDisplayMode={reasoningDisplayMode}
                        />
                      </StickToBottom.Content>
                      <ScrollToBottomButton />
                    </div>

                    <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
                      {errorMessage && (
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
                            onResetChat={baseResetChat}
                          />
                        </div>
                      )}
                      <div className="max-w-4xl mx-auto p-4">
                        <ChatInput {...sharedChatInputProps} hasMessages />
                      </div>
                      {minimalMode && (
                        <p className="text-center text-xs text-muted-foreground/60 pb-3 -mt-2">
                          AI can make mistakes. Please double-check responses.
                        </p>
                      )}
                    </div>
                  </StickToBottom>
                )}

                {isThreadEmpty &&
                  !showLiveTraceDiagnostics &&
                  !revealedInChat &&
                  (minimalMode ? (
                    <div
                      className="flex flex-1 min-h-0 flex-col overflow-hidden"
                      data-empty-layout="minimal"
                      data-testid="chat-empty-state-shell"
                    >
                      <div
                        className="flex min-h-0 flex-1 flex-col overflow-hidden"
                        data-testid="chat-empty-state-body"
                      >
                        <div
                          className="flex min-h-0 flex-1 flex-col overflow-hidden"
                          data-testid="chat-empty-state-content"
                        >
                          <div className="flex flex-1 flex-col items-center justify-center px-4">
                            {isAuthLoading ? (
                              <div className="text-center space-y-4">
                                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                                <p className="text-sm text-muted-foreground">
                                  Loading...
                                </p>
                              </div>
                            ) : showDisabledCallout ? (
                              <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                            ) : null}
                          </div>

                          {showStarterPrompts && (
                            <div className="flex flex-wrap justify-center gap-2 px-4 pb-4">
                              {STARTER_PROMPTS.map((prompt) => (
                                <button
                                  key={prompt.text}
                                  type="button"
                                  onClick={() =>
                                    handleStarterPrompt(prompt.text)
                                  }
                                  className="rounded-full border border-border/40 bg-transparent px-3 py-1.5 text-xs text-muted-foreground transition hover:border-foreground/40 hover:bg-accent cursor-pointer font-light"
                                >
                                  {prompt.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <div
                        className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0"
                        data-testid="chat-empty-state-footer"
                      >
                        {!isAuthLoading && (
                          <div className="max-w-4xl mx-auto p-4">
                            <ChatInput
                              {...sharedChatInputProps}
                              hasMessages={false}
                            />
                          </div>
                        )}
                        <p className="text-center text-xs text-muted-foreground/60 pb-3 -mt-2">
                          AI can make mistakes. Please double-check responses.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="flex flex-1 min-h-0 overflow-hidden"
                      data-empty-layout="standard"
                      data-testid="chat-empty-state-shell"
                    >
                      <div
                        className="flex h-full min-h-0 flex-1 items-center justify-center px-4"
                        data-testid="chat-empty-state-body"
                      >
                        <div className="min-h-0 max-h-full w-full max-w-3xl shrink space-y-6 overflow-y-auto overscroll-contain py-8">
                          {isAuthLoading ? (
                            <div className="text-center space-y-4">
                              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                              <p className="text-sm text-muted-foreground">
                                Loading...
                              </p>
                            </div>
                          ) : showDisabledCallout ? (
                            <div className="space-y-4">
                              <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                            </div>
                          ) : null}

                          <div className="space-y-4">
                            {showStarterPrompts && (
                              <div className="text-center">
                                <p className="text-sm text-muted-foreground mb-3">
                                  Try one of these to get started
                                </p>
                                <div className="flex flex-wrap justify-center gap-2">
                                  {STARTER_PROMPTS.map((prompt) => (
                                    <button
                                      key={prompt.text}
                                      type="button"
                                      onClick={() =>
                                        handleStarterPrompt(prompt.text)
                                      }
                                      className="rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground transition hover:border-foreground hover:bg-accent cursor-pointer font-light"
                                    >
                                      {prompt.label}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {!isAuthLoading && (
                              <ChatInput
                                {...sharedChatInputProps}
                                hasMessages={false}
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
              </>
            )}

            <ElicitationDialog
              elicitationRequest={activeElicitation}
              onResponse={handleElicitationResponse}
              loading={elicitationLoading}
            />
          </div>
        </ResizablePanel>

        {!minimalMode && isJsonRpcPanelVisible ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              id="chat-json-rpc-logger"
              order={3}
              defaultSize={30}
              minSize={4}
              maxSize={50}
              collapsible={true}
              collapsedSize={0}
              onCollapse={toggleJsonRpcPanel}
              className="min-h-0 overflow-hidden"
            >
              <div className="h-full min-h-0 overflow-hidden">
                <LoggerView onClose={toggleJsonRpcPanel} />
              </div>
            </ResizablePanel>
          </>
        ) : minimalMode ? null : (
          <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
        )}
      </ResizablePanelGroup>
      <AlertDialog
        open={discardDraftDialogOpen}
        onOpenChange={(open) => {
          setDiscardDraftDialogOpen(open);
          if (!open && !discardDraftSettledRef.current) {
            discardDraftSettledRef.current = true;
            const resolve = discardDraftResolveRef.current;
            discardDraftResolveRef.current = null;
            resolve?.(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Your chat has text that has not been sent. Discard your current
              draft and continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={(event) => {
                event.preventDefault();
                settleDiscardDraft(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                settleDiscardDraft(true);
              }}
            >
              Discard and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
