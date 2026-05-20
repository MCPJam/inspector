import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Braces, Loader2 } from "lucide-react";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { UIMessage } from "ai";
import { cn } from "@/lib/utils";
import type { ModelDefinition } from "@/shared/types";
import { Thread } from "@/components/chat-v2/thread";
import type { ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import { ErrorBox } from "@/components/chat-v2/error";
import {
  cloneUiMessages,
  formatErrorMessage,
} from "@/components/chat-v2/shared/chat-helpers";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import {
  type MultiModelCardSummary,
  ModelCompareCardHeader,
} from "@/components/chat-v2/model-compare-card-header";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";
import { useChatSession } from "@/hooks/use-chat-session";
import { getChatComposerInteractivity } from "@/hooks/use-chat-stop-controls";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import { createDeterministicToolMessages } from "@/components/ui-playground/playground-helpers";
import {
  buildPreludeTraceEnvelope,
  type PreludeTraceExecution,
} from "@/components/ui-playground/live-trace-prelude";
import {
  ChatboxChatUiOverrideProvider,
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
  useChatboxChatUiOverride,
} from "@/contexts/chatbox-client-style-context";
import {
  ChatboxHostCapabilitiesOverrideProvider,
  useChatboxHostCapabilitiesOverride,
} from "@/contexts/chatbox-client-capabilities-override-context";
import {
  ActiveMcpProfileProvider,
  useActiveMcpProfile,
} from "@/contexts/active-mcp-profile-context";
import { ActiveHostCapsResolverScope } from "@/contexts/active-host-client-capabilities-context";
import type { ChatUiOverride } from "@/lib/client-styles";
import type {
  HostConfigDtoV2,
  HostConfigMcpProfileV1,
} from "@/lib/client-config-v2";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import {
  getChatboxChatBackground,
  type ChatboxHostStyle,
} from "@/lib/chatbox-client-style";
import type { DeviceType, DisplayMode } from "@/stores/ui-playground-store";
import type { BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";
import type { TraceViewMode } from "@/components/evals/trace-view-mode-tabs";

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
  /**
   * Polymorphic column identity (Phase 3 of the multi-host plan). In model
   * mode `compareId === String(model.id)`; in host mode it's the host id.
   * The card uses `compareId` to key transcripts/summaries/`hasMessages`
   * callbacks so two columns running the same default model can't collide.
   */
  compareId: string;
  /** Visible title rendered in the card header. */
  compareLabel: string;
  compareKind: "model" | "host";
  /**
   * Secondary line under the title. In model mode this is undefined; in
   * host mode it's the resolved model name (so users see which model the
   * host is running).
   */
  compareSubLabel?: string;
  model: ModelDefinition;
  comparisonSummaries: MultiModelCardSummary[];
  selectedServers: string[];
  broadcastRequest: BroadcastChatTurnRequest | null;
  deterministicExecutionRequest: PlaygroundDeterministicExecutionRequest | null;
  stopRequestId: number;
  reasoningDisplayMode?: ReasoningDisplayMode;
  executionConfig: ExecutionConfig;
  hostedContext?: HostedRuntimeContext;
  hostedOrgModelConfig?: OrgVisibleConfig;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  hostStyle: ChatboxHostStyle;
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
  onHasMessagesChange?: (compareId: string, hasMessages: boolean) => void;
  /** When false, hides per-card model title and Latency/Tokens/Tools (single selected model in compare mode). */
  showComparisonChrome?: boolean;
  /** Hide in-card “send a shared message” empty hint when the parent shows the shared starter strip + footer composer. */
  suppressThreadEmptyHint?: boolean;
  compareEnterVersion?: number;
  compareEnterMessages?: UIMessage[];
  addColumnSeed?: { version: number; messages: UIMessage[] } | null;
  onTranscriptSync?: (compareId: string, messages: UIMessage[]) => void;
  /**
   * Optional per-card host-snapshot props (Phase 3 plumbing for Phase 4
   * multi-host render path). When undefined, the card falls back to the
   * tab-root provider value via `useContext` so model-mode callers don't
   * need to thread these. When defined, the card's inner provider shadows
   * the tab-root one so per-column overrides apply to trace + raw views
   * (not just chat — this is the whole point of the Phase 3 lift).
   *
   * NOTE: `hostCapabilitiesOverride` and `chatUiOverride` have `undefined`
   * as a meaningful runtime value ("no override; preset wins"). We use a
   * separate `*Set` discriminator below to distinguish "no prop passed"
   * (fall back to context) from "prop passed as undefined" (shadow with
   * undefined). Model-mode callers don't pass either flag.
   */
  hostCapabilitiesOverride?: Record<string, unknown> | undefined;
  /** When true, treat `hostCapabilitiesOverride` as an explicit prop even if undefined (shadow context). */
  hostCapabilitiesOverrideSet?: boolean;
  chatUiOverride?: ChatUiOverride | undefined;
  /** When true, treat `chatUiOverride` as an explicit prop even if undefined (shadow context). */
  chatUiOverrideSet?: boolean;
  mcpProfile?: HostConfigMcpProfileV1 | undefined;
  /** When true, treat `mcpProfile` as an explicit prop even if undefined (shadow context). */
  mcpProfileSet?: boolean;
  /**
   * Optional host config used to build a per-card
   * `ActiveHostCapsResolverScope`. When undefined, the tab-root scope's
   * resolver is inherited (no per-card shadow).
   */
  activeHost?: HostConfigDtoV2 | null;
}

export function MultiModelPlaygroundCard({
  compareId,
  compareLabel,
  compareKind: _compareKind,
  compareSubLabel,
  model,
  comparisonSummaries,
  selectedServers,
  broadcastRequest,
  deterministicExecutionRequest,
  stopRequestId,
  reasoningDisplayMode = "inline",
  executionConfig,
  hostedContext,
  hostedOrgModelConfig,
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
  compareEnterVersion = 0,
  compareEnterMessages = [],
  addColumnSeed = null,
  onTranscriptSync,
  hostCapabilitiesOverride: hostCapabilitiesOverrideProp,
  hostCapabilitiesOverrideSet = false,
  chatUiOverride: chatUiOverrideProp,
  chatUiOverrideSet = false,
  mcpProfile: mcpProfileProp,
  mcpProfileSet = false,
  activeHost,
}: MultiModelPlaygroundCardProps) {
  // Resolve effective per-card values from props with fall-back to the
  // tab-root provider context. Model-mode callers (today) don't pass any
  // of these; the card inherits the tab-root values via `useContext` so
  // the rendered tree is behavior-identical to pre-refactor. Phase 4
  // host-render path passes explicit per-column values to take advantage
  // of the provider shadowing.
  const tabRootHostCapabilitiesOverride =
    useChatboxHostCapabilitiesOverride();
  const tabRootChatUiOverride = useChatboxChatUiOverride();
  const tabRootMcpProfile = useActiveMcpProfile();
  const effectiveHostCapabilitiesOverride = hostCapabilitiesOverrideSet
    ? hostCapabilitiesOverrideProp
    : tabRootHostCapabilitiesOverride;
  const effectiveChatUiOverride = chatUiOverrideSet
    ? chatUiOverrideProp
    : tabRootChatUiOverride;
  const effectiveMcpProfile = mcpProfileSet
    ? mcpProfileProp
    : tabRootMcpProfile;
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
  const [, setIsWidgetFullscreen] = useState(false);
  const [preludeTraceExecutions, setPreludeTraceExecutions] = useState<
    PreludeTraceExecution[]
  >([]);
  const [injectedToolRenderOverrides, setInjectedToolRenderOverrides] =
    useState<Record<string, ToolRenderOverride>>({});
  const lastBroadcastRequestIdRef = useRef<number | null>(null);
  const lastExecutionRequestIdRef = useRef<number | null>(null);
  const onSummaryChangeRef = useRef(onSummaryChange);
  const onHasMessagesChangeRef = useRef(onHasMessagesChange);
  const lastAddColumnVersionRef = useRef(0);
  const lastCompareEnterVersionRef = useRef(0);

  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    error,
    chatSessionId,
    toolsMetadata,
    toolServerMap,
    liveTraceEnvelope,
    requestPayloadHistory,
    hasTraceSnapshot,
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    addToolApprovalResponse,
    startChatWithMessages,
  } = useChatSession({
    selectedServers,
    hostedContext,
    hostedOrgModelConfig,
    executionConfig: {
      ...executionConfig,
      modelId: String(model.id),
    },
    onReset: () => {
      setModelContextQueue([]);
      setPreludeTraceExecutions([]);
      setInjectedToolRenderOverrides({});
    },
  });

  const isThreadEmpty = !messages.some(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const { sendBlocked: fullscreenChatSendBlocked } =
    getChatComposerInteractivity({
      isStreamingActive: isStreaming,
    });

  useEffect(() => {
    onTranscriptSync?.(compareId, messages);
  }, [messages, compareId, onTranscriptSync]);

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

  const preludeTraceEnvelope = useMemo(
    () => buildPreludeTraceEnvelope(preludeTraceExecutions),
    [preludeTraceExecutions],
  );
  const effectiveLiveTraceEnvelope =
    hasTraceSnapshot || isStreaming
      ? liveTraceEnvelope
      : (preludeTraceEnvelope ?? liveTraceEnvelope);
  const showTraceTabs = traceViewsSupported && !isThreadEmpty;
  const activeTraceViewMode: PlaygroundTraceViewMode = showTraceTabs
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

  const showLiveTracePending =
    activeTraceViewMode === "timeline" &&
    !hasLiveTimelineContent &&
    !preludeTraceEnvelope?.spans?.length;
  const traceViewerTrace = effectiveLiveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const latestTurn = effectiveLiveTraceEnvelope?.turns?.at(-1);
  const summary = useMemo<MultiModelCardSummary>(
    () => ({
      // `MultiModelCardSummary.modelId` is the legacy field name; in
      // multi-host mode it holds the host's `compareId`. Renaming the
      // field would ripple to ChatTabV2 + evals — keep the field name,
      // change what we put in it.
      modelId: compareId,
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
    [compareId, error, isExecuting, isStreaming, isThreadEmpty, latestTurn],
  );
  const errorMessage = formatErrorMessage(error);
  const mergedToolRenderOverrides = useMemo(
    () => ({
      ...injectedToolRenderOverrides,
      ...toolRenderOverrides,
    }),
    [injectedToolRenderOverrides, toolRenderOverrides],
  );
  const hostBackgroundColor =
    getChatboxChatBackground(hostStyle, effectiveThreadTheme) ?? "transparent";
  const isMobileFullTakeover =
    deviceType === "mobile" &&
    (displayMode === "fullscreen" || displayMode === "pip");
  const isTabletFullscreenTakeover =
    deviceType === "tablet" && displayMode === "fullscreen";
  const shellHeightClass =
    isMobileFullTakeover || isTabletFullscreenTakeover
      ? "min-h-[34rem]"
      : "";

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
  }, [isThreadEmpty, compareId]);

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
    if (!deterministicExecutionRequest) {
      return;
    }

    if (
      lastExecutionRequestIdRef.current === deterministicExecutionRequest.id
    ) {
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
          next = upsertById(
            next as typeof newMessages,
            message,
          ) as typeof previous;
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
        const filtered = previous.filter(
          (item) => item.toolCallId !== toolCallId,
        );
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  // Provider stack wraps the WHOLE card body — header + trace branch +
  // chat branch — so per-card host overrides (Phase 4) flow into all
  // three. Pre-refactor only the chat branch had this stack.
  //
  // Two of the providers (`ActiveMcpProfileProvider`,
  // `ActiveHostCapsResolverScope`) are conditional: they shadow the
  // tab-root only when the caller explicitly passes the prop. This
  // matters because (a) model-mode wants the tab-root values to flow
  // through unchanged, and (b) the contexts' default values aren't
  // meaningful sentinels (their `undefined` defaults represent real
  // states, not "no scope"). The "*Set" discriminator booleans handle
  // the value-providers analogously.
  const cardBody = (
    <div
      data-testid="multi-model-playground-card-root"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40"
    >
      <ModelCompareCardHeader
        model={model}
        compareLabel={compareLabel}
        compareSubLabel={compareSubLabel}
        summary={summary}
        allSummaries={comparisonSummaries}
        mode={activeTraceViewMode}
        onModeChange={handleTraceViewModeChange}
        showTraceTabs={showTraceTabs}
        showComparisonChrome={showComparisonChrome}
      />

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
                  fullscreenChatSendBlocked={fullscreenChatSendBlocked}
                  onFullscreenChatStop={stop}
                  onFullscreenChange={setIsWidgetFullscreen}
                  onToolApprovalResponse={addToolApprovalResponse}
                  rawRequestPayloadHistory={{
                    entries: requestPayloadHistory,
                    hasUiMessages: !isThreadEmpty,
                  }}
                />
              ) : showLiveTracePending ? (
                <LiveTraceTimelineEmptyState
                  testId={`playground-live-trace-pending-${compareId}`}
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
                  displayMode={displayMode}
                  onDisplayModeChange={onDisplayModeChange}
                  onFullscreenChange={setIsWidgetFullscreen}
                  rawRequestPayloadHistory={{
                    entries: requestPayloadHistory,
                    hasUiMessages: !isThreadEmpty,
                  }}
                />
              )}
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "chatbox-host-shell app-theme-scope relative m-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.25rem] border border-border/50",
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
                <div className="min-h-[8rem] flex-1" aria-hidden />
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
                      isLoading={isStreaming}
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
                      fullscreenChatSendBlocked={fullscreenChatSendBlocked}
                      onFullscreenChatStop={stop}
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
        )}
      </div>
    </div>
  );

  // Always-on value providers — wrap the whole card body. The values
  // are the resolved `effective*` (prop with fall-back to tab-root
  // context), so model-mode is byte-equivalent to today (tab-root flows
  // through), host-mode shadows.
  let wrapped: ReactNode = (
    <ChatboxHostStyleProvider value={hostStyle}>
      <ChatboxHostCapabilitiesOverrideProvider
        value={effectiveHostCapabilitiesOverride}
      >
        <ChatboxChatUiOverrideProvider value={effectiveChatUiOverride}>
          <ChatboxHostThemeProvider value={effectiveThreadTheme}>
            {cardBody}
          </ChatboxHostThemeProvider>
        </ChatboxChatUiOverrideProvider>
      </ChatboxHostCapabilitiesOverrideProvider>
    </ChatboxHostStyleProvider>
  );

  // Optional shadow providers — only wrap when the caller explicitly
  // passed the corresponding prop. Without the prop, the tab-root
  // scope's value flows through, preserving today's behavior.
  if (mcpProfileSet) {
    wrapped = (
      <ActiveMcpProfileProvider value={effectiveMcpProfile}>
        {wrapped}
      </ActiveMcpProfileProvider>
    );
  }
  if (activeHost !== undefined) {
    wrapped = (
      <ActiveHostCapsResolverScope activeHost={activeHost} hostStyle={hostStyle}>
        {wrapped}
      </ActiveHostCapsResolverScope>
    );
  }

  return wrapped;
}
