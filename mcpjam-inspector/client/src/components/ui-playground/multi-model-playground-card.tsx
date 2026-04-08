import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Braces, Loader2 } from "lucide-react";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { UIMessage } from "ai";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import { Thread } from "@/components/chat-v2/thread";
import type { ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import { ErrorBox } from "@/components/chat-v2/error";
import { formatErrorMessage } from "@/components/chat-v2/shared/chat-helpers";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import {
  type MultiModelCardSummary,
  ModelCompareCardHeader,
} from "@/components/chat-v2/model-compare-card-header";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";
import { useChatSession } from "@/hooks/use-chat-session";
import { useDebouncedXRayPayload } from "@/hooks/use-debounced-x-ray-payload";
import { createDeterministicToolMessages } from "@/components/ui-playground/playground-helpers";
import {
  buildPreludeTraceEnvelope,
  type PreludeTraceExecution,
} from "@/components/ui-playground/live-trace-prelude";
import {
  SandboxHostStyleProvider,
  SandboxHostThemeProvider,
} from "@/contexts/sandbox-host-style-context";
import { CHATGPT_CHAT_BACKGROUND } from "@/config/chatgpt-host-context";
import { CLAUDE_DESKTOP_CHAT_BACKGROUND } from "@/config/claude-desktop-host-context";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import type { DeviceType, DisplayMode, HostStyle } from "@/stores/ui-playground-store";
import type { BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";

type PlaygroundTraceViewMode = "chat" | "timeline" | "raw";
type ThreadThemeMode = "light" | "dark";

export interface PlaygroundDeterministicExecutionRequest {
  id: number;
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  toolMeta: Record<string, unknown> | undefined;
  state?: "output-available" | "output-error";
  errorText?: string;
  renderOverride?: ToolRenderOverride;
  toolCallId: string;
  replaceExisting?: boolean;
}


function InvokingIndicator({
  toolName,
  customMessage,
}: {
  toolName: string;
  customMessage?: string | null;
}) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Braces className="h-4 w-4 shrink-0 text-muted-foreground" />
        {customMessage ? (
          <span>{customMessage}</span>
        ) : (
          <>
            <span>Invoking</span>
            <code className="font-mono text-primary">{toolName}</code>
          </>
        )}
        <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />
      </div>
    </div>
  );
}

interface MultiModelPlaygroundCardProps {
  model: ModelDefinition;
  comparisonSummaries: MultiModelCardSummary[];
  selectedServers: string[];
  broadcastRequest: BroadcastChatTurnRequest | null;
  deterministicExecutionRequest: PlaygroundDeterministicExecutionRequest | null;
  stopRequestId: number;
  reasoningDisplayMode?: ReasoningDisplayMode;
  initialSystemPrompt: string;
  initialTemperature: number;
  initialRequireToolApproval: boolean;
  hostedWorkspaceId?: string | null;
  hostedSelectedServerIds?: string[];
  hostedOAuthTokens?: Record<string, string>;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  hostStyle: HostStyle;
  effectiveThreadTheme: ThreadThemeMode;
  deviceType: DeviceType;
  selectedProtocol: UIType | null;
  hideSaveViewButton?: boolean;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  isExecuting?: boolean;
  executingToolName?: string | null;
  invokingMessage?: string | null;
  onSummaryChange: (summary: MultiModelCardSummary) => void;
  onHasMessagesChange?: (modelId: string, hasMessages: boolean) => void;
  /** When false, hides per-card model title and Latency/Tokens/Tools (single selected model in compare mode). */
  showComparisonChrome?: boolean;
  /** Hide in-card “send a shared message” empty hint when the parent shows the shared starter strip + footer composer. */
  suppressThreadEmptyHint?: boolean;
}

