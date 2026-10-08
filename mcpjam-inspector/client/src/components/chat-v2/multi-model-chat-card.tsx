import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { UIMessage } from "ai";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { Thread } from "@/components/chat-v2/thread";
import type { ProjectThreadOwnerAvatar } from "@/components/chat-v2/history/project-thread-owner-avatar";
import type { ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import { ErrorBox } from "@/components/chat-v2/error";
import { useChangeProtocolVersionAction } from "@/hooks/use-change-protocol-version-action";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";
import {
  type MultiModelCardSummary,
  ModelCompareCardHeader,
} from "@/components/chat-v2/model-compare-card-header";
import {
  cloneUiMessages,
  formatErrorMessage,
} from "@/components/chat-v2/shared/chat-helpers";
import { useChatSession } from "@/hooks/use-chat-session";
import { getChatComposerInteractivity } from "@/hooks/use-chat-stop-controls";
import type { ModelDefinition } from "@/shared/types";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import { gateMcpToolResultImageRenderingByModelVisibility } from "@/lib/client-config-v2";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import type { TraceViewMode } from "@/components/evals/trace-view-mode-tabs";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import { applyWidgetStateUpdates } from "@/shared/user-context-message";
import { upsertWidgetModelContextEntry } from "@/lib/widget-model-context";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import {
  CompareCardEffort,
  type CompareCardEffortProps,
} from "@/components/chat-v2/compare-card-effort";

type ChatTraceViewMode = "chat" | "timeline" | "raw";

export interface BroadcastChatTurnRequest {
  id: number;
  text: string;
  files?: Array<{
    type: "file";
    mediaType: string;
    filename?: string;
    url: string;
  }>;
  prependMessages: UIMessage[];
  widgetModelContext?: WidgetModelContextEntry[];
}

interface MultiModelChatCardProps {
  model: ModelDefinition;
  /**
   * The card's identity (`comparisonKey` of its selection): keys summaries,
   * `hasMessages` and transcripts so two cards of one model at different
   * efforts never collide. Defaults to the model id.
   */
  compareId?: string;
  /** Header title; defaults to the model name ("Sonnet 5 · High"). */
  compareLabel?: string;
  /** This card's own effort, sent on its requests (undefined = Default). */
  reasoningEffort?: ModelReasoningEffort;
  /** This card's effort chip; omitted ⇒ none. */
  effort?: CompareCardEffortProps;
  comparisonSummaries: MultiModelCardSummary[];
  selectedServers: string[];
  selectedServerInstructions: Record<string, string>;
  broadcastRequest: BroadcastChatTurnRequest | null;
  stopRequestId: number;
  placeholder: string;
  reasoningDisplayMode: ReasoningDisplayMode;
  executionConfig: ExecutionConfig;
  hostedContext?: HostedRuntimeContext;
  onSummaryChange: (summary: MultiModelCardSummary) => void;
  onHasMessagesChange?: (modelId: string, hasMessages: boolean) => void;
  onOAuthRequired?: (details?: HostedOAuthRequiredDetails) => void;
  /** When false, hides per-card model title and Latency/Tokens/Tools (single selected model in compare mode). */
  showComparisonChrome?: boolean;
  /** Bumps when entering compare from single; hydrate once per bump when `compareEnterMessages` is non-empty. */
  compareEnterVersion?: number;
  compareEnterMessages?: UIMessage[];
  /** Seed a newly added compare column from the lead transcript. */
  addColumnSeed?: { version: number; messages: UIMessage[] } | null;
  onTranscriptSync?: (modelId: string, messages: UIMessage[]) => void;
  showSenderAvatars?: boolean;
  resolveSenderAvatar?: (senderUserId?: string) => ProjectThreadOwnerAvatar;
  outgoingSenderMetadata?: Record<string, unknown>;
}

export function MultiModelChatCard({
  model,
  compareId: compareIdProp,
  compareLabel,
  reasoningEffort,
  effort,
  comparisonSummaries,
  selectedServers,
  selectedServerInstructions,
  broadcastRequest,
  stopRequestId,
  placeholder,
  reasoningDisplayMode,
  executionConfig,
  hostedContext,
  onSummaryChange,
  onHasMessagesChange,
  onOAuthRequired,
  showComparisonChrome = true,
  compareEnterVersion = 0,
  compareEnterMessages = [],
  addColumnSeed = null,
  onTranscriptSync,
  showSenderAvatars = false,
  resolveSenderAvatar,
  outgoingSenderMetadata,
}: MultiModelChatCardProps) {
  const compareId = compareIdProp ?? String(model.id);
  const showEffort =
    !!effort && (effort.levels.length > 0 || effort.value !== undefined);
  const [widgetStateQueue, setWidgetStateQueue] = useState<
    { toolCallId: string; state: unknown }[]
  >([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    WidgetModelContextEntry[]
  >([]);
  const [, setIsWidgetFullscreen] = useState(false);
  const [traceViewMode, setTraceViewMode] = useState<ChatTraceViewMode>("chat");
  const [revealedInChat, setRevealedInChat] = useState(false);
  const lastBroadcastRequestIdRef = useRef<number | null>(null);
  const onSummaryChangeRef = useRef(onSummaryChange);
  const onHasMessagesChangeRef = useRef(onHasMessagesChange);
  const lastAddColumnVersionRef = useRef(0);
  const lastCompareEnterVersionRef = useRef(0);
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

  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    status,
    error,
    chatSessionId,
    toolsMetadata,
    toolServerMap,
    liveTraceEnvelope,
    requestPayloadHistory,
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    addToolApprovalResponse,
    startChatWithMessages,
  } = useChatSession({
    // A comparison column never shares the member's one personal computer.
    comparePane: true,
    selectedServers,
    hostedContext,
    executionConfig: {
      ...executionConfig,
      modelId: String(model.id),
      mcpToolResultImageRendering: effectiveMcpToolResultImageRendering,
    },
    // The card's own row and effort: two cards of one model send their own
    // levels, and an OpenRouter card never resolves to the hosted row.
    pinnedModelProvider: String(model.provider),
    reasoningEffortEnabled: true,
    fixedReasoningEffort: reasoningEffort ?? null,
    onReset: () => {
      setWidgetStateQueue([]);
      setModelContextQueue([]);
    },
  });

  const isThreadEmpty = !messages.some(
    (message) => message.role === "user" || message.role === "assistant"
  );
  const showTraceTabs = traceViewsSupported && !isThreadEmpty;
  const activeTraceViewMode: ChatTraceViewMode = showTraceTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const showTraceDiagnosticsShell = showLiveTraceDiagnostics || revealedInChat;

  const navigateTraceRevealToChat = useCallback(() => {
    setTraceViewMode("chat");
    setRevealedInChat(true);
  }, []);

  const handleTraceViewModeChange = useCallback((mode: TraceViewMode) => {
    if (mode === "tools") return;
    setTraceViewMode(mode);
    setRevealedInChat(false);
  }, []);
  const traceViewerTrace = liveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const errorMessage = formatErrorMessage(error);
  const changeProtocolVersionHandler = useChangeProtocolVersionAction({
    error: errorMessage,
    hostId: hostedContext?.hostId,
    location: "chat_compare_card",
  });
  const { sendBlocked: fullscreenChatSendBlocked } =
    getChatComposerInteractivity({
      isStreamingActive: isStreaming,
    });

  const latestTurn = liveTraceEnvelope?.turns?.at(-1);
  const summary = useMemo<MultiModelCardSummary>(
    () => ({
      modelId: compareId,
      durationMs: latestTurn?.durationMs ?? null,
      tokens: latestTurn?.usage?.totalTokens ?? 0,
      toolCount: latestTurn?.actualToolCalls?.length ?? 0,
      status: error
        ? "error"
        : isStreaming
        ? "running"
        : isThreadEmpty
        ? "idle"
        : "ready",
      hasMessages: !isThreadEmpty,
    }),
    [compareId, error, isStreaming, isThreadEmpty, latestTurn]
  );

  useEffect(() => {
    onSummaryChangeRef.current = onSummaryChange;
  }, [onSummaryChange]);

  useEffect(() => {
    onHasMessagesChangeRef.current = onHasMessagesChange;
  }, [onHasMessagesChange]);

  useEffect(() => {
    onSummaryChangeRef.current(summary);
  }, [summary]);

  useEffect(() => {
    onHasMessagesChangeRef.current?.(compareId, !isThreadEmpty);
  }, [compareId, isThreadEmpty]);

  useEffect(() => {
    onTranscriptSync?.(compareId, messages);
  }, [compareId, messages, onTranscriptSync]);

  useEffect(() => {
    if (
      addColumnSeed &&
      addColumnSeed.version > lastAddColumnVersionRef.current
    ) {
      lastAddColumnVersionRef.current = addColumnSeed.version;
      lastCompareEnterVersionRef.current = compareEnterVersion;
      if (addColumnSeed.messages.length > 0) {
        void startChatWithMessages(cloneUiMessages(addColumnSeed.messages));
      }
      return;
    }

    if (
      compareEnterVersion > 0 &&
      compareEnterVersion > lastCompareEnterVersionRef.current &&
      compareEnterMessages.length > 0
    ) {
      lastCompareEnterVersionRef.current = compareEnterVersion;
      void startChatWithMessages(cloneUiMessages(compareEnterMessages));
    }
  }, [
    addColumnSeed,
    compareEnterMessages,
    compareEnterVersion,
    startChatWithMessages,
  ]);

  useEffect(() => {
    if (!traceViewsSupported) {
      setTraceViewMode("chat");
      setRevealedInChat(false);
    }
  }, [traceViewsSupported]);

  useEffect(() => {
    setTraceViewMode("chat");
    setRevealedInChat(false);
  }, [chatSessionId]);

  useEffect(() => {
    setMessages((previous) => {
      const filtered = previous.filter(
        (message) =>
          !(
            message.role === "system" &&
            (message as { metadata?: { source?: string } })?.metadata
              ?.source === "server-instruction"
          )
      );

      const instructionMessages = Object.entries(selectedServerInstructions)
        .sort(([left], [right]) => left.localeCompare(right))
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

  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      if (status === "ready") {
        setMessages((previousMessages) =>
          applyWidgetStateUpdates(previousMessages, [{ toolCallId, state }])
        );
      } else {
        setWidgetStateQueue((previous) => [...previous, { toolCallId, state }]);
      }
    },
    [setMessages, status],
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) {
      return;
    }

    setMessages((previousMessages) =>
      applyWidgetStateUpdates(previousMessages, widgetStateQueue)
    );
    setWidgetStateQueue([]);
  }, [setMessages, status, widgetStateQueue]);

  useEffect(() => {
    if (!broadcastRequest) {
      return;
    }

    if (lastBroadcastRequestIdRef.current === broadcastRequest.id) {
      return;
    }

    lastBroadcastRequestIdRef.current = broadcastRequest.id;

    if (broadcastRequest.prependMessages.length > 0) {
      setMessages((previous) => [
        ...previous,
        ...(broadcastRequest.prependMessages as UIMessage[]),
      ]);
    }

    sendMessage({
      text: broadcastRequest.text,
      files: broadcastRequest.files,
      metadata: outgoingSenderMetadata,
      widgetModelContext: [
        ...(broadcastRequest.widgetModelContext ?? []),
        ...modelContextQueue,
      ],
    });
    setModelContextQueue([]);
  }, [
    broadcastRequest,
    modelContextQueue,
    sendMessage,
    setMessages,
    outgoingSenderMetadata,
  ]);

  useEffect(() => {
    if (stopRequestId <= 0) {
      return;
    }

    stop();
  }, [stop, stopRequestId]);

  const handleSendFollowUp = useCallback(
    (text: string) => {
      sendMessage({
        text,
        metadata: outgoingSenderMetadata,
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
    },
    [modelContextQueue, sendMessage, outgoingSenderMetadata]
  );

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

  useEffect(() => {
    if (!onOAuthRequired || !error) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);

    try {
      const parsed = JSON.parse(message);
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
      // Non-JSON error payloads are handled below.
    }

    const isOAuthError =
      message.includes("requires OAuth authentication") ||
      (message.includes("Authentication failed") &&
        message.includes("invalid_token"));

    if (isOAuthError) {
      onOAuthRequired();
    }
  }, [error, onOAuthRequired]);

  return (
    <div
      data-testid="multi-model-chat-card-root"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40"
    >
      <ModelCompareCardHeader
        model={model}
        compareLabel={compareLabel}
        summary={summary}
        allSummaries={comparisonSummaries}
        mode={activeTraceViewMode}
        onModeChange={handleTraceViewModeChange}
        showTraceTabs={showTraceTabs}
        showComparisonChrome={showComparisonChrome}
        titleAccessory={
          effort && showEffort ? (
            <CompareCardEffort model={model} {...effort} />
          ) : null
        }
      />
      {effort && showEffort && !showComparisonChrome ? (
        <div className="flex shrink-0 items-center justify-end border-b border-border/60 px-3 py-1">
          <CompareCardEffort model={model} {...effort} />
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {errorMessage ? (
          <div className="px-3 pt-3">
            <ErrorBox
              message={errorMessage.message}
              errorDetails={errorMessage.details}
              code={errorMessage.code}
              statusCode={errorMessage.statusCode}
              isRetryable={errorMessage.isRetryable}
              isMCPJamPlatformError={errorMessage.isMCPJamPlatformError}
              onChangeProtocolVersion={changeProtocolVersionHandler}
            />
          </div>
        ) : null}

        {showTraceDiagnosticsShell ? (
          activeTraceViewMode === "raw" ? (
            <StickToBottom
              className="flex flex-1 min-h-0 flex-col overflow-hidden"
              resize="smooth"
              initial="smooth"
            >
              <div className="relative flex min-h-64 flex-1 flex-col overflow-hidden p-3">
                <StickToBottom.Content className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                  <TraceViewer
                    chatSessionId={chatSessionId}
                    trace={traceViewerTrace}
                    model={model}
                    toolsMetadata={toolsMetadata}
                    toolServerMap={toolServerMap}
                    traceStartedAtMs={
                      liveTraceEnvelope?.traceStartedAtMs ?? null
                    }
                    traceEndedAtMs={liveTraceEnvelope?.traceEndedAtMs ?? null}
                    forcedViewMode={activeTraceViewMode}
                    hideToolbar
                    fillContent
                    onRevealNavigateToChat={navigateTraceRevealToChat}
                    onFullscreenChange={setIsWidgetFullscreen}
                    rawGrowWithContent
                    rawRequestPayloadHistory={{
                      entries: requestPayloadHistory,
                      hasUiMessages: !isThreadEmpty,
                    }}
                  />
                </StickToBottom.Content>
                <ScrollToBottomButton />
              </div>
            </StickToBottom>
          ) : activeTraceViewMode === "chat" && revealedInChat ? (
            <div className="flex flex-1 min-h-0 flex-col">
              <div className="flex min-h-64 flex-1 flex-col overflow-hidden p-3">
                <TraceViewer
                  chatSessionId={chatSessionId}
                  trace={traceViewerTrace}
                  model={model}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  traceStartedAtMs={liveTraceEnvelope?.traceStartedAtMs ?? null}
                  traceEndedAtMs={liveTraceEnvelope?.traceEndedAtMs ?? null}
                  forcedViewMode="chat"
                  hideToolbar
                  fillContent
                  onRevealNavigateToChat={navigateTraceRevealToChat}
                  sendFollowUpMessage={handleSendFollowUp}
                  enableFullscreenChatOverlay
                  fullscreenChatPlaceholder={placeholder}
                  fullscreenChatSendBlocked={fullscreenChatSendBlocked}
                  onFullscreenChatStop={stop}
                  onFullscreenChange={setIsWidgetFullscreen}
                  onModelContextUpdate={handleModelContextUpdate}
                  onToolApprovalResponse={addToolApprovalResponse}
                  rawRequestPayloadHistory={{
                    entries: requestPayloadHistory,
                    hasUiMessages: !isThreadEmpty,
                  }}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-1 min-h-0 flex-col">
              <div className="flex min-h-64 flex-1 flex-col overflow-hidden p-3">
                {activeTraceViewMode === "timeline" &&
                !hasLiveTimelineContent ? (
                  <LiveTraceTimelineEmptyState
                    testId={`multi-model-live-trace-pending-${compareId}`}
                  />
                ) : (
                  <TraceViewer
                    chatSessionId={chatSessionId}
                    trace={traceViewerTrace}
                    model={model}
                    toolsMetadata={toolsMetadata}
                    toolServerMap={toolServerMap}
                    traceStartedAtMs={
                      liveTraceEnvelope?.traceStartedAtMs ?? null
                    }
                    traceEndedAtMs={liveTraceEnvelope?.traceEndedAtMs ?? null}
                    forcedViewMode={activeTraceViewMode}
                    hideToolbar
                    fillContent
                    onRevealNavigateToChat={navigateTraceRevealToChat}
                    onFullscreenChange={setIsWidgetFullscreen}
                    rawRequestPayloadHistory={{
                      entries: requestPayloadHistory,
                      hasUiMessages: !isThreadEmpty,
                    }}
                  />
                )}
              </div>
            </div>
          )
        ) : isThreadEmpty ? (
          <div className="flex flex-1 items-center justify-center px-6 py-8 text-center text-sm text-muted-foreground">
            Send a shared message to start this model’s thread.
          </div>
        ) : (
          <StickToBottom
            className="relative flex flex-1 flex-col min-h-0 animate-in fade-in duration-300"
            resize="smooth"
            initial="smooth"
          >
            <div className="relative flex-1 min-h-0">
              <StickToBottom.Content className="flex flex-col min-h-0">
                <Thread
                  chatSessionId={chatSessionId}
                  messages={messages}
                  sendFollowUpMessage={handleSendFollowUp}
                  model={model}
                  isLoading={isStreaming}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  onWidgetStateChange={handleWidgetStateChange}
                  onModelContextUpdate={handleModelContextUpdate}
                  onFullscreenChange={setIsWidgetFullscreen}
                  enableFullscreenChatOverlay
                  fullscreenChatPlaceholder={placeholder}
                  fullscreenChatSendBlocked={fullscreenChatSendBlocked}
                  onFullscreenChatStop={stop}
                  onToolApprovalResponse={addToolApprovalResponse}
                  reasoningDisplayMode={reasoningDisplayMode}
                  mcpToolResultImageRendering={
                    effectiveMcpToolResultImageRendering
                  }
                  showSenderAvatars={showSenderAvatars}
                  resolveSenderAvatar={resolveSenderAvatar}
                />
              </StickToBottom.Content>
              <ScrollToBottomButton />
            </div>
          </StickToBottom>
        )}
      </div>
    </div>
  );
}
