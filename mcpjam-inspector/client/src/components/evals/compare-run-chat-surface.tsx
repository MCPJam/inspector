import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "@ai-sdk/react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { Loader2 } from "lucide-react";
import { Thread } from "@/components/chat-v2/thread";
import { useChatSession } from "@/hooks/use-chat-session";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";
import { TraceViewer } from "./trace-viewer";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
} from "./trace-viewer-adapter";
import { useEvalTraceBlob } from "./use-eval-trace-blob";
import type { EvalIteration } from "./types";

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function LoadingState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-border/40 bg-muted/10 px-6 py-10">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center text-sm text-destructive">
      {message}
    </div>
  );
}

function applyWidgetStateUpdates(
  previousMessages: UIMessage[],
  updates: { toolCallId: string; state: unknown }[],
) {
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
}

export function CompareRunChatSurface({
  iteration,
  traceModel,
  serverNames,
  workspaceId,
  emptyMessage = "Run this test to inspect trace details.",
  fallbackTrace = null,
  onTraceLoaded,
  toolsMetadata,
  toolServerMap,
  connectedServerIds,
  hostedSelectedServerIds,
  hostedOAuthTokens,
  generationKey,
  blobLoadingEnabled = true,
}: {
  iteration: EvalIteration | null;
  traceModel?: ModelDefinition | null;
  serverNames: string[];
  workspaceId: string | null;
  emptyMessage?: string;
  fallbackTrace?: TraceEnvelope | null;
  onTraceLoaded?: () => void;
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: string[];
  hostedSelectedServerIds: string[];
  hostedOAuthTokens?: Record<string, string>;
  generationKey: string | number | null;
  blobLoadingEnabled?: boolean;
}) {
  const { blob, loading, error } = useEvalTraceBlob({
    iteration,
    onTraceLoaded,
    enabled: blobLoadingEnabled,
  });
  const activeTrace = (blob ?? fallbackTrace) as TraceEnvelope | null;
  const hasFallbackTrace = fallbackTrace != null;
  const adaptedTrace = useMemo(
    () =>
      activeTrace
        ? adaptTraceToUiMessages({
            trace: activeTrace,
            toolsMetadata,
            toolServerMap,
            connectedServerIds,
          })
        : null,
    [activeTrace, connectedServerIds, toolServerMap, toolsMetadata],
  );
  const seedMessages = adaptedTrace?.messages ?? [];
  const {
    messages: liveMessages,
    setMessages: setLiveMessages,
    sendMessage,
    status: liveStatus,
    selectedModel,
    toolsMetadata: liveToolsMetadata,
    toolServerMap: liveToolServerMap,
    addToolApprovalResponse,
    resetChat,
  } = useChatSession({
    selectedServers: serverNames,
    hostedWorkspaceId: workspaceId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    initialModelId: traceModel?.id ? String(traceModel.id) : undefined,
    minimalMode: true,
  });
  const [liveSessionPhase, setLiveSessionPhase] = useState<
    "idle" | "seeding" | "active"
  >("idle");
  const [seedMessageCount, setSeedMessageCount] = useState(0);
  const [queuedWidgetStates, setQueuedWidgetStates] = useState<
    { toolCallId: string; state: unknown }[]
  >([]);
  const [queuedModelContexts, setQueuedModelContexts] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const pendingFollowUpsRef = useRef<string[]>([]);

  const activateLiveSession = useCallback(() => {
    setLiveSessionPhase((current) => {
      if (current !== "idle") {
        return current;
      }
      setSeedMessageCount(seedMessages.length);
      setLiveMessages(seedMessages);
      return "seeding";
    });
  }, [seedMessages, setLiveMessages]);

  useEffect(() => {
    pendingFollowUpsRef.current = [];
    setQueuedWidgetStates([]);
    setQueuedModelContexts([]);
    setSeedMessageCount(0);
    setLiveSessionPhase("idle");
    resetChat();
  }, [generationKey, resetChat]);

  useEffect(() => {
    if (liveSessionPhase !== "seeding") {
      return;
    }

    if (liveMessages.length < seedMessageCount) {
      return;
    }

    setLiveSessionPhase("active");
  }, [liveMessages.length, liveSessionPhase, seedMessageCount]);

  const handleSendFollowUp = useCallback(
    (text: string) => {
      pendingFollowUpsRef.current.push(text);
      activateLiveSession();
    },
    [activateLiveSession],
  );

  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      activateLiveSession();

      if (liveSessionPhase === "active" && liveStatus === "ready") {
        setLiveMessages((previous) =>
          applyWidgetStateUpdates(previous, [{ toolCallId, state }]),
        );
        return;
      }

      setQueuedWidgetStates((previous) => [...previous, { toolCallId, state }]);
    },
    [activateLiveSession, liveSessionPhase, liveStatus, setLiveMessages],
  );

  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      },
    ) => {
      activateLiveSession();
      setQueuedModelContexts((previous) => {
        const next = previous.filter((entry) => entry.toolCallId !== toolCallId);
        next.push({ toolCallId, context });
        return next;
      });
    },
    [activateLiveSession],
  );

  useEffect(() => {
    if (liveSessionPhase !== "active" || liveStatus !== "ready") {
      return;
    }

    if (queuedWidgetStates.length > 0) {
      setLiveMessages((previous) =>
        applyWidgetStateUpdates(previous, queuedWidgetStates),
      );
      setQueuedWidgetStates([]);
      return;
    }

    if (queuedModelContexts.length > 0) {
      const contextMessages = queuedModelContexts.map(
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
      setLiveMessages((previous) => [...previous, ...(contextMessages as any[])]);
      setQueuedModelContexts([]);
      return;
    }

    const nextFollowUp = pendingFollowUpsRef.current.shift();
    if (nextFollowUp) {
      sendMessage({ text: nextFollowUp });
    }
  }, [
    liveSessionPhase,
    liveStatus,
    queuedWidgetStates,
    queuedModelContexts,
    sendMessage,
    setLiveMessages,
  ]);

  const liveSegmentMessages = useMemo(
    () => liveMessages.slice(seedMessageCount),
    [liveMessages, seedMessageCount],
  );
  const showLiveSegment =
    liveSessionPhase !== "idle" ||
    pendingFollowUpsRef.current.length > 0 ||
    liveSegmentMessages.length > 0 ||
    liveStatus !== "ready";

  if (!iteration && !fallbackTrace) {
    return <EmptyState message={emptyMessage} />;
  }

  if (loading && !hasFallbackTrace && !blob) {
    return <LoadingState message="Loading trace details…" />;
  }

  if (error && !hasFallbackTrace) {
    return <ErrorState message={error} />;
  }

  if (!activeTrace) {
    return <EmptyState message="No chat trace is available for this run." />;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col",
          showLiveSegment ? "flex-[3]" : "flex-1",
        )}
      >
        <TraceViewer
          trace={activeTrace}
          model={traceModel ?? undefined}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          forcedViewMode="chat"
          hideToolbar
          fillContent
          interactive
          sendFollowUpMessage={handleSendFollowUp}
          onWidgetStateChange={handleWidgetStateChange}
          onModelContextUpdate={handleModelContextUpdate}
          enableFullscreenChatOverlay
          fullscreenChatDisabled={liveStatus !== "ready"}
          onToolApprovalResponse={addToolApprovalResponse}
        />
      </div>

      {showLiveSegment ? (
        <div className="flex min-h-0 min-w-0 flex-[2] flex-col overflow-hidden rounded-xl border border-border/50 bg-background/60">
          <div className="shrink-0 border-b border-border/50 px-4 py-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Live follow-up session
            </div>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
            {liveSegmentMessages.length > 0 ? (
              <Thread
                messages={liveSegmentMessages}
                sendFollowUpMessage={handleSendFollowUp}
                model={selectedModel}
                isLoading={liveStatus === "submitted"}
                toolsMetadata={liveToolsMetadata as Record<string, Record<string, any>>}
                toolServerMap={liveToolServerMap}
                onWidgetStateChange={handleWidgetStateChange}
                onModelContextUpdate={handleModelContextUpdate}
                enableFullscreenChatOverlay
                fullscreenChatDisabled={liveStatus !== "ready"}
                onToolApprovalResponse={addToolApprovalResponse}
                minimalMode
                interactive
                contentClassName="min-w-0 w-full max-w-4xl space-y-8 px-4 pt-4 pb-12"
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
                {liveSessionPhase === "seeding" || liveStatus !== "ready" ? (
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Starting live follow-up session…</span>
                  </div>
                ) : (
                  <span>
                    Widget follow-ups and live interactive replies will appear
                    here.
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
