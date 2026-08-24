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
import { useConvexAuth, useQuery } from "convex/react";
import {
  canManageOrgCredits,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { toast } from "@/lib/toast";
import { ModelDefinition } from "@/shared/types";
import { LoggerView } from "./logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import { MrtrElicitationHost } from "@/components/elicitation/MrtrElicitationHost";
import { HostedMrtrHost } from "@/components/elicitation/HostedMrtrHost";
import {
  ElicitationRequestDialog,
  UrlElicitationRequiredDialog,
} from "@/components/elicitation/ElicitationRequestDialog";
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
import { SaveAsTestCaseAction } from "@/components/chat-v2/shared/save-as-test-case-action";
import { type ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import { ServerWithName } from "@/hooks/use-app-state";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { track } from "@/lib/analytics";
import { useAppNavigate } from "@/lib/app-navigation";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";
import { CreditTopupDialog } from "@/components/billing/CreditTopupDialog";
import { TopupGatedErrorBox } from "@/components/billing/TopupGatedErrorBox";
import { useCreditTopupReturnFlow } from "@/hooks/useCreditTopupReturnFlow";
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
  extractUserMessageText,
  UPSTREAM_ERROR_PAGE_CODE,
  PROTOCOL_VERSION_PIN_CODE,
} from "@/components/chat-v2/shared/chat-helpers";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import { MultiModelStartersEmptyLayout } from "@/components/chat-v2/multi-model-starters-empty";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { useChatSession } from "@/hooks/use-chat-session";
import {
  DETACH_FORK_FAILED_MESSAGE,
  type ChatSessionResetReason,
} from "@/hooks/use-chat-session";
import {
  RESUMED_THREAD_CONFLICT_MESSAGE,
  RESUMED_THREAD_UNSAVED_MESSAGE,
  useResumedThreadPersistence,
} from "@/hooks/use-resumed-thread-persistence";
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
import { useProjectServers } from "@/hooks/useViews";
import { useProjectMembers } from "@/hooks/useProjects";
import { buildProjectOwnerProfileByUserId } from "@/components/chat-v2/history/project-thread-owner-avatar";
import { buildSenderAvatarResolver } from "@/components/chat-v2/shared/sender-avatar";
import { HOSTED_MODE } from "@/lib/config";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import { gateMcpToolResultImageRenderingByModelVisibility } from "@/lib/client-config-v2";
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
import type { ScenarioHostStyle } from "@/lib/scenario-client-style";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import { upsertWidgetModelContextEntry } from "@/lib/widget-model-context";
import { buildAssistantPromptIndex } from "@/components/chat-v2/turn-ordinals";

interface ChatTabProps {
  connectedOrConnectingServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
  /** All project servers (for the "+" dropdown server toggles). */
  allServerConfigs?: Record<string, ServerWithName>;
  /** Toggle a server on/off for multi-select. */
  onServerToggle?: (serverName: string) => void;
  /** Reconnect a disconnected server. */
  onReconnectServer?: (serverName: string) => Promise<void>;
  /** Disconnect a connected server (toggle off = unplug). */
  onDisconnectServer?: (serverName: string) => void;
  /** Add a new server (opens add-server modal). */
  onAddServer?: (formData: import("@/shared/types").ServerFormData) => void;
  onSelectedServerNamesChange?: (names: string[]) => void;
  onHasMessagesChange?: (hasMessages: boolean) => void;
  enableMultiModelChat?: boolean;
  minimalMode?: boolean;
  showContextPopover?: boolean;
  hostedContext?: HostedRuntimeContext;
  executionConfig?: ExecutionConfig;
  reasoningDisplayMode?: ReasoningDisplayMode;
  showHostStyleSelector?: boolean;
  hostStyle?: ScenarioHostStyle;
  onHostStyleChange?: (hostStyle: ScenarioHostStyle) => void;
  onOAuthRequired?: (details?: HostedOAuthRequiredDetails) => void;
  /** When true, blocks sending until scenario onboarding/OAuth completes. */
  scenarioComposerBlocked?: boolean;
  scenarioComposerBlockedReason?: string;
  /** Optional (off-by-default) servers the tester can attach from minimal chat. */
  scenarioOptionalInventory?: Array<{
    serverId: string;
    serverName: string;
    useOAuth: boolean;
  }>;
  onEnableScenarioOptionalServer?: (serverId: string) => void;
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
  /**
   * Slot under each assistant message — the per-turn rating widget on the
   * hosted User Testing page.
   *
   * The host gets the turn's identity resolved for it. `turnId` is minted
   * SERVER-side (`generateLiveTraceTurnId`) and reaches the client through
   * `turn_start` trace events (live) or the persisted `turnTraces` (rehydrated
   * sessions), so it is the same id the backend recorded — which is what lets
   * `sessionScores:submitScore` validate the anchor instead of trusting an
   * ordinal. It is `null` until that event lands; the host renders nothing in
   * that window rather than offering a rating that cannot be saved.
   */
  renderAssistantTurnActions?: (ctx: {
    message: UIMessage;
    chatSessionId: string;
    promptIndex: number;
    turnId: string | null;
  }) => React.ReactNode;
}

type ChatTraceViewMode = "chat" | "timeline" | "raw";

export function ChatTabV2({
  connectedOrConnectingServerConfigs,
  selectedServerNames,
  allServerConfigs,
  onServerToggle,
  onReconnectServer,
  onDisconnectServer,
  onAddServer,
  onSelectedServerNamesChange,
  onHasMessagesChange,
  enableMultiModelChat = false,
  minimalMode = false,
  showContextPopover,
  hostedContext,
  executionConfig,
  reasoningDisplayMode = "inline",
  showHostStyleSelector = false,
  hostStyle,
  onHostStyleChange,
  onOAuthRequired,
  scenarioComposerBlocked = false,
  scenarioComposerBlockedReason,
  scenarioOptionalInventory,
  onEnableScenarioOptionalServer,
  evalChatHandoff,
  onEvalChatHandoffConsumed,
  renderAssistantTurnActions,
}: ChatTabProps) {
  const { signUp } = useAuth();
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const appState = useSharedAppState();
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const effectiveMcpToolResultImageRendering = useMemo(
    () =>
      gateMcpToolResultImageRenderingByModelVisibility(
        executionConfig?.mcpToolResultImageRendering,
        executionConfig?.modelVisibleMcpToolResults
      ),
    [
      executionConfig?.mcpToolResultImageRendering,
      executionConfig?.modelVisibleMcpToolResults,
    ]
  );

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
    WidgetModelContextEntry[]
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
  // Cached thread-owner userId so sender-avatar resolution doesn't flash the
  // current user's avatar before the reactive Convex subscription lands.
  const [loadedThreadOwnerUserId, setLoadedThreadOwnerUserId] = useState<
    string | null
  >(null);
  const [loadingHistorySessionId, setLoadingHistorySessionId] = useState<
    string | null
  >(null);
  const [pendingDirectVisibility, setPendingDirectVisibility] = useState<
    "private" | "project"
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
    setLoadedThreadOwnerUserId(null);
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
  const activeProject = appState.projects[appState.activeProjectId];
  const convexProjectId = activeProject?.sharedProjectId ?? null;
  const organizationId = activeProject?.organizationId ?? null;
  // Only owners/admins/creators may buy credits (mirrors the backend gate).
  // Non-managers see an "ask org admin" hint instead of the buy button.
  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated: isConvexAuthenticated,
  });
  const canManageOrgCreditsForActiveOrg = canManageOrgCredits(
    organizationId
      ? sortedOrganizations.find((org) => org._id === organizationId)
      : null
  );
  const navigate = useAppNavigate();
  const hostedScenarioId = hostedContext?.scenarioId;
  const hostedAccessVersion = hostedContext?.accessVersion;
  const hostedScenarioSurface = hostedContext?.scenarioSurface;
  const effectiveHostedProjectId = hostedContext?.projectId ?? convexProjectId;
  const modelConfigOrganizationId = hostedContext?.projectId
    ? null
    : organizationId;
  // The model picker's "Your providers" footer points at the org whose keys back
  // this chat, so hosted surfaces (no org page to reach) get no footer.
  const manageOrgProviders = useOrgModelsHandoff(modelConfigOrganizationId);
  const hostedOrgModelConfig = useHostedOrgModelConfig({
    projectId: effectiveHostedProjectId,
    organizationId: modelConfigOrganizationId,
    // Scenario surfaces resolve their model from the scenario row
    // (executionConfig.modelId), and share-link guests aren't members of the
    // host's project — so the project-scoped config query would throw and crash
    // the page. Skip it whenever we're inside a scenario.
    disabled: Boolean(hostedScenarioId),
  });
  const { serversById, serversByName } = useProjectServers({
    isAuthenticated: isConvexAuthenticated,
    projectId: convexProjectId,
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
  const effectiveHostedSelectedServerIds =
    hostedContext?.selectedServerIds ?? hostedSelectedServerIds;
  const effectiveHostedOAuthTokens = hostedScenarioId
    ? undefined
    : hostedContext?.oauthTokens ?? hostedOAuthTokens;
  const isHostedDirectGuest =
    HOSTED_MODE &&
    !isConvexAuthenticated &&
    !effectiveHostedProjectId &&
    !hostedScenarioId;

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
    isSelectedModelResolved,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
    availableModels,
    authHeaders,
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
    mcpToolsTokenCountErrors,
    mcpToolsTokenCountLoading,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,
    resetChat: baseResetChat,
    startChatWithMessages,
    detachToLocalFork,
    consumePersistReceipt,
    consumeTurnAborted,
    loadChatSession,
    rewindToMessage,
    syncResumedVersion,
    resumedVersion,
    restoredToolRenderOverrides,
    liveTraceEnvelope,
    requestPayloadHistory,
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    disableForAuthentication,
    submitBlocked: baseSubmitBlocked,
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse,
    pendingElicitations,
    respondToElicitation,
    elicitationResponding,
    urlElicitationRequired,
    dismissUrlElicitationRequired,
  } = useChatSession({
    selectedServers: selectedConnectedServerNames,
    directVisibility: pendingDirectVisibility,
    hostedOrgModelConfig,
    hostedContext: {
      ...hostedContext,
      projectId: effectiveHostedProjectId,
      selectedServerIds: effectiveHostedSelectedServerIds,
      oauthTokens: effectiveHostedOAuthTokens,
    },
    executionConfig,
    // Phase 3: forward the resolved chat-tab host style so direct
    // chat traces persist with `claude`/`chatgpt` rather than
    // defaulting to `'claude'` regardless of user choice. Backend
    // ingestion ignores it for scenario flows (those resolve from the
    // scenario row), so it's safe to forward unconditionally.
    hostStyle:
      hostStyle === "claude" || hostStyle === "chatgpt" ? hostStyle : undefined,
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
  const showHistoryRail = Boolean(
    HOSTED_MODE && !minimalMode && !hostedScenarioId
  );
  const {
    session: reactiveHistorySession,
    widgetSnapshots: reactiveHistoryWidgetSnapshots,
  } = useDirectChatSessionSubscription({
    sessionId: activeHistorySessionId,
    projectId: effectiveHostedProjectId,
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

  // Shared-session sender attribution: only relevant when the active thread
  // is project-visible. Members are loaded for authenticated users with a
  // projectId; otherwise the resolver still works (returns "generic"), but
  // `showSenderAvatars` is gated on `directVisibility === "project"` so
  // private sessions stay visually identical to today.
  const { activeMembers: senderActiveMembers } = useProjectMembers({
    isAuthenticated: isConvexAuthenticated,
    projectId: convexProjectId ?? null,
  });
  const senderProfileByUserId = useMemo(
    () => buildProjectOwnerProfileByUserId(senderActiveMembers),
    [senderActiveMembers]
  );
  const currentUserForSender = useQuery(
    "users:getCurrentUser" as any,
    isConvexAuthenticated ? ({} as any) : "skip"
  ) as { _id?: string } | undefined;
  const senderFallbackUserId =
    reactiveHistorySession?.userId ??
    loadedThreadOwnerUserId ??
    currentUserForSender?._id ??
    null;
  const showSenderAvatars = pendingDirectVisibility === "project";
  const resolveSenderAvatar = useMemo(
    () =>
      buildSenderAvatarResolver({
        profileByUserId: senderProfileByUserId,
        fallbackOwnerUserId: senderFallbackUserId,
      }),
    [senderProfileByUserId, senderFallbackUserId]
  );
  // Stamp the current user onto live outgoing prompts in shared sessions so
  // the transcript can attribute them immediately, before persistence
  // round-trips Convex. Private sessions skip the field entirely.
  const outgoingSenderMetadata = useMemo<
    Record<string, unknown> | undefined
  >(() => {
    if (!showSenderAvatars) return undefined;
    const id = currentUserForSender?._id;
    if (!id) return undefined;
    return { senderUserId: id };
  }, [showSenderAvatars, currentUserForSender?._id]);
  const hasConversationMessages = messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant"
  );

  // Map UIMessage.id -> promptIndex (0-based ordinal among role: "user"
  // messages). Matches the `promptIndex` the backend records on
  // `chatSessionTurnTraces` and uses to anchor a turn inside the persisted
  // ModelMessage[] transcript blob (which carries no per-message ids).
  const userPromptIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let userOrdinal = 0;
    for (const msg of messages) {
      if (msg.role === "user") {
        map.set(msg.id, userOrdinal);
        userOrdinal += 1;
      }
    }
    return map;
  }, [messages]);

  // The same ordinal addressed from the ASSISTANT side — see
  // `buildAssistantPromptIndex` for why the counting rule is the server's, not
  // the renderer's.
  const assistantPromptIndexById = useMemo(
    () => buildAssistantPromptIndex(messages),
    [messages]
  );

  // promptIndex → server-minted turnId. Live turns arrive via `turn_start`
  // trace events; rehydrated sessions get theirs from the persisted
  // `turnTraces`. Either way the id is the backend's, never the client's.
  const turnIdByPromptIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const turn of liveTraceEnvelope?.turns ?? []) {
      map.set(turn.promptIndex, turn.turnId);
    }
    return map;
  }, [liveTraceEnvelope]);

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
      setLoadedThreadOwnerUserId(null);

      if (!hasConversationMessages) {
        // Nothing to fork — with no transcript there is no snapshot that could
        // be written back over the old row, so dropping the guard is enough.
        syncResumedVersion(null);
        toast.error(toastMessage);
        return;
      }

      // Verified rather than fire-and-forget: the reassuring toast may only be
      // shown once the fork is confirmed live. `resumedVersion` is cleared by
      // the fork's own hydration, so it survives a fork that never commits.
      void detachToLocalFork(cloneUiMessages(messages), {
        toolRenderOverrides: restoredToolRenderOverrides,
      })
        .then((fork) => {
          toast.error(fork ? toastMessage : DETACH_FORK_FAILED_MESSAGE);
        })
        .catch((error) => {
          // `void` silences the linter, not the rejection. The guard teardown
          // above has already run, so swallowing this would leave the user on a
          // thread they must not write to with no notice at all.
          console.error(
            "[ChatTabV2] Failed to fork the detached thread",
            error
          );
          toast.error(DETACH_FORK_FAILED_MESSAGE);
        });
    },
    [
      hasConversationMessages,
      messages,
      restoredToolRenderOverrides,
      detachToLocalFork,
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
      setLoadedThreadOwnerUserId(detail.userId ?? null);
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
            projectId: effectiveHostedProjectId ?? undefined,
          });
          setActiveHistorySessionId(detail.session._id);
          setLoadedThreadOwnerUserId(detail.session.userId ?? null);
          setPendingDirectVisibility(detail.session.directVisibility);
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
      effectiveHostedProjectId,
      hasConversationMessages,
      markHistorySessionRead,
      showHistoryRail,
      syncResumedVersion,
    ]
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
          projectId: effectiveHostedProjectId ?? undefined,
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
      effectiveHostedProjectId,
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

  const clearMultiModelUiState = useCallback(() => {
    setBroadcastRequest(null);
    setStopBroadcastRequestId(0);
    setMultiModelSummaries({});
    setMultiModelHasMessages({});
    setMultiAddColumnSeeds({});
    prevCompareModelIdsRef.current = new Set();
  }, []);

  const resetMultiModelSessions = useCallback(() => {
    clearMultiModelUiState();
    setMultiModelSessionGeneration((previous) => previous + 1);
  }, [clearMultiModelUiState]);

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
      // Compare lanes hold their own useChatSession state; resetting the
      // root session alone leaves the visible lane transcripts intact and
      // the user sees nothing happen after clicking "+" in the rail.
      resetMultiModelSessions();
      setPendingDirectVisibility(options?.shared ? "project" : "private");
    },
    [
      baseResetChat,
      cancelPendingHistorySelection,
      clearComposerDraft,
      ensureDiscardDraftConfirmed,
      hasUnsavedDraft,
      isStreaming,
      resetMultiModelSessions,
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
      resetMultiModelSessions();
      setPendingDirectVisibility("private");
    },
    [
      baseResetChat,
      cancelPendingHistorySelection,
      clearComposerDraft,
      hasUnsavedDraft,
      resetMultiModelSessions,
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
      if (
        (action === "share" || action === "unshare") &&
        session._id === activeHistorySessionId
      ) {
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

  useResumedThreadPersistence({
    sendBaselineRef: resumedThreadSendBaselineRef,
    enabled: showHistoryRail,
    status,
    activeHistorySessionId,
    resumedVersion,
    consumePersistReceipt,
    consumeTurnAborted,
    reactiveSessionVersion: reactiveHistorySession?.version,
    syncResumedVersion,
    markHistorySessionRead: (sessionId) => {
      void markHistorySessionRead(sessionId);
    },
    refreshAfterStream: () => {
      void refreshCurrentHistorySession({ markRead: true }).catch((error) => {
        console.error("[ChatTabV2] Failed to refresh chat history", error);
      });
    },
    onConflict: () => {
      detachHistorySession(RESUMED_THREAD_CONFLICT_MESSAGE);
    },
    onUnsaved: () => {
      toast.error(RESUMED_THREAD_UNSAVED_MESSAGE);
    },
  });

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
  // Shared (project-visible) sessions are collaborative artifacts; the
  // multi-model toggle would mutate session state for every collaborator,
  // so it's hidden in that scope. Single-model selection stays available.
  const canEnableMultiModel =
    enableMultiModelChat &&
    !minimalMode &&
    !executionConfig?.modelId &&
    !hostedScenarioId &&
    !hostedScenarioSurface &&
    pendingDirectVisibility !== "project" &&
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
    // `selectedModel` is a derived fallback until the persisted id resolves
    // against `availableModels` — which it can't while an org-managed
    // provider config is still loading. Mirroring the fallback into storage
    // here is what wiped the user's own-provider model on every load, so
    // they landed back on the free tier (and, out of credits, back in the
    // BYOK hand-off) chat after chat. See BACK2-628.
    //
    // This has to gate the multi-model reset below too, not just the
    // sanitize: that branch also ends in `setSelectedModelIds`, which
    // persists the lead id (`use-persisted-model.ts:150-159`). And it is the
    // branch that actually fires here — `multiModelEnabled` is stored under
    // one global key, so a user who turned compare on in the Playground
    // arrives on every other surface with it already true while
    // `canEnableMultiModel` is false. Deferring is safe: the reset is
    // idempotent and `isSelectedModelResolved` is in the deps, so it runs on
    // the render after the selection lands.
    if (!isSelectedModelResolved) {
      return;
    }

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
    isSelectedModelResolved,
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

    const { executionConfig: handoffExec } = evalChatHandoff;
    let matchingModel = null;
    if (handoffExec.modelId) {
      matchingModel = availableModels.find(
        (model) => String(model.id) === handoffExec.modelId
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

    const seedApplied = startChatWithMessages(evalChatHandoff.messages);
    appliedEvalChatHandoffIdRef.current = evalChatHandoff.id;

    // A widget in the eval preview fired a `ui/message` follow-up: send it once
    // the seeded conversation is applied, so the playground replies live just
    // like chat would. Chained on the hydration promise to avoid sending into
    // a not-yet-hydrated thread.
    const pendingUserMessage = evalChatHandoff.pendingUserMessage;
    if (pendingUserMessage) {
      void seedApplied.then(() => {
        sendMessage({
          text: pendingUserMessage,
          metadata: outgoingSenderMetadata,
        });
      });
    }

    if (typeof handoffExec.systemPrompt === "string") {
      setSystemPrompt(handoffExec.systemPrompt);
    }

    if (typeof handoffExec.temperature === "number") {
      setTemperature(handoffExec.temperature);
    }

    if (typeof handoffExec.requireToolApproval === "boolean") {
      setRequireToolApproval(handoffExec.requireToolApproval);
    }

    setInput("");
    onEvalChatHandoffConsumed?.(evalChatHandoff.id);
  }, [
    availableModels,
    evalChatHandoff,
    isSessionBootstrapComplete,
    onEvalChatHandoffConsumed,
    outgoingSenderMetadata,
    selectedModel,
    sendMessage,
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
    track("chat_tab_viewed", {
      location: "chat_tab",
    });
  }, []);

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
      setModelContextQueue((previous) =>
        upsertWidgetModelContextEntry(previous, toolCallId, context)
      );
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
                // Legacy server→client `elicitation/create`; modern
                // `input_required` input is handled by `MrtrElicitationHost`.
                origin: "legacy-request" as const,
                // Spec: make it clear WHICH server is asking. Local chat can
                // have many servers connected at once, so an anonymous dialog
                // is a real ambiguity. No display name exists on this path —
                // the id is the trusted anchor and is what the dialog shows.
                ...(typeof data.serverId === "string"
                  ? { serverId: data.serverId }
                  : {}),
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
    // Chat tab doesn't have a multi-host axis — its compare mode is
    // exactly multi-model. Pass through directly.
    isCompareMode: isMultiModelMode,
    isStreaming,
    multiModelSummaries,
    setStopBroadcastRequestId,
    stop,
  });
  // History rail: any in-flight generation for this tab (matches composer blocking).
  const historyRailStreaming = isStreamingActive;
  const { composerDisabled, sendBlocked } = getChatComposerInteractivity({
    isStreamingActive,
    composerDisabled: submitBlocked || scenarioComposerBlocked,
  });

  let placeholder = minimalMode
    ? MINIMAL_CHAT_COMPOSER_PLACEHOLDER
    : DEFAULT_CHAT_COMPOSER_PLACEHOLDER;
  if (scenarioComposerBlocked && scenarioComposerBlockedReason) {
    placeholder = scenarioComposerBlockedReason;
  } else if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use free chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const showDisabledCallout = !effectiveHasMessages && shouldShowUpsell;

  const errorMessage = formatErrorMessage(error);

  const [isTopupDialogOpen, setIsTopupDialogOpen] = useState(false);
  const [pendingResendMessage, setPendingResendMessage] = useState("");

  // Capture the most-recent user-typed message text at the moment it's
  // sent, not by walking `messages` later. This avoids any per-render
  // work in the chat hot path — the value is only updated in event
  // handlers (which run after commit), so it's safe to read in the
  // click handler below.
  const lastSentUserMessageRef = useRef("");

  const canShowTopupCta =
    isConvexAuthenticated &&
    errorMessage?.canTopUp === true &&
    errorMessage?.code === "user_rate_limit";

  const handleOpenTopupDialog = useCallback(() => {
    const text = lastSentUserMessageRef.current;
    if (!text) {
      // Nothing to resend — no-op rather than opening a dialog that
      // would carry an empty message into checkout.
      return;
    }
    track("credit_topup_cta_clicked", {
      location: "chat_tab",
      source: "chat_banner",
    });
    setPendingResendMessage(text);
    setIsTopupDialogOpen(true);
  }, []);

  const handleTopupDialogOpenChange = useCallback((open: boolean) => {
    setIsTopupDialogOpen(open);
    if (!open) {
      // Clear the snapshot when the dialog closes so we don't keep a
      // stale message lingering in state until the next click.
      setPendingResendMessage("");
    }
  }, []);

  // Transient-failure retry: re-submit the user's last typed message via the
  // same source-tracking ref the topup CTA uses. The retry button only ever
  // surfaces on failures where resending is the whole fix (see the
  // `canRetryLastMessage` gate below), so we don't risk firing this on
  // unrelated retryable errors.
  const handleRetryLastMessage = useCallback(() => {
    const text = lastSentUserMessageRef.current;
    if (!text) return;
    sendMessage({ text, metadata: outgoingSenderMetadata });
  }, [sendMessage, outgoingSenderMetadata]);

  // Rewind to a past user message and re-run the turn from edited text. The
  // thread BRANCHES — `rewindToMessage` seeds a fresh session with the prefix,
  // so the original transcript survives in history.
  //
  // Readiness is checked BEFORE the branch is minted: a branch that never
  // sends would leave an empty orphan thread behind.
  const handleEditUserMessage = useCallback(
    async (message: UIMessage, text: string) => {
      if (sendBlocked) return false;
      // A rewind ends in `onReset("fork")`, which wipes the composer: input,
      // attachments, prompt/skill results, both queues. `handleNewChat` and
      // `handleSelectThread` ask before doing that; editing has to ask too, or
      // a typed-but-unsent draft disappears the moment the user clicks the
      // pencil on an older message.
      //
      // Asked BEFORE `ensureThreadReadyForSend` so a declined discard costs no
      // network round trip. Deliberately no `clearComposerDraft()` here: the
      // rewind can still be refused below, and `onReset` only fires when one
      // actually happens — clearing eagerly would wipe the draft for an edit
      // that never sent.
      if (!(await ensureDiscardDraftConfirmed())) return false;
      // Snapshot what this edit is aimed at. Both awaits above yield — the
      // discard dialog waits on a human, `ensureThreadReadyForSend` on a
      // network round trip — and the user can pick a different history thread
      // in either gap. The three detach lines below are unconditional, so
      // without this they would detach the NEWLY selected thread, which this
      // edit has nothing to do with.
      //
      // Keyed on the SELECTION counter, not on `activeHistorySessionId`:
      // `refreshCurrentHistorySession` legitimately calls
      // `setActiveHistorySessionId` as part of the preflight, so comparing the
      // id would abort every edit on a resumed thread. The counter moves only
      // on deliberate selection changes (`handleSelectThread`,
      // `cancelPendingHistorySelection`, and so New Chat through it).
      const editSelectionId = historySelectionRequestIdRef.current;
      const threadReady = await ensureThreadReadyForSend();
      if (!threadReady) return false;
      if (historySelectionRequestIdRef.current !== editSelectionId)
        return false;
      // Editing revises the prompt text; the original attachments ride along.
      const files = (message.parts ?? []).filter(
        (part): part is Extract<UIMessage["parts"][number], { type: "file" }> =>
          part.type === "file"
      );
      // Same exposure as the Playground handler: the branch mint inside
      // `rewindToMessage` can reject, and `UserMessageRow.submitEdit` calls
      // this fire-and-forget, so the rejection would go unhandled with the
      // editor already closed.
      let outcome: Awaited<ReturnType<typeof rewindToMessage>>;
      try {
        outcome = await rewindToMessage({
          messageId: message.id,
          text,
          files: files.length > 0 ? files : undefined,
          metadata: outgoingSenderMetadata,
          // Detach from the resumed thread as the branch is minted, not before
          // the rewind. The teardown has to precede the branch's turn — the
          // post-stream conflict check captures its baseline the instant that
          // turn starts, and still attached it would name the ORIGINAL thread,
          // surfacing the deliberate branch as a phantom "this chat changed
          // elsewhere" and re-forking into a third session. But running it up
          // front meant a refusal left the original session stripped of its
          // concurrency guard, so the next ordinary send overwrote its row
          // blind. `onBeforeBranch` fires only once the rewind is past every
          // refusal that leaves the thread untouched.
          //
          // These are the same three lines every other deliberate session
          // change runs (`handleNewChat`, and `detachHistorySession` itself).
          onBeforeBranch: () => {
            resumedThreadSendBaselineRef.current = null;
            cancelPendingHistorySelection();
            syncResumedVersion(null);
          },
        });
      } catch (error) {
        console.error("[ChatTabV2] Failed to rewind to message", error);
        toast.error("Couldn't apply that edit. Try again.");
        return false;
      }
      // `null` means the rewind was refused — a turn started under the editor
      // in the gap after `ensureThreadReadyForSend`'s network round trip, or
      // the message is gone. Nothing branched, so say nothing — and don't
      // touch bookkeeping either: `lastSentUserMessageRef` is shared with
      // `handleRetryLastMessage` and `handleOpenTopupDialog`, both of
      // which resend whatever text currently sits in it, and `edit_message`
      // has no server twin to reconcile a phantom count against. Stomping
      // either one here for an edit that never sent would corrupt state for
      // an unrelated later action.
      if (!outcome) return false;
      track("edit_message", {
        location: "chat_tab",
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });
      lastSentUserMessageRef.current = text;
      // Nothing is announced. A rewind forks the session so the original
      // transcript survives in the database, but that is deliberately invisible
      // — same as Claude Code and Codex, where editing a message just edits it.
      // This used to raise a "New branch created" toast with an "Open original"
      // action; both were removed on the task author's call.
      return true;
    },
    [
      sendBlocked,
      ensureDiscardDraftConfirmed,
      ensureThreadReadyForSend,
      cancelPendingHistorySelection,
      syncResumedVersion,
      rewindToMessage,
      outgoingSenderMetadata,
      selectedModel,
    ]
  );

  const isConcurrencyThrottle =
    errorMessage?.code === "user_rate_limit" &&
    errorMessage?.limitKind === "concurrency";

  // An upstream hop returning an error page (a gateway 502 in front of
  // MCPJam) is transient, and resending is the entire fix. Without this the
  // banner offered `Reset chat` alone, which on the scenario surfaces throws
  // away the session the tester's whole run exists to collect.
  //
  // Gated on the formatter's own code, not on `isRetryable`: the server sets
  // that flag on failures a blind resend cannot help with.
  const canRetryLastMessage =
    isConcurrencyThrottle || errorMessage?.code === UPSTREAM_ERROR_PAGE_CODE;
  const errorRetryHandler = canRetryLastMessage
    ? handleRetryLastMessage
    : undefined;

  // A pinned protocol version the server doesn't offer is the opposite of the
  // case above: nothing about resending changes the outcome, and the fix is one
  // dropdown away. Send the user there instead of leaving them to find it.
  //
  // The host id comes from the turn's own hosted context, so the link lands on
  // the client that actually holds the pin. It is absent on scenario and
  // environment surfaces, where `buildHostFocusTabPath` degrades to the clients
  // list rather than building a path the `:hostId` route would reject.
  const changeProtocolVersionHandler =
    errorMessage?.code === PROTOCOL_VERSION_PIN_CODE
      ? () => {
          track("change_protocol_version_clicked", {
            location: "chat_tab",
            has_host_id: Boolean(hostedContext?.hostId),
          });
          navigate(buildHostFocusTabPath(hostedContext?.hostId, "protocol"));
        }
      : undefined;

  useCreditTopupReturnFlow({ chatSessionId, sendMessage });

  const traceViewerTrace = liveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const handleResetAllChats = useCallback(() => {
    track("chat_cleared", { location: "chat_tab" });
    baseResetChat();
    resetMultiModelSessions();
  }, [baseResetChat, resetMultiModelSessions]);

  const handleSingleModelChange = useCallback(
    (model: ModelDefinition, options?: { userInitiated?: boolean }) => {
      setSelectedModel(model, options);
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
        // Straight from the multi-model menu, so the lead counts as a pick.
        setSelectedModel(leadModel, { userInitiated: true });
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
      track("send_message", {
        location: "chat_tab",
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
    track("sign_up_button_clicked", {
      location: "chat_tab",
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
          widgetModelContext: modelContextQueue,
        });
        setModelContextQueue([]);
      } else {
        if (promptMessages.length > 0) {
          setMessages((prev) => [...prev, ...promptMessages]);
        }

        if (skillMessages.length > 0) {
          setMessages((prev) => [...prev, ...skillMessages]);
        }

        track("send_message", {
          location: "chat_tab",
          model_id: selectedModel?.id ?? null,
          model_name: selectedModel?.name ?? null,
          model_provider: selectedModel?.provider ?? null,
          multi_model_enabled: false,
          multi_model_count: 1,
          single_model_send: true,
        });
        lastSentUserMessageRef.current = input;
        sendMessage({
          text: input,
          files,
          metadata: outgoingSenderMetadata,
          widgetModelContext: modelContextQueue,
        });
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
    track("chat_starter_prompt_clicked", { prompt, location: "chat_tab" });
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
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
    } else {
      track("send_message", {
        location: "chat_tab",
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
        multi_model_enabled: false,
        multi_model_count: 1,
        single_model_send: true,
      });
      lastSentUserMessageRef.current = prompt;
      sendMessage({
        text: prompt,
        metadata: outgoingSenderMetadata,
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
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
    submitDisabled: submitBlocked || scenarioComposerBlocked,
    tokenUsage,
    selectedServers: selectedConnectedServerNames,
    mcpToolsTokenCount,
    mcpToolsTokenCountErrors,
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
    showContextPopover,
    showHostStyleSelector,
    hostStyle,
    onHostStyleChange,
    allServerConfigs,
    onServerToggle,
    onReconnectServer,
    onDisconnectServer,
    onAddServer,
    voiceInputContext: effectiveHostedProjectId
      ? {
          projectId: effectiveHostedProjectId,
          ...(effectiveHostedSelectedServerIds.length > 0
            ? { selectedServerIds: effectiveHostedSelectedServerIds }
            : {}),
          ...(hostedScenarioId ? { scenarioId: hostedScenarioId } : {}),
          ...(hostedAccessVersion !== undefined
            ? { accessVersion: hostedAccessVersion }
            : {}),
        }
      : undefined,
    voiceInputAuthHeaders: authHeaders,
    scenarioAttachableServers:
      scenarioOptionalInventory && scenarioOptionalInventory.length > 0
        ? scenarioOptionalInventory
        : undefined,
    onAttachScenarioServer: onEnableScenarioOptionalServer,
    onManageOrgProviders: manageOrgProviders,
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
                projectId={effectiveHostedProjectId}
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
                          <TopupGatedErrorBox
                            message={errorMessage.message}
                            errorDetails={errorMessage.details}
                            code={errorMessage.code}
                            statusCode={errorMessage.statusCode}
                            isRetryable={errorMessage.isRetryable}
                            isMCPJamPlatformError={
                              errorMessage.isMCPJamPlatformError
                            }
                            canTopUp={canShowTopupCta}
                            canManageCredits={canManageOrgCreditsForActiveOrg}
                            onTopUp={handleOpenTopupDialog}
                            walletLocked={errorMessage.walletLocked}
                            limitKind={errorMessage.limitKind}
                            retryAfterMs={errorMessage.retryAfterMs}
                            onRetry={errorRetryHandler}
                            onChangeProtocolVersion={
                              changeProtocolVersionHandler
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
                            // Forward the host's progressive-discovery
                            // toggle into each per-model card so the
                            // backend respects the host setting (auto
                            // policy is only used when this is
                            // `undefined`). Without this, multi-model
                            // chat falls back to auto regardless of
                            // what BehaviorTab saved.
                            progressiveToolDiscovery:
                              executionConfig?.progressiveToolDiscovery,
                            respectToolVisibility:
                              executionConfig?.respectToolVisibility,
                            modelVisibleMcpToolResults:
                              executionConfig?.modelVisibleMcpToolResults,
                            mcpToolResultImageRendering:
                              effectiveMcpToolResultImageRendering,
                            // Same rationale: forward attached built-in
                            // tools so each per-model card resolves the
                            // same ToolSet the single-model path would.
                            builtInToolIds: executionConfig?.builtInToolIds,
                          }}
                          hostedContext={{
                            ...hostedContext,
                            projectId: effectiveHostedProjectId,
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
                          showSenderAvatars={showSenderAvatars}
                          resolveSenderAvatar={resolveSenderAvatar}
                          outgoingSenderMetadata={outgoingSenderMetadata}
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
                        chatSessionId={chatSessionId}
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
                            ? (text: string) => {
                                lastSentUserMessageRef.current = text;
                                sendMessage({
                                  text,
                                  metadata: outgoingSenderMetadata,
                                  widgetModelContext: modelContextQueue,
                                });
                                setModelContextQueue([]);
                              }
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
                            <TopupGatedErrorBox
                              message={errorMessage.message}
                              errorDetails={errorMessage.details}
                              code={errorMessage.code}
                              statusCode={errorMessage.statusCode}
                              isRetryable={errorMessage.isRetryable}
                              isMCPJamPlatformError={
                                errorMessage.isMCPJamPlatformError
                              }
                              canTopUp={canShowTopupCta}
                              canManageCredits={canManageOrgCreditsForActiveOrg}
                              onTopUp={handleOpenTopupDialog}
                              walletLocked={errorMessage.walletLocked}
                              limitKind={errorMessage.limitKind}
                              retryAfterMs={errorMessage.retryAfterMs}
                              onRetry={errorRetryHandler}
                              onChangeProtocolVersion={
                                changeProtocolVersionHandler
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
                          chatSessionId={chatSessionId}
                          messages={messages}
                          sendFollowUpMessage={(text: string) => {
                            lastSentUserMessageRef.current = text;
                            sendMessage({
                              text,
                              metadata: outgoingSenderMetadata,
                              widgetModelContext: modelContextQueue,
                            });
                            setModelContextQueue([]);
                          }}
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
                          reasoningDisplayMode={reasoningDisplayMode}
                          mcpToolResultImageRendering={
                            effectiveMcpToolResultImageRendering
                          }
                          renderUserMessageActions={
                            chatSessionId && effectiveHostedProjectId
                              ? (message) => {
                                  const promptIndex = userPromptIndexById.get(
                                    message.id
                                  );
                                  if (promptIndex === undefined) return null;
                                  return (
                                    <SaveAsTestCaseAction
                                      chatSessionId={chatSessionId}
                                      promptIndex={promptIndex}
                                      promptPreview={extractUserMessageText(
                                        message
                                      )}
                                      projectId={effectiveHostedProjectId}
                                    />
                                  );
                                }
                              : undefined
                          }
                          renderAssistantTurnFooter={
                            renderAssistantTurnActions && chatSessionId
                              ? (message) => {
                                  const promptIndex =
                                    assistantPromptIndexById.get(message.id);
                                  if (promptIndex === undefined) return null;
                                  return renderAssistantTurnActions({
                                    message,
                                    chatSessionId,
                                    promptIndex,
                                    turnId:
                                      turnIdByPromptIndex.get(promptIndex) ??
                                      null,
                                  });
                                }
                              : undefined
                          }
                          // Also gated on `showHistoryRail`, not just compare
                          // mode. `ChatTabV2` is the published scenario runtime
                          // too (`ScenarioChatPage` renders it with `minimalMode`
                          // and a `hostedContext.scenarioId`), and it ships in
                          // non-hosted builds (desktop / `npx` inspector) —
                          // surfaces where `showHistoryRail` is false because
                          // there is no history UI at all.
                          //
                          // Editing BRANCHES: it seeds a fresh session with the
                          // prefix and leaves the original behind. Without
                          // persistence and a history surface to reach it
                          // through, branching simply DISCARDS the original
                          // thread with no way back — worse than the in-place
                          // truncation this feature replaced.
                          //
                          // Do not re-enable this for those surfaces without
                          // first solving the way back.
                          onEditUserMessage={
                            isMultiModelMode || !showHistoryRail
                              ? undefined
                              : handleEditUserMessage
                          }
                          editDisabled={sendBlocked}
                          showSenderAvatars={showSenderAvatars}
                          resolveSenderAvatar={resolveSenderAvatar}
                        />
                      </StickToBottom.Content>
                      <ScrollToBottomButton />
                    </div>

                    <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
                      {errorMessage && (
                        <div className="max-w-4xl mx-auto px-4 pt-4">
                          <TopupGatedErrorBox
                            message={errorMessage.message}
                            errorDetails={errorMessage.details}
                            code={errorMessage.code}
                            statusCode={errorMessage.statusCode}
                            isRetryable={errorMessage.isRetryable}
                            isMCPJamPlatformError={
                              errorMessage.isMCPJamPlatformError
                            }
                            canTopUp={canShowTopupCta}
                            canManageCredits={canManageOrgCreditsForActiveOrg}
                            onTopUp={handleOpenTopupDialog}
                            walletLocked={errorMessage.walletLocked}
                            limitKind={errorMessage.limitKind}
                            retryAfterMs={errorMessage.retryAfterMs}
                            onRetry={errorRetryHandler}
                            onChangeProtocolVersion={
                              changeProtocolVersionHandler
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

            {/*
              Two independent sources, deliberately not merged into one queue:
              the local SSE channel (`/api/mcp/elicitation/*`, local mode only)
              and the hosted stream data part. They carry different identities
              (requestId vs rendezvousId) and answer over different transports,
              so each keeps its own dialog and respond path. Only one can be
              active in a given mode — `elicitationQueue` never fills in hosted
              (the SSE effect early-returns), and `pendingElicitations` never
              fills locally (no bridge is registered).
            */}
            <ElicitationDialog
              elicitationRequest={activeElicitation}
              onResponse={handleElicitationResponse}
              loading={elicitationLoading}
            />
            <ElicitationRequestDialog
              // Keyed so a second request can't inherit the first's internal
              // dialog state (popup-blocked notice, half-filled form).
              key={pendingElicitations[0]?.rendezvousId ?? "none"}
              request={pendingElicitations[0] ?? null}
              onRespond={respondToElicitation}
              loading={elicitationResponding}
            />
            {/* -32042: a tool needs an out-of-band interaction finished first. */}
            <UrlElicitationRequiredDialog
              key={urlElicitationRequired[0]?.toolCallId ?? "no-url-required"}
              event={urlElicitationRequired[0] ?? null}
              onDismiss={dismissUrlElicitationRequired}
            />
            {/* Modern MRTR (`input_required`) input rail for local chat: a tool
                the agent calls can return `input_required`; the SDK driver
                collects rounds through this shared dialog and retries. */}
            <MrtrElicitationHost />
            {/* Hosted MRTR (§12.5): the durable-continuation rail. Distinct
                from the local host above — different transport, same dialogs;
                only one of the two can ever have a round in a given mode. */}
            <HostedMrtrHost />
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
      {isTopupDialogOpen && (
        <CreditTopupDialog
          open
          onOpenChange={handleTopupDialogOpenChange}
          chatSessionId={chatSessionId}
          lastUserMessage={pendingResendMessage}
          organizationId={organizationId}
          source="chat_banner"
        />
      )}
    </div>
  );
}
