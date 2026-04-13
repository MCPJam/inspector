import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { UIMessage } from "ai";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { Thread } from "@/components/chat-v2/thread";
import type { ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import { ErrorBox } from "@/components/chat-v2/error";
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
}

interface MultiModelChatCardProps {
  model: ModelDefinition;
  comparisonSummaries: MultiModelCardSummary[];
  selectedServers: string[];
  selectedServerInstructions: Record<string, string>;
  broadcastRequest: BroadcastChatTurnRequest | null;
  stopRequestId: number;
  placeholder: string;
  reasoningDisplayMode: ReasoningDisplayMode;
  initialSystemPrompt: string;
  initialTemperature: number;
  initialRequireToolApproval: boolean;
  hostedWorkspaceId?: string | null;
  hostedSelectedServerIds?: string[];
  hostedOAuthTokens?: Record<string, string>;
  hostedShareToken?: string;
  hostedSandboxToken?: string;
  hostedSandboxSurface?: "preview" | "share_link";
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
}

export function MultiModelChatCard({
  model,
  comparisonSummaries,
  selectedServers,
  selectedServerInstructions,
  broadcastRequest,
  stopRequestId,
  placeholder,
  reasoningDisplayMode,
  initialSystemPrompt,
  initialTemperature,
  initialRequireToolApproval,
  hostedWorkspaceId,
  hostedSelectedServerIds,
  hostedOAuthTokens,
  hostedShareToken,
  hostedSandboxToken,
  hostedSandboxSurface,
  onSummaryChange,
  onHasMessagesChange,
  onOAuthRequired,
  showComparisonChrome = true,
  compareEnterVersion = 0,
  compareEnterMessages = [],
  addColumnSeed = null,
  onTranscriptSync,
}: MultiModelChatCardProps) {
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
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
  const [traceViewMode, setTraceViewMode] = useState<ChatTraceViewMode>("chat");
  const [revealedInChat, setRevealedInChat] = useState(false);
  const lastBroadcastRequestIdRef = useRef<number | null>(null);
  const onSummaryChangeRef = useRef(onSummaryChange);
  const onHasMessagesChangeRef = useRef(onHasMessagesChange);
  const lastAddColumnVersionRef = useRef(0);
  const lastCompareEnterVersionRef = useRef(0);

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
    selectedServers,
    hostedWorkspaceId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    hostedShareToken,
    hostedSandboxToken,
    hostedSandboxSurface,
    initialModelId: String(model.id),
    initialSystemPrompt,
    initialTemperature,
    initialRequireToolApproval,
    onReset: () => {
      setWidgetStateQueue([]);
      setModelContextQueue([]);
    },
  });

  const isThreadEmpty = !messages.some(
    (message) => message.role === "user" || message.role === "assistant",
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

  const handleTraceViewModeChange = useCallback((mode: ChatTraceViewMode) => {
    setTraceViewMode(mode);
    setRevealedInChat(false);
  }, []);
  const traceViewerTrace = liveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const errorMessage = formatErrorMessage(error);
  const { sendBlocked: fullscreenChatSendBlocked } =
    getChatComposerInteractivity({
      isStreamingActive: isStreaming,
    });

  const latestTurn = liveTraceEnvelope?.turns?.at(-1);
  const summary = useMemo<MultiModelCardSummary>(
    () => ({
      modelId: String(model.id),
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
    [error, isStreaming, isThreadEmpty, latestTurn, model.id],
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
    onHasMessagesChangeRef.current?.(String(model.id), !isThreadEmpty);
  }, [isThreadEmpty, model.id]);

  useEffect(() => {
    onTranscriptSync?.(String(model.id), messages);
  }, [messages, model.id, onTranscriptSync]);

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
          ),
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

  const applyWidgetStateUpdates = useCallback(
    (
      previousMessages: typeof messages,
      updates: { toolCallId: string; state: unknown }[],
    ) => {
      let nextMessages = previousMessages;

      for (const { toolCallId, state } of updates) {
        const messageId = `widget-state-${toolCallId}`;

        if (state === null) {
          nextMessages = nextMessages.filter(
            (message) => message.id !== messageId,
          );
          continue;
        }

        const stateText = `The state of widget ${toolCallId} is: ${JSON.stringify(state)}`;
        const existingIndex = nextMessages.findIndex(
          (message) => message.id === messageId,
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
        setMessages((previousMessages) =>
          applyWidgetStateUpdates(previousMessages, [{ toolCallId, state }]),
        );
      } else {
        setWidgetStateQueue((previous) => [...previous, { toolCallId, state }]);
      }
    },
    [applyWidgetStateUpdates, setMessages, status],
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) {
      return;
    }

    setMessages((previousMessages) =>
      applyWidgetStateUpdates(previousMessages, widgetStateQueue),
    );
    setWidgetStateQueue([]);
  }, [applyWidgetStateUpdates, setMessages, status, widgetStateQueue]);

  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      },
    ) => {
      setModelContextQueue((previous) => {
        const filtered = previous.filter(
          (item) => item.toolCallId !== toolCallId,
        );
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  const queueContextMessages = useCallback(() => {
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
      setMessages((previous) => [
        ...previous,
        ...(contextMessages as UIMessage[]),
      ]);
      setModelContextQueue([]);
    }
  }, [modelContextQueue, setMessages]);

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

    queueContextMessages();
    sendMessage({
      text: broadcastRequest.text,
      files: broadcastRequest.files,
    });
  }, [broadcastRequest, queueContextMessages, sendMessage, setMessages]);

  useEffect(() => {
    if (stopRequestId <= 0) {
      return;
    }

    stop();
  }, [stop, stopRequestId]);

  const handleSendFollowUp = useCallback(
    (text: string) => {
      queueContextMessages();
      sendMessage({ text });
    },
    [queueContextMessages, sendMessage],
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
    <div className="flex h-full min-h-[28rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40">
      <ModelCompareCardHeader
        model={model}
        summary={summary}
        allSummaries={comparisonSummaries}
        mode={activeTraceViewMode}
        onModeChange={handleTraceViewModeChange}
        showTraceTabs={showTraceTabs}
        showComparisonChrome={showComparisonChrome}
      />

      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={{
          transform: isWidgetFullscreen ? "none" : "translateZ(0)",
        }}
      >
        {errorMessage ? (
          <div className="px-3 pt-3">
            <ErrorBox
              message={errorMessage.message}
              errorDetails={errorMessage.details}
              code={errorMessage.code}
              statusCode={errorMessage.statusCode}
              isRetryable={errorMessage.isRetryable}
              isMCPJamPlatformError={errorMessage.isMCPJamPlatformError}
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
                    testId={`multi-model-live-trace-pending-${String(model.id)}`}
                  />
                ) : (
                  <TraceViewer
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
