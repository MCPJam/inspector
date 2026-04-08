import {
  FormEvent,
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { UIMessage } from "ai";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { ModelDefinition } from "@/shared/types";
import { LoggerView } from "./logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import type { DialogElicitation } from "@/components/ToolsTab";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { Thread } from "@/components/chat-v2/thread";
import { type ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import type { LoadingIndicatorVariant } from "@/components/chat-v2/shared/loading-indicator-content";
import { ServerWithName } from "@/hooks/use-app-state";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
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
} from "@/components/chat-v2/shared/chat-helpers";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import { MultiModelStartersEmptyLayout } from "@/components/chat-v2/multi-model-starters-empty";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { useChatSession } from "@/hooks/use-chat-session";
import { useDebouncedXRayPayload } from "@/hooks/use-debounced-x-ray-payload";
import { addTokenToUrl, authFetch } from "@/lib/session-token";
import { cn } from "@/lib/utils";
import { useSharedAppState } from "@/state/app-state-context";
import { useWorkspaceServers } from "@/hooks/useViews";
import { HOSTED_MODE } from "@/lib/config";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { LiveTraceRawEmptyState } from "@/components/evals/live-trace-raw-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";
import { ChatTraceViewModeHeaderBar } from "@/components/evals/trace-view-mode-tabs";
import {
  type BroadcastChatTurnRequest,
  MultiModelChatCard,
} from "@/components/chat-v2/multi-model-chat-card";
import type { MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";

interface ChatTabProps {
  connectedOrConnectingServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
  onHasMessagesChange?: (hasMessages: boolean) => void;
  enableTraceViews?: boolean;
  enableMultiModelChat?: boolean;
  minimalMode?: boolean;
  hostedWorkspaceIdOverride?: string;
  hostedSelectedServerIdsOverride?: string[];
  hostedOAuthTokensOverride?: Record<string, string>;
  hostedShareToken?: string;
  hostedSandboxToken?: string;
  hostedSandboxSurface?: "preview" | "share_link";
  initialModelId?: string;
  initialSystemPrompt?: string;
  initialTemperature?: number;
  initialRequireToolApproval?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  loadingIndicatorVariant?: LoadingIndicatorVariant;
  onOAuthRequired?: (details?: HostedOAuthRequiredDetails) => void;
  /** When true, blocks sending until sandbox onboarding/OAuth completes. */
  sandboxComposerBlocked?: boolean;
  sandboxComposerBlockedReason?: string;
  /** Optional (off-by-default) servers the tester can attach from minimal chat. */
  sandboxOptionalInventory?: Array<{
    serverId: string;
    serverName: string;
    useOAuth: boolean;
  }>;
  onEnableSandboxOptionalServer?: (serverId: string) => void;
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
}

type ChatTraceViewMode = "chat" | "timeline" | "raw";


export function ChatTabV2({
  connectedOrConnectingServerConfigs,
  selectedServerNames,
  onHasMessagesChange,
  enableTraceViews = false,
  enableMultiModelChat = false,
  minimalMode = false,
  hostedWorkspaceIdOverride,
  hostedSelectedServerIdsOverride,
  hostedOAuthTokensOverride,
  hostedShareToken,
  hostedSandboxToken,
  hostedSandboxSurface,
  initialModelId,
  initialSystemPrompt,
  initialTemperature,
  initialRequireToolApproval,
  reasoningDisplayMode = "inline",
  loadingIndicatorVariant = "default",
  onOAuthRequired,
  sandboxComposerBlocked = false,
  sandboxComposerBlockedReason,
  sandboxOptionalInventory,
  onEnableSandboxOptionalServer,
  evalChatHandoff,
  onEvalChatHandoffConsumed,
}: ChatTabProps) {
  const { signUp } = useAuth();
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const appState = useSharedAppState();
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const posthog = usePostHog();

  // Local state for ChatTabV2-specific features
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
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
    [],
  );
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
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

  const [traceViewMode, setTraceViewMode] = useState<ChatTraceViewMode>("chat");
  const [revealedInChat, setRevealedInChat] = useState(false);

  // Filter to only connected servers
  const selectedConnectedServerNames = useMemo(
    () =>
      selectedServerNames.filter(
        (name) =>
          connectedOrConnectingServerConfigs[name]?.connectionStatus ===
          "connected",
      ),
    [selectedServerNames, connectedOrConnectingServerConfigs],
  );
  const activeWorkspace = appState.workspaces[appState.activeWorkspaceId];
  const convexWorkspaceId = activeWorkspace?.sharedWorkspaceId ?? null;
  const { serversByName } = useWorkspaceServers({
    isAuthenticated: isConvexAuthenticated,
    workspaceId: convexWorkspaceId,
  });
  const hostedSelectedServerIds = useMemo(
    () =>
      selectedConnectedServerNames
        .map((serverName) => serversByName.get(serverName))
        .filter((serverId): serverId is string => !!serverId),
    [selectedConnectedServerNames, serversByName],
  );
  const hostedOAuthTokens = useMemo(
    () =>
      buildOAuthTokensByServerId(
        selectedConnectedServerNames,
        (name) => serversByName.get(name),
        (name) => appState.servers[name]?.oauthTokens?.access_token,
      ),
    [selectedConnectedServerNames, serversByName, appState.servers],
  );
  const effectiveHostedWorkspaceId =
    hostedWorkspaceIdOverride ?? convexWorkspaceId;
  const effectiveHostedSelectedServerIds =
    hostedSelectedServerIdsOverride ?? hostedSelectedServerIds;
  const effectiveHostedOAuthTokens =
    hostedOAuthTokensOverride ?? hostedOAuthTokens;

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
    liveTraceEnvelope,
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
    hostedWorkspaceId: effectiveHostedWorkspaceId,
    hostedSelectedServerIds: effectiveHostedSelectedServerIds,
    hostedOAuthTokens: effectiveHostedOAuthTokens,
    hostedShareToken,
    hostedSandboxToken,
    hostedSandboxSurface,
    initialModelId,
    initialSystemPrompt,
    initialTemperature,
    initialRequireToolApproval,
    minimalMode,
    onReset: () => {
      setInput("");
      setWidgetStateQueue([]);
      setModelContextQueue([]);
    },
  });

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
  }, [
    availableModels,
    multiModelAvailableModels,
    selectedModel,
    selectedModelIds,
  ]);
  const canEnableMultiModel =
    enableMultiModelChat &&
    !minimalMode &&
    !initialModelId &&
    !hostedShareToken &&
    !hostedSandboxToken &&
    !hostedSandboxSurface &&
    availableModels.length > 1;
  const isMultiModelMode = canEnableMultiModel && multiModelEnabled;
  const effectiveHasMessages = isMultiModelMode
    ? Object.values(multiModelHasMessages).some(Boolean)
    : !isThreadEmpty;
  const showTopTraceViewTabs =
    enableTraceViews &&
    traceViewsSupported &&
    !minimalMode &&
    (!isMultiModelMode || !effectiveHasMessages);
  const activeTraceViewMode: ChatTraceViewMode = showTopTraceViewTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const appliedEvalChatHandoffIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enableTraceViews || !traceViewsSupported) {
      setTraceViewMode("chat");
      setRevealedInChat(false);
    }
  }, [enableTraceViews, traceViewsSupported]);

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
        (model) => String(model.id) === evalChatHandoff.modelId,
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
          ),
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
      updates: { toolCallId: string; state: unknown }[],
    ) => {
      let nextMessages = prevMessages;

      for (const { toolCallId, state } of updates) {
        const messageId = `widget-state-${toolCallId}`;

        if (state === null) {
          const filtered = nextMessages.filter((msg) => msg.id !== messageId);
          nextMessages = filtered;
          continue;
        }

        const stateText = `The state of widget ${toolCallId} is: ${JSON.stringify(state)}`;
        const existingIndex = nextMessages.findIndex(
          (msg) => msg.id === messageId,
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
    [],
  );

  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      if (status === "ready") {
        setMessages((prevMessages) =>
          applyWidgetStateUpdates(prevMessages, [{ toolCallId, state }]),
        );
      } else {
        setWidgetStateQueue((prev) => [...prev, { toolCallId, state }]);
      }
    },
    [status, setMessages, applyWidgetStateUpdates],
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) return;

    setMessages((prevMessages) =>
      applyWidgetStateUpdates(prevMessages, widgetStateQueue),
    );
    setWidgetStateQueue([]);
  }, [status, widgetStateQueue, setMessages, applyWidgetStateUpdates]);

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
                (elicitation) => elicitation.requestId === data.requestId,
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
              (elicitation) => elicitation.requestId !== data.requestId,
            ),
          );
        }
      } catch (error) {
        console.warn("[ChatTabV2] Failed to parse elicitation event:", error);
      }
    };
    es.onerror = () => {
      console.warn(
        "[ChatTabV2] Elicitation SSE connection error, browser will retry",
      );
    };
    return () => es.close();
  }, []);

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, unknown>,
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
          (elicitation) =>
            elicitation.requestId !== activeElicitation.requestId,
        ),
      );
    } finally {
      setElicitationLoading(false);
    }
  };

  // Submit blocking with server check
  const submitBlocked = baseSubmitBlocked;
  const isAnyMultiModelStreaming =
    isMultiModelMode &&
    Object.values(multiModelSummaries).some(
      (summary) => summary.status === "running",
    );
  const inputDisabled = isMultiModelMode
    ? isAnyMultiModelStreaming || submitBlocked || sandboxComposerBlocked
    : status !== "ready" || submitBlocked || sandboxComposerBlocked;

  let placeholder = minimalMode
    ? MINIMAL_CHAT_COMPOSER_PLACEHOLDER
    : DEFAULT_CHAT_COMPOSER_PLACEHOLDER;
  if (sandboxComposerBlocked && sandboxComposerBlockedReason) {
    placeholder = sandboxComposerBlockedReason;
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
  const rawTraceXRayMirror = useDebouncedXRayPayload({
    systemPrompt,
    messages,
    selectedServers: selectedConnectedServerNames,
    enabled:
      traceViewsSupported &&
      !minimalMode &&
      !isThreadEmpty &&
      showLiveTraceDiagnostics,
  });
  const resetMultiModelSessions = useCallback(() => {
    setBroadcastRequest(null);
    setStopBroadcastRequestId(0);
    setMultiModelSessionGeneration((previous) => previous + 1);
    setMultiModelSummaries({});
    setMultiModelHasMessages({});
  }, []);

  const handleResetAllChats = useCallback(() => {
    baseResetChat();
    resetMultiModelSessions();
  }, [baseResetChat, resetMultiModelSessions]);

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
    ],
  );

  // Detect OAuth-required errors and notify parent
  useEffect(() => {
    if (!onOAuthRequired || !error) return;
    const msg = error instanceof Error ? error.message : String(error);

    // Try to parse structured error with oauthRequired flag
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.details?.oauthRequired) {
        onOAuthRequired({
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
      onOAuthRequired();
    }
  }, [error, onOAuthRequired]);

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
    if (hasContent && !inputDisabled) {
      // Build messages from MCP prompts
      const promptMessages = buildMcpPromptMessages(
        mcpPromptResults,
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
                text: `Widget ${toolCallId} context: ${JSON.stringify(context)}`,
              },
            ],
            metadata: {
              source: "widget-model-context",
              toolCallId,
            },
          }),
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

  const handleStarterPrompt = (prompt: string) => {
    if (submitBlocked || inputDisabled) {
      setInput(prompt);
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
    submitDisabled: submitBlocked,
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
    sandboxAttachableServers:
      sandboxOptionalInventory && sandboxOptionalInventory.length > 0
        ? sandboxOptionalInventory
        : undefined,
    onAttachSandboxServer: onEnableSandboxOptionalServer,
  };

  const showStarterPrompts =
    !showDisabledCallout && !effectiveHasMessages && !isAuthLoading;

  return (
    <div className="flex flex-1 h-full min-h-0 flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 h-full"
      >
        <ResizablePanel
          defaultSize={minimalMode ? 100 : isJsonRpcPanelVisible ? 70 : 100}
          minSize={40}
          className="min-w-0"
        >
          <div
            className="flex flex-col bg-background h-full min-h-0 overflow-hidden"
            style={{
              transform: isWidgetFullscreen ? "none" : "translateZ(0)",
            }}
          >
            {isMultiModelMode ? (
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
                    rawXRayMirror={{
                      payload: rawTraceXRayMirror.payload,
                      loading: rawTraceXRayMirror.loading,
                      error: rawTraceXRayMirror.error,
                      refetch: rawTraceXRayMirror.refetch,
                      hasUiMessages: rawTraceXRayMirror.hasMessages,
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
                    !effectiveHasMessages && "hidden",
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
                          "grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3",
                      )}
                    >
                      {resolvedSelectedModels.map((model) => (
                        <MultiModelChatCard
                          key={`${multiModelSessionGeneration}:${String(model.id)}`}
                          model={model}
                          comparisonSummaries={Object.values(
                            multiModelSummaries,
                          )}
                          selectedServers={selectedConnectedServerNames}
                          selectedServerInstructions={
                            selectedServerInstructions
                          }
                          broadcastRequest={broadcastRequest}
                          stopRequestId={stopBroadcastRequestId}
                          placeholder={placeholder}
                          reasoningDisplayMode={reasoningDisplayMode}
                          initialSystemPrompt={systemPrompt}
                          initialTemperature={temperature}
                          initialRequireToolApproval={requireToolApproval}
                          hostedWorkspaceId={effectiveHostedWorkspaceId}
                          hostedSelectedServerIds={
                            effectiveHostedSelectedServerIds
                          }
                          hostedOAuthTokens={effectiveHostedOAuthTokens}
                          hostedShareToken={hostedShareToken}
                          hostedSandboxToken={hostedSandboxToken}
                          hostedSandboxSurface={hostedSandboxSurface}
                          onOAuthRequired={onOAuthRequired}
                          onSummaryChange={handleMultiModelSummaryChange}
                          onHasMessagesChange={
                            handleMultiModelHasMessagesChange
                          }
                          showComparisonChrome={
                            resolvedSelectedModels.length > 1
                          }
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
                      {activeTraceViewMode === "raw" ? (
                        <StickToBottom
                          className="flex flex-1 min-h-0 flex-col overflow-hidden"
                          resize="smooth"
                          initial="smooth"
                        >
                          <div className="relative flex flex-1 min-h-0 overflow-hidden">
                            <StickToBottom.Content className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4">
                              <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
                                {isThreadEmpty ? (
                                  <LiveTraceRawEmptyState testId="chat-live-raw-pending" />
                                ) : (
                                  <TraceViewer
                                    trace={traceViewerTrace}
                                    model={selectedModel}
                                    toolsMetadata={toolsMetadata}
                                    toolServerMap={toolServerMap}
                                    traceStartedAtMs={
                                      liveTraceEnvelope?.traceStartedAtMs ??
                                      null
                                    }
                                    traceEndedAtMs={
                                      liveTraceEnvelope?.traceEndedAtMs ?? null
                                    }
                                    forcedViewMode={activeTraceViewMode}
                                    hideToolbar
                                    fillContent
                                    onRevealNavigateToChat={() => {
                                      setTraceViewMode("chat");
                                      setRevealedInChat(true);
                                    }}
                                    rawGrowWithContent
                                    rawXRayMirror={{
                                      payload: rawTraceXRayMirror.payload,
                                      loading: rawTraceXRayMirror.loading,
                                      error: rawTraceXRayMirror.error,
                                      refetch: rawTraceXRayMirror.refetch,
                                      hasUiMessages:
                                        rawTraceXRayMirror.hasMessages,
                                    }}
                                  />
                                )}
                              </div>
                            </StickToBottom.Content>
                            <ScrollToBottomButton />
                          </div>
                        </StickToBottom>
                      ) : (
                        <div className="flex min-h-64 flex-1 flex-col overflow-hidden px-4 py-4">
                          <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
                            {activeTraceViewMode === "timeline" &&
                            !hasLiveTimelineContent ? (
                              <LiveTraceTimelineEmptyState testId="chat-live-trace-pending" />
                            ) : (
                              <TraceViewer
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
                                forcedViewMode={activeTraceViewMode}
                                hideToolbar
                                fillContent
                                onRevealNavigateToChat={() => {
                                  setTraceViewMode("chat");
                                  setRevealedInChat(true);
                                }}
                                rawXRayMirror={{
                                  payload: rawTraceXRayMirror.payload,
                                  loading: rawTraceXRayMirror.loading,
                                  error: rawTraceXRayMirror.error,
                                  refetch: rawTraceXRayMirror.refetch,
                                  hasUiMessages: rawTraceXRayMirror.hasMessages,
                                }}
                              />
                            )}
                          </div>
                        </div>
                      )}

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
                          fullscreenChatDisabled={inputDisabled}
                          onToolApprovalResponse={addToolApprovalResponse}
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
                    <div className="flex-1 flex flex-col min-h-0">
                      <div className="flex-1 flex flex-col items-center justify-center px-4">
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

                      <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
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
                    <div className="flex-1 flex items-center justify-center overflow-y-auto px-4">
                      <div className="w-full max-w-3xl space-y-6 py-8">
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
    </div>
  );
}
