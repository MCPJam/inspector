import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
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
import { formatErrorMessage } from "@/components/chat-v2/shared/chat-helpers";
import { useChatSession } from "@/hooks/use-chat-session";
import { useDebouncedXRayPayload } from "@/hooks/use-debounced-x-ray-payload";
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

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center animate-in slide-in-from-bottom fade-in duration-200">
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
  const lastBroadcastRequestIdRef = useRef<number | null>(null);
  const onSummaryChangeRef = useRef(onSummaryChange);
  const onHasMessagesChangeRef = useRef(onHasMessagesChange);

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
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    addToolApprovalResponse,
    systemPrompt,
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
  const traceViewerTrace = liveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const cardRawXRayMirror = useDebouncedXRayPayload({
    systemPrompt,
    messages,
    selectedServers,
    enabled: showLiveTraceDiagnostics && !isThreadEmpty && traceViewsSupported,
  });
  const errorMessage = formatErrorMessage(error);

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
    if (!traceViewsSupported) {
      setTraceViewMode("chat");
    }
  }, [traceViewsSupported]);

  useEffect(() => {
    setTraceViewMode("chat");
  }, [chatSessionId]);

  useEffect(() => {
    setMessages((previous) => {
      const filtered = previous.filter(
        (message) =>
          !(
            message.role === "system" &&
            (message as { metadata?: { source?: string } })?.metadata?.source ===
              "server-instruction"
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
          nextMessages = nextMessages.filter((message) => message.id !== messageId);
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
        const filtered = previous.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  const queueContextMessages = useCallback(() => {
    const contextMessages = modelContextQueue.map(({ toolCallId, context }) => ({
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
    }));

    if (contextMessages.length > 0) {
      setMessages((previous) => [...previous, ...(contextMessages as UIMessage[])]);
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
        onModeChange={setTraceViewMode}
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

        {showLiveTraceDiagnostics ? (
          activeTraceViewMode === "raw" ? (
            <StickToBottom
              className="flex flex-1 min-h-0 flex-col animate-in fade-in duration-300 overflow-hidden"
              resize="smooth"
              initial="smooth"
            >
              <div className="relative flex flex-1 min-h-0 overflow-hidden p-3">
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
                    hideTranscriptRevealControls
                    rawGrowWithContent
                    rawXRayMirror={{
                      payload: cardRawXRayMirror.payload,
                      loading: cardRawXRayMirror.loading,
                      error: cardRawXRayMirror.error,
                      refetch: cardRawXRayMirror.refetch,
                      hasUiMessages: cardRawXRayMirror.hasMessages,
                    }}
                  />
                </StickToBottom.Content>
                <ScrollToBottomButton />
              </div>
            </StickToBottom>
          ) : (
            <div className="flex flex-1 min-h-0 flex-col animate-in fade-in duration-300">
              <div className="flex-1 min-h-0 overflow-hidden p-3">
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
                    hideTranscriptRevealControls
                    rawXRayMirror={{
                      payload: cardRawXRayMirror.payload,
                      loading: cardRawXRayMirror.loading,
                      error: cardRawXRayMirror.error,
                      refetch: cardRawXRayMirror.refetch,
                      hasUiMessages: cardRawXRayMirror.hasMessages,
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
                  isLoading={status === "submitted"}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  onWidgetStateChange={handleWidgetStateChange}
                  onModelContextUpdate={handleModelContextUpdate}
                  onFullscreenChange={setIsWidgetFullscreen}
                  enableFullscreenChatOverlay
                  fullscreenChatPlaceholder={placeholder}
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
