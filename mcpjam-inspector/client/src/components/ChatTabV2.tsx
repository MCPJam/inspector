import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { resolveRestoredModel } from "@/lib/model-selection";
import { modelRowKey } from "@/components/chat-v2/shared/model-selection";
import { useCompareSelections } from "@/hooks/use-compare-selections";
import { useModelPickerEfforts } from "@/hooks/use-model-picker-efforts";
import { useSingleFlight } from "@/hooks/use-single-flight";
import {
  compareSelectionForRow,
  mergePickedRows,
  resolveCompareCards,
  resolveCompareSelectionRow,
  setCompareCardEffort,
  MAX_COMPARE_SELECTIONS,
  type CompareCard,
} from "@/lib/compare-cards";
import {
  useMemo,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
} from "react";
import type { UIMessage } from "ai";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import { useInspectorAuth } from "@/hooks/use-inspector-auth";
import { useHistoryTarget } from "@/hooks/use-history-target";
import { useConvexAuth, useQuery } from "convex/react";
import {
  canManageOrgCredits,
  useOrganizationQueries,
} from "@/hooks/useOrganizations";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import {
  OrgAiRefusalHandoffProvider,
  orgAiRefusalHandoff,
} from "@/contexts/org-ai-refusal-context";
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
import { collectInputHistory } from "@/components/chat-v2/chat-input/input-history";
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
import { applyWidgetStateUpdates } from "@/shared/user-context-message";
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
  shouldShowStarterPrompts,
  formatErrorMessage,
  buildMcpPromptMessages,
  buildSkillContextMessages,
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
import { isSpendBudgetReachedCode } from "@/lib/mcpjam-limit";
import { isRetryableOrgKeysRefusal } from "@/lib/org-keys-refusal";
import { WebApiError } from "@/lib/apis/web/base";
import { useSharedAppState } from "@/state/app-state-context";
import { ChatHistoryRail } from "@/components/chat-v2/history/ChatHistoryRail";
import {
  chatHistoryAction,
  getChatHistoryDetail,
  getChatHistoryState,
  type ChatHistoryStateSession,
  type ChatHistoryDetailSession,
  type ChatHistorySession,
  type ChatHistoryTurnTrace,
  type ChatHistoryWidgetSnapshot,
} from "@/lib/apis/web/chat-history-api";
import {
  presendStateIsCurrent,
  withPresendSyncTimeout,
} from "@/lib/chat-history-presend";
import { useProjectServers } from "@/hooks/useViews";
import { useProjectMembers } from "@/hooks/useProjects";
import { buildProjectOwnerProfileByUserId } from "@/components/chat-v2/history/project-thread-owner-avatar";
import { buildSenderAvatarResolver } from "@/components/chat-v2/shared/sender-avatar";
import { HOSTED_MODE } from "@/lib/config";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";
import { isOrgKeysDisallowedRow } from "@/components/chat-v2/shared/available-models";
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
import { useWidgetModelContextQueue } from "@/hooks/use-widget-model-context-queue";
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
  const { signUp } = useInspectorAuth();
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
  const [modelContextQueue, setModelContextQueue, handleModelContextUpdate] =
    useWidgetModelContextQueue();
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
  // A card that replaces another (its effort, so its `comparisonKey`,
  // changed) or joins beside one of the same model (another effort, picked
  // in the model menu) is seeded from that card's transcript rather than the
  // lead's: new key → source key.
  const compareSeedSourceRef = useRef<Record<string, string>>({});
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
  // A hosted page's reader is a visitor: no organization configuration.
  const refusalHandoff = useMemo(
    () =>
      orgAiRefusalHandoff({
        visitor: Boolean(hostedContext?.projectId),
        onManageOrgProviders: manageOrgProviders,
      }),
    [hostedContext?.projectId, manageOrgProviders],
  );
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
  const effectiveHostedSelectedServerIds =
    hostedContext?.selectedServerIds ?? hostedSelectedServerIds;
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
    modelHarnessScope,
    authHeaders,
    isAuthLoading,
    isSessionBootstrapComplete,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    reasoningEffort,
    reasoningEffortLevels,
    setReasoningEffort,
    reasoningEffortLevelsFor,
    setReasoningEffortForModel,
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
    autoResumeNotice,
    harnessStartupPhase,
  } = useChatSession({
    selectedServers: selectedConnectedServerNames,
    // A scenario / share-link turn runs the host's own config; the visitor's
    // chip would be ignored there, so it is not offered.
    reasoningEffortEnabled: !hostedContext?.scenarioId,
    directVisibility: pendingDirectVisibility,
    hostedOrgModelConfig,
    selectionIntent: hostedContext?.hostId || hostedContext?.executionTarget ? "inherit" : "picked",
    hostedContext: {
      ...hostedContext,
      projectId: effectiveHostedProjectId,
      selectedServerIds: effectiveHostedSelectedServerIds,
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
  useEffect(() => {
    if (chatSessionId) {
      useActiveChatSessionStore.getState().setApprovalSetting(chatSessionId, requireToolApproval);
    }
  }, [chatSessionId, requireToolApproval]);

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
      // Resolve history before seeding its saved effort.
      const restoredModel =
        ((options?.shouldRestoreComposerState?.() ?? true) && detail.modelId
          ? detail.modelSelection
            ? resolveCompareSelectionRow(detail.modelSelection, availableModels, hostedOrgModelConfig)
            : resolveRestoredModel(
              availableModels,
              detail.modelId,
              detail.modelSource
            )
          : null) ?? undefined;
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
          restoredModel,
          restoredSelection: detail.modelSelection,
        }
      );
      if (options?.shouldApply && !options.shouldApply()) {
        return;
      }
      if ((options?.shouldRestoreComposerState?.() ?? true) && (restoredModel || detail.modelSelection)) {
        setSelectedModel(restoredModel ?? selectedModel, { selection: detail.modelSelection, persist: false });
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
      hostedOrgModelConfig,
      selectedModel,
      loadChatSession,
      markHistorySessionRead,
      setSelectedModel,
      syncResumedVersion,
    ]
  );

  const isCurrentHistoryTarget = useHistoryTarget(chatSessionId, effectiveHostedProjectId);

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
          const detail = await getChatHistoryState({
            sessionId: activeHistorySessionId ?? undefined,
            chatSessionId,
            projectId: effectiveHostedProjectId ?? undefined,
          });
          if (
            !isCurrentHistoryTarget({ chatSessionId, projectId: effectiveHostedProjectId }) ||
            detail.session.chatSessionId !== chatSessionId
          ) {
            return null;
          }
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
      isCurrentHistoryTarget,
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
    if (
      presendStateIsCurrent({
        activeHistorySessionId,
        chatSessionId,
        live: reactiveHistorySession,
        resumedVersion,
        visibility: pendingDirectVisibility,
      })
    ) {
      return true;
    }
    const target = { chatSessionId, projectId: effectiveHostedProjectId };
    let detail: ChatHistoryStateSession | null = null;
    try {
      detail = await withPresendSyncTimeout(refreshCurrentHistorySession());
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
    // Another thread opened while the read was in flight: this send belonged
    // to the one that closed, so drop it rather than detach the open thread.
    if (!isCurrentHistoryTarget(target)) {
      return false;
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
    chatSessionId,
    detachHistorySession,
    effectiveHostedProjectId,
    isCurrentHistoryTarget,
    pendingDirectVisibility,
    reactiveHistorySession,
    refreshCurrentHistorySession,
    resumedVersion,
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
          const target = { chatSessionId, projectId: effectiveHostedProjectId };
          const detail = await refreshCurrentHistorySession();
          // No row is "no longer shared" only while that thread is still the
          // open one; a read that outlived it says nothing about the new one.
          if (!detail && isCurrentHistoryTarget(target)) {
            detachHistorySession(
              "This chat is no longer shared with you. Continuing locally in a new thread."
            );
          }
        } catch (error) {
          console.error("[ChatTabV2] Failed to refresh unshared chat", error);
        }
      }
    },
    [
      activeHistorySessionId,
      chatSessionId,
      detachHistorySession,
      effectiveHostedProjectId,
      isCurrentHistoryTarget,
      refreshCurrentHistorySession,
    ]
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
  // v1 line-up (model ids): what compare renders until the one-time
  // migration to the v2 selection list has run.
  const v1SelectedModels = useMemo(() => {
    const persistedModels = selectedModelIds
      .map((modelId) => multiModelAvailableModels.get(modelId))
      .filter((model): model is ModelDefinition => !!model && !model.disabled);

    if (persistedModels.length > 0) {
      return persistedModels.slice(0, MAX_COMPARE_SELECTIONS);
    }

    return selectedModel ? [selectedModel] : [];
  }, [multiModelAvailableModels, selectedModel, selectedModelIds]);
  // v2 line-up: saved selections, one card per `comparisonKey` (two cards of
  // one model at Low and High are two cards), each with its own effort.
  const { selections: compareSelections, setSelections: setCompareSelections } =
    useCompareSelections({
      availableModels,
      orgConfig: hostedOrgModelConfig,
      v1ModelIds: selectedModelIds,
      ready:
        isSelectedModelResolved !== false &&
        !executionConfig?.modelId &&
        !hostedScenarioId,
    });
  const compareCards = useMemo<CompareCard[] | null>(() => {
    if (!compareSelections) return null;
    const cards = resolveCompareCards(
      compareSelections,
      availableModels,
      hostedOrgModelConfig
    );
    if (cards.length > 0 || !selectedModel) return cards;
    // Nothing saved resolves: compare starts from the lead, as v1 did.
    const lead = compareSelectionForRow(selectedModel, hostedOrgModelConfig);
    if (!lead) return null;
    const leadCards = resolveCompareCards(
      [lead],
      [selectedModel],
      hostedOrgModelConfig
    );
    return leadCards.length > 0 ? leadCards : null;
  }, [availableModels, compareSelections, hostedOrgModelConfig, selectedModel]);
  // A single-model pick collapses the compare line-up to that model, in both
  // stores (the v1 id list and, once migrated, the v2 selections).
  const collapseCompareSelectionsTo = useCallback(
    (model: ModelDefinition) => {
      if (!compareSelections) return;
      const selection = compareCards?.find((card) => modelRowKey(card.model) === modelRowKey(model))?.selection ??
        compareSelectionForRow(model, hostedOrgModelConfig);
      setCompareSelections(selection ? [selection] : []);
    },
    [compareCards, compareSelections, hostedOrgModelConfig, setCompareSelections]
  );
  // What the grid renders: the v2 cards, else one card per v1 model (keyed by
  // its id, no per-card effort — exactly the v1 behaviour).
  const modelCompareCards = useMemo<
    { key: string; model: ModelDefinition; label: string; card?: CompareCard }[]
  >(
    () =>
      compareCards
        ? compareCards.map((card) => ({
            key: card.key,
            model: card.model,
            label: card.label,
            card,
          }))
        : v1SelectedModels.map((model) => ({
            key: String(model.id),
            model,
            label: model.name,
          })),
    [compareCards, v1SelectedModels]
  );
  // The distinct rows in the line-up (the picker's checked models and the v1
  // id mirror); two efforts of one model are one row.
  const resolvedSelectedModels = useMemo(() => {
    const seen = new Set<string>();
    const rows: ModelDefinition[] = [];
    for (const entry of modelCompareCards) {
      const rowKey = modelRowKey(entry.model);
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);
      rows.push(entry.model);
    }
    return rows;
  }, [modelCompareCards]);
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
    if (isMultiModelMode && modelCompareCards[0]) {
      lastMultiLeadIdRef.current = modelCompareCards[0].key;
    }
  }, [isMultiModelMode, modelCompareCards]);

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
    const current = new Set(modelCompareCards.map((card) => card.key));
    const prev = prevCompareModelIdsRef.current;
    const added = [...current].filter((id) => !prev.has(id));
    const leadId = modelCompareCards[0]?.key ?? null;
    if (prev.size > 0 && added.length > 0 && leadId) {
      multiAddColumnSeqRef.current += 1;
      const v = multiAddColumnSeqRef.current;
      const sources = compareSeedSourceRef.current;
      const seeds = added.map((id) => {
        const sourceId = sources[id];
        const src =
          (sourceId !== undefined
            ? multiTranscriptsRef.current[sourceId]
            : undefined) ??
          multiTranscriptsRef.current[leadId] ??
          [];
        return [id, src] as const;
      });
      setMultiAddColumnSeeds((s) => {
        const next = { ...s };
        for (const [id, src] of seeds) {
          next[id] = { version: v, messages: cloneUiMessages(src) };
        }
        return next;
      });
    }
    for (const id of added) delete compareSeedSourceRef.current[id];
    prevCompareModelIdsRef.current = current;
  }, [isMultiModelMode, modelCompareCards]);

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
    // What the ids SHOULD be: the line-up in compare, else the single chat's
    // own model. Compared against that same value, so the write settles:
    // comparing against the line-up while writing the single model looped
    // forever whenever the two differed (a reload keeps the line-up while the
    // single chat re-seeds from the client).
    const nextIds =
      sanitizedIds.length > 0 && multiModelEnabled
        ? sanitizedIds
        : selectedModel
          ? [String(selectedModel.id)]
          : [];
    const persistedIds = selectedModelIds.slice(0, 3);
    const idsChanged =
      nextIds.length !== persistedIds.length ||
      nextIds.some((modelId, index) => modelId !== persistedIds[index]);

    if (idsChanged) {
      setSelectedModelIds(nextIds);
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
    const activeModelIds = new Set(modelCompareCards.map((card) => card.key));

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
  }, [modelCompareCards]);

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
      collapseCompareSelectionsTo(matchingModel);
      setSelectedModel(matchingModel);
    } else if (selectedModel) {
      setMultiModelEnabled(false);
      setSelectedModelIds([String(selectedModel.id)]);
      collapseCompareSelectionsTo(selectedModel);
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
    collapseCompareSelectionsTo,
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

  // Widget state reaches the model as user-role context (MJ-009); see
  // `applyWidgetStateUpdates`.
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
    [status, setMessages],
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) return;

    setMessages((prevMessages) =>
      applyWidgetStateUpdates(prevMessages, widgetStateQueue)
    );
    setWidgetStateQueue([]);
  }, [status, widgetStateQueue, setMessages]);

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
  // A compare card on a saved model the organization's AI key policy no
  // longer allows never sends (its picker warns on the trigger): a personal
  // key in local mode has no server-side check to refuse it.
  const compareHasDisallowedModel =
    isMultiModelMode &&
    modelCompareCards.some((entry) => isOrgKeysDisallowedRow(entry.model));
  const submitBlocked = baseSubmitBlocked || compareHasDisallowedModel;
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
    // Explicit even though the positive test below already excludes it: a
    // spend-budget refusal must never offer credits, because buying them
    // does not raise the cap. Stated here so loosening the code check
    // cannot silently reintroduce a "buy credits" button for it.
    !isSpendBudgetReachedCode(errorMessage?.code) &&
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
      organization_id: organizationId,
      source: "chat_banner",
    });
    setPendingResendMessage(text);
    setIsTopupDialogOpen(true);
  }, [organizationId]);

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
  // One send at a time for the composer and Retry (see `onSubmit`).
  const composerSend = useSingleFlight();
  const handleRetryLastMessage = useCallback(() => {
    const text = lastSentUserMessageRef.current;
    if (!text) return;
    void composerSend.run(() =>
      sendMessage({ text, metadata: outgoingSenderMetadata }),
    );
  }, [sendMessage, outgoingSenderMetadata, composerSend.run]);

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

  // The JSX this function returned is deleted in this slice. The names
  // below stay referenced so the leftover body still typechecks.
  void [
    useModelPickerEfforts, mergePickedRows, setCompareCardEffort, ScrollToBottomButton,
    OrgAiRefusalHandoffProvider, LoggerView, ResizablePanelGroup, ResizablePanel,
    ResizableHandle, ElicitationDialog, MrtrElicitationHost, HostedMrtrHost,
    ElicitationRequestDialog, UrlElicitationRequiredDialog, AlertDialog, AlertDialogAction,
    AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
    AlertDialogHeader, AlertDialogTitle, ChatInput, collectInputHistory,
    Thread, SaveAsTestCaseAction, MCPJamFreeModelsPrompt, buildHostFocusTabPath,
    CreditTopupDialog, TopupGatedErrorBox, useCreditTopupReturnFlow, StickToBottom,
    attachmentsToFileUIParts, STARTER_PROMPTS, shouldShowStarterPrompts, buildMcpPromptMessages,
    buildSkillContextMessages, extractUserMessageText, UPSTREAM_ERROR_PAGE_CODE, PROTOCOL_VERSION_PIN_CODE,
    MultiModelEmptyTraceDiagnosticsPanel, MultiModelStartersEmptyLayout, CollapsedPanelStrip, cn,
    isRetryableOrgKeysRefusal, ChatHistoryRail, orgRequiresOwnKeys, ChatTraceViewModeHeaderBar,
    SingleModelTraceDiagnosticsBody, MultiModelChatCard, allServerConfigs, onServerToggle,
    onReconnectServer, onDisconnectServer, onAddServer, showContextPopover,
    reasoningDisplayMode, showHostStyleSelector, onHostStyleChange, scenarioOptionalInventory,
    onEnableScenarioOptionalServer, renderAssistantTurnActions, signUp, isJsonRpcPanelVisible,
    toggleJsonRpcPanel, effectiveMcpToolResultImageRendering, modelContextQueue, handleModelContextUpdate,
    elicitationLoading, setIsWidgetFullscreen, broadcastRequest, stopBroadcastRequestId,
    multiModelSessionGeneration, multiCompareEnterVersion, multiCompareEnterMessages, multiAddColumnSeeds,
    loadingHistorySessionId, historyRefreshSignal, revealedInChat, canManageOrgCreditsForActiveOrg,
    navigate, hostedAccessVersion, refusalHandoff, modelHarnessScope,
    authHeaders, systemPrompt, temperature, reasoningEffort,
    reasoningEffortLevels, setReasoningEffort, reasoningEffortLevelsFor, setReasoningEffortForModel,
    toolsMetadata, toolServerMap, tokenUsage, mcpToolsTokenCount,
    mcpToolsTokenCountErrors, mcpToolsTokenCountLoading, systemPromptTokenCount, systemPromptTokenCountLoading,
    requestPayloadHistory, hasLiveTimelineContent, addToolApprovalResponse, pendingElicitations,
    respondToElicitation, elicitationResponding, urlElicitationRequired, dismissUrlElicitationRequired,
    autoResumeNotice, harnessStartupPhase, historyRailTakesLayoutSpace, resolveSenderAvatar,
    userPromptIndexById, assistantPromptIndexById, turnIdByPromptIndex, handleOAuthRequired,
    discardDraftDialogOpen, settleDiscardDraft, handleSelectThread, handleNewChat,
    handleArchiveAllComplete, handleHistorySessionAction, onModelSelectorOpenChange, handleMultiModelTranscriptSync,
    showLiveTraceDiagnostics, handleWidgetStateChange, handleElicitationResponse, stopActiveChat,
    historyRailStreaming, composerDisabled, placeholder, showDisabledCallout,
    isTopupDialogOpen, pendingResendMessage, canShowTopupCta, handleOpenTopupDialog,
    handleTopupDialogOpenChange, handleRetryLastMessage, handleEditUserMessage,
  ];

  return null;
}
