import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Copy, Loader2, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { copyToClipboard } from "@/lib/clipboard";
import type { ModelDefinition, ModelProvider } from "@/shared/types";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  ReadOnlyTranscript,
  type ToolRenderOverride as ChatUiToolRenderOverride,
} from "@mcpjam/chat-ui";
import {
  adaptTraceToUiMessages,
  snapshotsToTraceWidgetSnapshots,
  type TraceEnvelope,
  type TraceWidgetSnapshot,
} from "@/components/evals/trace-viewer-adapter";
import { TraceViewer } from "@/components/evals/trace-viewer";
import { BrowserArtifactsView } from "@/components/evals/browser-artifacts-view";
import {
  ChatTraceViewModeHeaderBar,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import {
  useSharedChatThread,
  useSharedChatWidgetSnapshots,
  useSharedChatTurnTraces,
  useSessionBrowserArtifacts,
  type SharedChatTurnTrace,
} from "@/hooks/useSharedChatThreads";

const EMPTY_SPANS: EvalTraceSpan[] = [];

/**
 * Bridge inspector ToolRenderOverrides — whose widget/CSP fields use the MCP
 * Apps SDK types — to chat-ui's placeholder types. The read-only transcript
 * never reads those widget-specific fields, so the cast is safe. Kept as a
 * named seam so future read-only consumers can reuse it.
 */
function bridgeToolRenderOverrides(
  overrides: Record<string, unknown> | undefined,
): Record<string, ChatUiToolRenderOverride> | undefined {
  return overrides as Record<string, ChatUiToolRenderOverride> | undefined;
}

interface ShareUsageThreadDetailProps {
  threadId: string;
  /**
   * Full URL that deep-links back to this session. When provided the copy
   * button copies it; otherwise it falls back to the raw session id (the
   * host share-usage dialog has no deep-link target yet).
   */
  sessionLink?: string;
}

/**
 * Fetch span blobs from turn trace URLs and flatten into a single span array.
 */
async function hydrateSpans(
  traces: SharedChatTurnTrace[],
): Promise<EvalTraceSpan[]> {
  const results = await Promise.all(
    traces.map(async (trace) => {
      if (!trace.spansBlobUrl) return [];
      try {
        const response = await fetch(trace.spansBlobUrl);
        if (!response.ok) return [];
        const parsed = await response.json();
        return Array.isArray(parsed) ? (parsed as EvalTraceSpan[]) : [];
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export function ShareUsageThreadDetail({
  threadId,
  sessionLink,
}: ShareUsageThreadDetailProps) {
  const { thread } = useSharedChatThread({ threadId });
  const { snapshots } = useSharedChatWidgetSnapshots({ threadId });
  const { traces: turnTraces } = useSharedChatTurnTraces({ threadId });
  const { artifacts: browserArtifacts } = useSessionBrowserArtifacts({
    threadId,
  });
  const [messages, setMessages] = useState<unknown[] | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The eval-only "browser" mode lives outside the shared TraceViewMode union
  // (see trace-view-mode-tabs.tsx) — widen locally, mirroring TraceViewer's
  // own internal state.
  const [viewMode, setViewMode] = useState<TraceViewMode | "browser">("chat");
  const [hydratedSpans, setHydratedSpans] = useState<EvalTraceSpan[]>([]);

  // Fetch messages from blob URL
  useEffect(() => {
    if (!thread?.messagesBlobUrl) {
      setMessages(null);
      return;
    }

    let isActive = true;
    const controller = new AbortController();

    async function fetchMessages() {
      setIsLoadingMessages(true);
      setError(null);
      try {
        const response = await fetch(thread!.messagesBlobUrl!, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch messages: ${response.status}`);
        }
        const data = await response.json();
        if (isActive) {
          setMessages(data);
        }
      } catch (err) {
        if (!isActive) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load thread messages:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load messages",
        );
      } finally {
        if (isActive) {
          setIsLoadingMessages(false);
        }
      }
    }

    void fetchMessages();
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [thread?.messagesBlobUrl]);

  // Hydrate span blobs when turn traces arrive
  useEffect(() => {
    if (!turnTraces || turnTraces.length === 0) {
      setHydratedSpans(EMPTY_SPANS);
      return;
    }

    let isActive = true;
    void hydrateSpans(turnTraces).then((spans) => {
      if (isActive) setHydratedSpans(spans);
    });
    return () => {
      isActive = false;
    };
  }, [turnTraces]);

  // Transform snapshots to TraceWidgetSnapshot format
  const widgetSnapshots: TraceWidgetSnapshot[] = useMemo(() => {
    if (!snapshots || !thread) return [];
    return snapshotsToTraceWidgetSnapshots(snapshots);
  }, [snapshots, thread]);

  // Browser-rendered MCP App artifacts (synthetic sessions). Tab visibility =
  // artifact presence, the same heuristic the eval trace viewer uses.
  const renderObservations = browserArtifacts?.widgetRenderObservations ?? [];
  const interactionSteps = browserArtifacts?.browserInteractionSteps ?? [];
  // The Browser tab renders only the per-widget render observations now; the
  // interaction steps surface on the Trace tab (`Interact · …` spans), so they
  // ride the trace blob below rather than gating this tab.
  const hasBrowserArtifacts = renderObservations.length > 0;

  // The "browser" mode is only valid while the LOADED session actually has
  // artifacts. `viewMode` is component state that survives a `threadId`
  // switch, so without this clamp a session without artifacts would render
  // an orphaned empty Browser panel whose tab is hidden (Cursor Bugbot,
  // PR 2610). Render-time fallback (not a reset effect) so flipping back to
  // an artifact-carrying session restores the Browser view.
  const effectiveViewMode: TraceViewMode | "browser" =
    viewMode === "browser" && !hasBrowserArtifacts ? "chat" : viewMode;

  // Build a TraceEnvelope for the TraceViewer (timeline + raw). Browser
  // artifacts ride the envelope so the Raw view includes them.
  const traceEnvelope: TraceEnvelope | null = useMemo(() => {
    if (!messages) return null;
    return {
      messages: messages as any,
      widgetSnapshots,
      spans: hydratedSpans,
      ...(renderObservations.length > 0
        ? { widgetRenderObservations: renderObservations }
        : {}),
      ...(interactionSteps.length > 0
        ? { browserInteractionSteps: interactionSteps }
        : {}),
    };
  }, [messages, widgetSnapshots, hydratedSpans, renderObservations, interactionSteps]);

  // Adapt trace to UI messages for the chat view
  const adaptedTrace = useMemo(() => {
    if (!messages) return null;
    return adaptTraceToUiMessages({
      trace: { messages: messages as any, widgetSnapshots },
      toolResultDisplay:
        thread?.sourceType === "chatbox" ? "attached-to-tool" : "sibling-text",
    });
  }, [messages, thread?.sourceType, widgetSnapshots]);

  const resolvedModel: ModelDefinition = useMemo(
    () => ({
      id: thread?.modelId ?? "unknown",
      name: thread?.modelId ?? "Unknown",
      provider: "custom" as ModelProvider,
    }),
    [thread?.modelId],
  );

  // Compute trace timing from turn traces
  const traceStartedAtMs = useMemo(() => {
    if (!turnTraces || turnTraces.length === 0) return null;
    return Math.min(...turnTraces.map((t: SharedChatTurnTrace) => t.startedAt));
  }, [turnTraces]);

  const traceEndedAtMs = useMemo(() => {
    if (!turnTraces || turnTraces.length === 0) return null;
    return Math.max(...turnTraces.map((t: SharedChatTurnTrace) => t.endedAt));
  }, [turnTraces]);

  const handleCopySessionRef = useCallback(async () => {
    if (!thread) return;
    const text = sessionLink ?? thread.chatSessionId ?? thread._id;
    const ok = await copyToClipboard(text);
    if (ok) {
      toast.success(
        sessionLink ? "Session link copied" : "Session reference copied",
      );
    } else {
      toast.error("Failed to copy");
    }
  }, [thread, sessionLink]);

  // Loading state: thread query or messages fetch
  if (thread === undefined || isLoadingMessages) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (thread === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Thread not found</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (!adaptedTrace || adaptedTrace.messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">No messages in thread</p>
      </div>
    );
  }

  const duration =
    thread.lastActivityAt && thread.startedAt
      ? thread.lastActivityAt - thread.startedAt
      : 0;
  const durationStr =
    duration > 0
      ? duration < 60000
        ? `${Math.round(duration / 1000)}s`
        : `${Math.round(duration / 60000)}m`
      : null;
  const isChatboxThread = thread.sourceType === "chatbox";
  const reasoningDisplayMode = isChatboxThread ? "collapsible" : "collapsed";

  const hasFeedback =
    thread.feedbackRating != null ||
    (thread.feedbackComment && thread.feedbackComment.trim().length > 0);

  return (
    <div className="flex h-full flex-col">
      {/* Thread header — min-h keeps the border-b aligned with the
          sessions-list toolbar on the other side of the resize handle. */}
      <div className="flex min-h-[60px] shrink-0 flex-col justify-center border-b px-4 py-3">
        {hasFeedback ? (
          <div className="mb-4 rounded-xl border border-border/70 bg-muted/30 px-3 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Feedback
            </p>
            {thread.feedbackRating != null ? (
              <p className="mt-1 text-sm font-medium">
                {thread.feedbackRating}/5
              </p>
            ) : null}
            {thread.feedbackComment ? (
              <p className="mt-1 text-sm text-muted-foreground">
                &ldquo;{thread.feedbackComment}&rdquo;
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">
              {thread.visitorDisplayName}
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{thread.modelId}</span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                {thread.messageCount} messages
              </span>
              {durationStr && (
                <>
                  <span>·</span>
                  <span>{durationStr}</span>
                </>
              )}
              <span>·</span>
              <span>
                {formatDistanceToNow(new Date(thread.startedAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl"
              onClick={() => void handleCopySessionRef()}
            >
              <Copy className="mr-1.5 size-3.5" />
              {sessionLink ? "Copy session link" : "Copy session ID"}
            </Button>
          </div>
        </div>
      </div>

      {/* Trace / Chat / [Browser] / Raw tabs. The Browser tab appears when the
          session carries browser-rendered MCP App artifacts (synthetic runs);
          its active mode lives outside the shared TraceViewMode union. */}
      <ChatTraceViewModeHeaderBar
        mode={effectiveViewMode === "browser" ? "chat" : effectiveViewMode}
        onModeChange={setViewMode}
        showBrowserTab={hasBrowserArtifacts}
        browserActive={effectiveViewMode === "browser"}
        onSelectBrowser={() => setViewMode("browser")}
      />

      {/* Content area: must be a flex column so TraceViewer (fillContent) is a flex item; otherwise
          nested flex-1 / min-h-0 inside TraceTimeline collapses and the timeline paints empty. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveViewMode === "browser" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <BrowserArtifactsView observations={renderObservations} />
          </div>
        ) : effectiveViewMode === "chat" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ReadOnlyTranscript
              messages={adaptedTrace.messages}
              model={resolvedModel}
              toolRenderOverrides={bridgeToolRenderOverrides(
                adaptedTrace.toolRenderOverrides,
              )}
              reasoningDisplayMode={reasoningDisplayMode}
              widgetPolicy="placeholder"
              className="mx-auto max-w-4xl px-4 py-4"
            />
          </div>
        ) : (
          <TraceViewer
            trace={traceEnvelope}
            model={resolvedModel}
            forcedViewMode={effectiveViewMode === "raw" ? "raw" : "timeline"}
            hideToolbar
            fillContent
            traceStartedAtMs={traceStartedAtMs}
            traceEndedAtMs={traceEndedAtMs}
            interactive={false}
          />
        )}
      </div>
    </div>
  );
}