export function MultiModelPlaygroundCard({
  model,
  comparisonSummaries,
  selectedServers,
  broadcastRequest,
  deterministicExecutionRequest,
  stopRequestId,
  reasoningDisplayMode = "inline",
  initialSystemPrompt,
  initialTemperature,
  initialRequireToolApproval,
  hostedWorkspaceId,
  hostedSelectedServerIds,
  hostedOAuthTokens,
  displayMode,
  onDisplayModeChange,
  hostStyle,
  effectiveThreadTheme,
  deviceType,
  selectedProtocol,
  hideSaveViewButton = false,
  onWidgetStateChange,
  toolRenderOverrides = {},
  isExecuting = false,
  executingToolName,
  invokingMessage,
  onSummaryChange,
  onHasMessagesChange,
  showComparisonChrome = true,
  suppressThreadEmptyHint = false,
}: MultiModelPlaygroundCardProps) {
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [traceViewMode, setTraceViewMode] =
    useState<PlaygroundTraceViewMode>("chat");
  const [revealedInChat, setRevealedInChat] = useState(false);
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
  const [preludeTraceExecutions, setPreludeTraceExecutions] = useState<
    PreludeTraceExecution[]
  >([]);
  const [injectedToolRenderOverrides, setInjectedToolRenderOverrides] =
    useState<Record<string, ToolRenderOverride>>({});
  const lastBroadcastRequestIdRef = useRef<number | null>(null);
  const lastExecutionRequestIdRef = useRef<number | null>(null);
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
    hasTraceSnapshot,
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
    initialModelId: String(model.id),
    initialSystemPrompt,
    initialTemperature,
    initialRequireToolApproval,
    onReset: () => {
      setModelContextQueue([]);
      setPreludeTraceExecutions([]);
      setInjectedToolRenderOverrides({});
    },
  });

  const isThreadEmpty = !messages.some(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const preludeTraceEnvelope = useMemo(
    () => buildPreludeTraceEnvelope(preludeTraceExecutions),
    [preludeTraceExecutions],
  );
  const effectiveLiveTraceEnvelope = hasTraceSnapshot
    ? liveTraceEnvelope
    : preludeTraceEnvelope ?? liveTraceEnvelope;
  const showTraceTabs = traceViewsSupported && !isThreadEmpty;
  const activeTraceViewMode: PlaygroundTraceViewMode = showTraceTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const showTraceDiagnosticsShell =
    showLiveTraceDiagnostics || revealedInChat;

  const navigateTraceRevealToChat = useCallback(() => {
    setTraceViewMode("chat");
    setRevealedInChat(true);
  }, []);

  const handleTraceViewModeChange = useCallback((mode: PlaygroundTraceViewMode) => {
    setTraceViewMode(mode);
    setRevealedInChat(false);
  }, []);

  const showLiveTracePending =
    activeTraceViewMode === "timeline" &&
    !hasLiveTimelineContent &&
    !preludeTraceEnvelope?.spans?.length;
  const traceViewerTrace = effectiveLiveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const playgroundCardRawXRay = useDebouncedXRayPayload({
    systemPrompt,
    messages,
    selectedServers,
    enabled: showLiveTraceDiagnostics && !isThreadEmpty && traceViewsSupported,
  });
  const latestTurn = effectiveLiveTraceEnvelope?.turns?.at(-1);
  const summary = useMemo<MultiModelCardSummary>(
    () => ({
      modelId: String(model.id),
      durationMs: latestTurn?.durationMs ?? null,
      tokens: latestTurn?.usage?.totalTokens ?? 0,
      toolCount: latestTurn?.actualToolCalls?.length ?? 0,
      status: error
        ? "error"
        : isStreaming || isExecuting
          ? "running"
          : isThreadEmpty
            ? "idle"
            : "ready",
      hasMessages: !isThreadEmpty,
    }),
    [error, isExecuting, isStreaming, isThreadEmpty, latestTurn, model.id],
  );
  const errorMessage = formatErrorMessage(error);
  const mergedToolRenderOverrides = useMemo(
    () => ({
      ...injectedToolRenderOverrides,
      ...toolRenderOverrides,
    }),
    [injectedToolRenderOverrides, toolRenderOverrides],
  );
  const chatBg =
    hostStyle === "chatgpt"
      ? CHATGPT_CHAT_BACKGROUND
      : CLAUDE_DESKTOP_CHAT_BACKGROUND;
  const hostBackgroundColor = chatBg[effectiveThreadTheme];
  const isMobileFullTakeover =
    deviceType === "mobile" &&
    (displayMode === "fullscreen" || displayMode === "pip");
  const isTabletFullscreenTakeover =
    deviceType === "tablet" && displayMode === "fullscreen";
  const shellHeightClass =
    isMobileFullTakeover || isTabletFullscreenTakeover
      ? "min-h-[34rem]"
      : "min-h-[32rem]";

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
      setRevealedInChat(false);
    }
  }, [traceViewsSupported]);

  useEffect(() => {
    setTraceViewMode("chat");
    setRevealedInChat(false);
    setPreludeTraceExecutions([]);
    setInjectedToolRenderOverrides({});
  }, [chatSessionId]);

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
    if (!deterministicExecutionRequest) {
      return;
    }

    if (lastExecutionRequestIdRef.current === deterministicExecutionRequest.id) {
      return;
    }

    lastExecutionRequestIdRef.current = deterministicExecutionRequest.id;

    const deterministicOptions =
      deterministicExecutionRequest.state === "output-error"
        ? {
            state: "output-error" as const,
            errorText: deterministicExecutionRequest.errorText,
            toolCallId: deterministicExecutionRequest.toolCallId,
          }
        : {
            toolCallId: deterministicExecutionRequest.toolCallId,
          };
    const { messages: newMessages } = createDeterministicToolMessages(
      deterministicExecutionRequest.toolName,
      deterministicExecutionRequest.params,
      deterministicExecutionRequest.result,
      deterministicExecutionRequest.toolMeta,
      deterministicOptions,
    );

    if (deterministicExecutionRequest.renderOverride) {
      setInjectedToolRenderOverrides((previous) => ({
        ...previous,
        [deterministicExecutionRequest.toolCallId]:
          deterministicExecutionRequest.renderOverride!,
      }));
    }

    const upsertById = (
      currentMessages: typeof newMessages,
      nextMessage: (typeof newMessages)[number],
    ) => {
      const existingIndex = currentMessages.findIndex(
        (message) => message.id === nextMessage.id,
      );
      if (existingIndex === -1) {
        return [...currentMessages, nextMessage];
      }
      const copy = [...currentMessages];
      copy[existingIndex] = nextMessage;
      return copy;
    };

    if (
      deterministicExecutionRequest.replaceExisting &&
      deterministicExecutionRequest.toolCallId
    ) {
      setMessages((previous) => {
        let next = [...previous];
        for (const message of newMessages) {
          next = upsertById(next as typeof newMessages, message) as typeof previous;
        }
        return next;
      });
    } else {
      setMessages((previous) => [...previous, ...newMessages]);
    }

    if (hasTraceSnapshot) {
      return;
    }

    setPreludeTraceExecutions((previous) => {
      const nextExecution: PreludeTraceExecution = {
        toolCallId: deterministicExecutionRequest.toolCallId,
        toolName: deterministicExecutionRequest.toolName,
        params: deterministicExecutionRequest.params,
        result: deterministicExecutionRequest.result,
        state:
          deterministicExecutionRequest.state === "output-error"
            ? "output-error"
            : "output-available",
        errorText: deterministicExecutionRequest.errorText,
      };

      if (
        deterministicExecutionRequest.replaceExisting &&
        deterministicExecutionRequest.toolCallId
      ) {
        return previous.map((execution) =>
          execution.toolCallId === deterministicExecutionRequest.toolCallId
            ? nextExecution
            : execution,
        );
      }

      return [...previous, nextExecution];
    });
  }, [deterministicExecutionRequest, hasTraceSnapshot, setMessages]);

  useEffect(() => {
    if (hasTraceSnapshot) {
      setPreludeTraceExecutions([]);
    }
  }, [hasTraceSnapshot]);

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

  return (
    <div className="flex h-full min-h-[34rem] min-w-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40">
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
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-64 flex-1 flex-col overflow-hidden p-3">
              {activeTraceViewMode === "chat" && revealedInChat ? (
                <TraceViewer
                  trace={traceViewerTrace}
                  model={model}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  traceStartedAtMs={
                    effectiveLiveTraceEnvelope?.traceStartedAtMs ?? null
                  }
                  traceEndedAtMs={
                    effectiveLiveTraceEnvelope?.traceEndedAtMs ?? null
                  }
                  forcedViewMode="chat"
                  hideToolbar
                  fillContent
                  onRevealNavigateToChat={navigateTraceRevealToChat}
                  sendFollowUpMessage={handleSendFollowUp}
                  displayMode={displayMode}
                  onDisplayModeChange={onDisplayModeChange}
                  selectedProtocolOverrideIfBothExists={
                    selectedProtocol ?? undefined
                  }
                  onWidgetStateChange={onWidgetStateChange}
                  onModelContextUpdate={handleModelContextUpdate}
                  enableFullscreenChatOverlay
                  fullscreenChatPlaceholder="Message…"
                  onToolApprovalResponse={addToolApprovalResponse}
                  rawXRayMirror={{
                    payload: playgroundCardRawXRay.payload,
                    loading: playgroundCardRawXRay.loading,
                    error: playgroundCardRawXRay.error,
                    refetch: playgroundCardRawXRay.refetch,
                    hasUiMessages: playgroundCardRawXRay.hasMessages,
                  }}
                />
              ) : showLiveTracePending ? (
                <LiveTraceTimelineEmptyState
                  testId={`playground-live-trace-pending-${String(model.id)}`}
                />
              ) : (
                <TraceViewer
                  trace={traceViewerTrace}
                  model={model}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  traceStartedAtMs={
                    effectiveLiveTraceEnvelope?.traceStartedAtMs ?? null
                  }
                  traceEndedAtMs={
                    effectiveLiveTraceEnvelope?.traceEndedAtMs ?? null
                  }
                  forcedViewMode={activeTraceViewMode}
                  hideToolbar
                  fillContent
                  onRevealNavigateToChat={navigateTraceRevealToChat}
                  rawXRayMirror={{
                    payload: playgroundCardRawXRay.payload,
                    loading: playgroundCardRawXRay.loading,
                    error: playgroundCardRawXRay.error,
                    refetch: playgroundCardRawXRay.refetch,
                    hasUiMessages: playgroundCardRawXRay.hasMessages,
                  }}
                />
              )}
            </div>
          </div>
        ) : (
          <SandboxHostStyleProvider value={hostStyle}>
            <SandboxHostThemeProvider value={effectiveThreadTheme}>
              <div
                className={cn(
                  "sandbox-host-shell app-theme-scope relative m-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.25rem] border border-border/50",
                  shellHeightClass,
                  effectiveThreadTheme === "dark" && "dark",
                )}
                data-host-style={hostStyle}
                data-thread-theme={effectiveThreadTheme}
                style={{
                  backgroundColor: hostBackgroundColor,
                }}
              >
                {isThreadEmpty ? (
                  suppressThreadEmptyHint ? (
                    <div
                      className="min-h-[8rem] flex-1"
                      aria-hidden
                    />
                  ) : (
                    <div className="flex flex-1 items-center justify-center px-6 py-8 text-center text-sm text-muted-foreground">
                      Send a shared message to start this model’s thread.
                    </div>
                  )
                ) : (
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
                          model={model}
                          isLoading={status === "submitted"}
                          toolsMetadata={toolsMetadata}
                          toolServerMap={toolServerMap}
                          onWidgetStateChange={onWidgetStateChange}
                          onModelContextUpdate={handleModelContextUpdate}
                          displayMode={displayMode}
                          onDisplayModeChange={onDisplayModeChange}
                          onFullscreenChange={setIsWidgetFullscreen}
                          selectedProtocolOverrideIfBothExists={
                            selectedProtocol ?? undefined
                          }
                          onToolApprovalResponse={addToolApprovalResponse}
                          toolRenderOverrides={mergedToolRenderOverrides}
                          showSaveViewButton={!hideSaveViewButton}
                          reasoningDisplayMode={reasoningDisplayMode}
                        />
                        {isExecuting && executingToolName ? (
                          <InvokingIndicator
                            toolName={executingToolName}
                            customMessage={invokingMessage}
                          />
                        ) : null}
                      </StickToBottom.Content>
                      <ScrollToBottomButton />
                    </div>
                  </StickToBottom>
                )}
              </div>
            </SandboxHostThemeProvider>
          </SandboxHostStyleProvider>
        )}
      </div>
    </div>
  );
}
