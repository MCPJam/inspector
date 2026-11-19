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

  // The send, history, and edit handlers are gone in this slice. These
  // names stay referenced so the leftover body still typechecks.
  void [
    resolveRestoredModel, modelRowKey, useCompareSelections, useModelPickerEfforts,
    useSingleFlight, compareSelectionForRow, mergePickedRows, resolveCompareCards,
    resolveCompareSelectionRow, setCompareCardEffort, MAX_COMPARE_SELECTIONS, useLayoutEffect,
    ScrollToBottomButton, useHistoryTarget, OrgAiRefusalHandoffProvider, toast,
    LoggerView, ResizablePanelGroup, ResizablePanel, ResizableHandle,
    ElicitationDialog, MrtrElicitationHost, HostedMrtrHost, ElicitationRequestDialog,
    UrlElicitationRequiredDialog, AlertDialog, AlertDialogAction, AlertDialogCancel,
    AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
    AlertDialogTitle, ChatInput, collectInputHistory, Thread,
    SaveAsTestCaseAction, MCPJamFreeModelsPrompt, track, buildHostFocusTabPath,
    CreditTopupDialog, TopupGatedErrorBox, useCreditTopupReturnFlow, applyWidgetStateUpdates,
    StickToBottom, attachmentsToFileUIParts, STARTER_PROMPTS, shouldShowStarterPrompts,
    formatErrorMessage, buildMcpPromptMessages, buildSkillContextMessages, DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
    MINIMAL_CHAT_COMPOSER_PLACEHOLDER, cloneUiMessages, extractUserMessageText, UPSTREAM_ERROR_PAGE_CODE,
    PROTOCOL_VERSION_PIN_CODE, MultiModelEmptyTraceDiagnosticsPanel, MultiModelStartersEmptyLayout, CollapsedPanelStrip,
    DETACH_FORK_FAILED_MESSAGE, RESUMED_THREAD_CONFLICT_MESSAGE, RESUMED_THREAD_UNSAVED_MESSAGE, useResumedThreadPersistence,
    addTokenToUrl, authFetch, cn, isSpendBudgetReachedCode,
    isRetryableOrgKeysRefusal, WebApiError, ChatHistoryRail, chatHistoryAction,
    getChatHistoryDetail, getChatHistoryState, presendStateIsCurrent, withPresendSyncTimeout,
    orgRequiresOwnKeys, isOrgKeysDisallowedRow, useModelSelectorLayoutLock, ChatTraceViewModeHeaderBar,
    SingleModelTraceDiagnosticsBody, MultiModelChatCard, hasSameStringArray, resolveRestorableServerNames,
    shouldPreserveGuestServerSelection, getChatComposerInteractivity, useChatStopControls, allServerConfigs,
    onServerToggle, onReconnectServer, onDisconnectServer, onAddServer,
    onSelectedServerNamesChange, onHasMessagesChange, enableMultiModelChat, showContextPopover,
    reasoningDisplayMode, showHostStyleSelector, onHostStyleChange, scenarioComposerBlocked,
    scenarioComposerBlockedReason, scenarioOptionalInventory, onEnableScenarioOptionalServer, evalChatHandoff,
    onEvalChatHandoffConsumed, renderAssistantTurnActions, signUp, isJsonRpcPanelVisible,
    toggleJsonRpcPanel, effectiveMcpToolResultImageRendering, widgetStateQueue, modelContextQueue,
    handleModelContextUpdate, elicitationQueue, setElicitationQueue, elicitationLoading,
    setElicitationLoading, setIsWidgetFullscreen, broadcastRequest, setBroadcastRequest,
    stopBroadcastRequestId, setStopBroadcastRequestId, multiModelSessionGeneration, setMultiModelSessionGeneration,
    multiModelSummaries, setMultiModelSummaries, multiModelHasMessages, setMultiModelHasMessages,
    multiCompareEnterVersion, setMultiCompareEnterVersion, multiCompareEnterMessages, setMultiCompareEnterMessages,
    multiAddColumnSeeds, setMultiAddColumnSeeds, multiTranscriptsRef, prevCompareModeRef,
    lastMultiLeadIdRef, prevCompareModelIdsRef, multiAddColumnSeqRef, compareSeedSourceRef,
    loadingHistorySessionId, setPendingDirectVisibility, historyRefreshSignal, traceViewMode,
    setTraceViewMode, revealedInChat, setRevealedInChat, resumedThreadSendBaselineRef,
    canManageOrgCreditsForActiveOrg, navigate, hostedAccessVersion, hostedScenarioSurface,
    refusalHandoff, serversById, isHostedDirectGuest, setMessages,
    sendMessage, stop, status, error,
    selectedModel, setSelectedModel, isSelectedModelResolved, selectedModelIds,
    setSelectedModelIds, multiModelEnabled, setMultiModelEnabled, availableModels,
    modelHarnessScope, authHeaders, isAuthLoading, isSessionBootstrapComplete,
    systemPrompt, setSystemPrompt, temperature, setTemperature,
    reasoningEffort, reasoningEffortLevels, setReasoningEffort, reasoningEffortLevelsFor,
    setReasoningEffortForModel, toolsMetadata, toolServerMap, tokenUsage,
    mcpToolsTokenCount, mcpToolsTokenCountErrors, mcpToolsTokenCountLoading, systemPromptTokenCount,
    systemPromptTokenCountLoading, baseResetChat, startChatWithMessages, detachToLocalFork,
    consumePersistReceipt, consumeTurnAborted, loadChatSession, rewindToMessage,
    syncResumedVersion, restoredToolRenderOverrides, requestPayloadHistory, hasLiveTimelineContent,
    traceViewsSupported, disableForAuthentication, baseSubmitBlocked, setRequireToolApproval,
    addToolApprovalResponse, pendingElicitations, respondToElicitation, elicitationResponding,
    urlElicitationRequired, dismissUrlElicitationRequired, autoResumeNotice, harnessStartupPhase,
    reactiveHistoryWidgetSnapshots, historyRailTakesLayoutSpace, resolveSenderAvatar, outgoingSenderMetadata,
    hasConversationMessages, userPromptIndexById, assistantPromptIndexById, turnIdByPromptIndex,
    handleOAuthRequired,
  ];

  return null;
}
