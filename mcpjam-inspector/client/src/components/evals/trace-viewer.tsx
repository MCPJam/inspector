import {
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlignLeft,
  Code2,
  GitCompare,
  Loader2,
  MessageSquare,
  Minus,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelDefinition, ModelProvider } from "@/shared/types";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { JsonEditor } from "@/components/ui/json-editor";
import { MessageView } from "@/components/chat-v2/thread/message-view";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
  type TraceMessage,
} from "./trace-viewer-adapter";
import {
  buildPromptGroups,
  collectStepSpanIdsWithChildren,
} from "./trace-timeline";
import {
  RecordedTraceToolbar,
  type TimelineFilter,
} from "./recorded-trace-toolbar";
import { cn } from "@/lib/utils";

const TraceTimelineLazy = lazy(() =>
  import("./trace-timeline").then((m) => ({ default: m.TraceTimeline })),
);

const NOOP = (..._args: unknown[]) => {};

export type TraceViewerEvalToolCall = {
  toolName: string;
  arguments: Record<string, any>;
};

type TranscriptRange = {
  startIndex: number;
  endIndex: number;
};

interface TraceViewerProps {
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null;
  model?: ModelDefinition;
  toolsMetadata?: Record<string, Record<string, any>>;
  toolServerMap?: ToolServerMap;
  connectedServerIds?: string[];
  /** Fallback when the blob has no recorded spans (Convex wall-clock only). */
  estimatedDurationMs?: number | null;
  /** Shown under the toolbar row (e.g. run case insight caption). */
  traceInsight?: ReactNode;
  /** Tighter toolbar/card spacing for full-pane run detail. */
  chromeDensity?: "default" | "compact";
  /** Expected tool calls from the eval case (snapshot); enables the Tools tab. */
  expectedToolCalls?: TraceViewerEvalToolCall[];
  /** Tool calls observed for this iteration; enables the Tools tab. */
  actualToolCalls?: TraceViewerEvalToolCall[];
}

function getTraceMessages(
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
) {
  if (!trace) return [];

  if (Array.isArray(trace)) {
    return trace;
  }

  if (
    typeof trace === "object" &&
    trace !== null &&
    "messages" in trace &&
    Array.isArray(trace.messages)
  ) {
    return trace.messages;
  }

  if (
    typeof trace === "object" &&
    trace !== null &&
    "role" in trace &&
    typeof trace.role === "string"
  ) {
    return [trace as TraceMessage];
  }

  return [];
}

function getRecordedSpans(
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
): EvalTraceSpan[] | undefined {
  if (!trace || Array.isArray(trace)) return undefined;
  if (typeof trace !== "object") return undefined;
  if (!("spans" in trace)) return undefined;
  const raw = (trace as TraceEnvelope).spans;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw as EvalTraceSpan[];
}

export function TraceViewer({
  trace,
  model,
  toolsMetadata = {},
  toolServerMap = {},
  connectedServerIds = [],
  estimatedDurationMs = null,
  traceInsight,
  chromeDensity = "default",
  expectedToolCalls = [],
  actualToolCalls = [],
}: TraceViewerProps) {
  const [viewMode, setViewMode] = useState<
    "timeline" | "chat" | "raw" | "tools"
  >("timeline");
  const [timelineFilter, setTimelineFilter] = useState<TimelineFilter>("all");
  const [expandedPromptIds, setExpandedPromptIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [highlightedMessageIds, setHighlightedMessageIds] = useState<string[]>(
    [],
  );
  const [timelineResetVersion, setTimelineResetVersion] = useState(0);
  const [timelineViewportMaxMs, setTimelineViewportMaxMs] = useState(1);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const resolvedModel: ModelDefinition = model ?? {
    id: "unknown",
    name: "Unknown",
    provider: "custom" as ModelProvider,
  };
  const traceMessages = getTraceMessages(trace);
  const hasEvalToolCalls =
    expectedToolCalls.length > 0 || actualToolCalls.length > 0;
  const recordedSpans = useMemo(() => getRecordedSpans(trace), [trace]);
  const promptGroups = useMemo(
    () => (recordedSpans?.length ? buildPromptGroups(recordedSpans) : []),
    [recordedSpans],
  );
  const traceIdentityForToolbar = useMemo(
    () =>
      recordedSpans
        ?.map((span) => `${span.id}:${span.startMs}:${span.endMs}`)
        .join("|") ?? "no-spans",
    [recordedSpans],
  );
  const maxEndMsForToolbar = useMemo(
    () =>
      recordedSpans?.length
        ? recordedSpans.reduce((max, span) => Math.max(max, span.endMs), 1)
        : 1,
    [recordedSpans],
  );
  const fullyExpandedStepIds = useMemo(
    () => collectStepSpanIdsWithChildren(promptGroups),
    [promptGroups],
  );
  const isTimelineFullyExpanded = useMemo(() => {
    if (promptGroups.length === 0) return false;
    for (const group of promptGroups) {
      if (!expandedPromptIds.has(group.key)) return false;
    }
    for (const id of fullyExpandedStepIds) {
      if (!expandedStepIds.has(id)) return false;
    }
    return true;
  }, [
    promptGroups,
    expandedPromptIds,
    expandedStepIds,
    fullyExpandedStepIds,
  ]);

  useEffect(() => {
    setTimelineViewportMaxMs(maxEndMsForToolbar);
  }, [maxEndMsForToolbar, traceIdentityForToolbar]);

  function handleRecordedTraceReset() {
    setTimelineFilter("all");
    if (recordedSpans?.length) {
      setExpandedPromptIds(new Set(promptGroups.map((g) => g.key)));
      setExpandedStepIds(collectStepSpanIdsWithChildren(promptGroups));
      setTimelineViewportMaxMs(maxEndMsForToolbar);
    }
    setTimelineResetVersion((v) => v + 1);
  }

  useEffect(() => {
    setTimelineFilter("all");
    if (!recordedSpans?.length) {
      setExpandedPromptIds(new Set());
      setExpandedStepIds(new Set());
      return;
    }
    setExpandedPromptIds(new Set(promptGroups.map((g) => g.key)));
    setExpandedStepIds(collectStepSpanIdsWithChildren(promptGroups));
  }, [traceIdentityForToolbar, promptGroups, recordedSpans?.length]);

  const adaptedTrace = useMemo(
    () =>
      adaptTraceToUiMessages({
        trace,
        toolsMetadata,
        toolServerMap,
        connectedServerIds,
      }),
    [trace, toolsMetadata, toolServerMap, connectedServerIds],
  );

  useEffect(() => {
    setHighlightedMessageIds([]);
  }, [trace]);

  useEffect(() => {
    if (!hasEvalToolCalls) {
      setViewMode((mode) => (mode === "tools" ? "timeline" : mode));
    }
  }, [hasEvalToolCalls]);

  useEffect(() => {
    if (viewMode !== "chat" || highlightedMessageIds.length === 0) {
      return;
    }

    const focusedMessage = messageRefs.current[highlightedMessageIds[0] ?? ""];
    if (typeof focusedMessage?.scrollIntoView === "function") {
      focusedMessage.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }
  }, [highlightedMessageIds, viewMode]);

  function handleRevealInTranscript(range: TranscriptRange) {
    const highlightedIds = new Set<string>();
    for (
      let sourceIndex = range.startIndex;
      sourceIndex <= range.endIndex;
      sourceIndex += 1
    ) {
      for (const messageId of adaptedTrace.sourceMessageIndexToUiMessageIds[
        sourceIndex
      ] ?? []) {
        highlightedIds.add(messageId);
      }
    }

    const orderedIds = adaptedTrace.messages
      .map((message) => message.id)
      .filter((messageId) => highlightedIds.has(messageId));
    if (orderedIds.length === 0) {
      return;
    }

    setHighlightedMessageIds(orderedIds);
    startTransition(() => {
      setViewMode("chat");
    });
  }

  if (!trace) {
    return (
      <div className="text-xs text-muted-foreground">
        No trace data available
      </div>
    );
  }

  const hasRecordedSpans = Boolean(recordedSpans?.length);
  const showRecordedChrome =
    viewMode === "timeline" && hasRecordedSpans;
  const timelineZoomMinMs = Math.max(1, Math.round(maxEndMsForToolbar / 50));
  const compactChrome = chromeDensity === "compact";

  return (
    <div className={compactChrome ? "space-y-2" : "space-y-3"}>
      <div
        className={cn(
          "rounded-lg border border-border/50 bg-muted/15",
          compactChrome ? "px-2 py-1.5 sm:px-2.5" : "px-2 py-2 sm:px-3",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-row items-center justify-between gap-2",
            compactChrome ? "min-h-8" : "min-h-9",
          )}
        >
          <div className="flex min-w-0 min-h-0 flex-1 items-center gap-2">
            {showRecordedChrome ? (
              <RecordedTraceToolbar
                filter={timelineFilter}
                onFilterChange={setTimelineFilter}
                isFullyExpanded={isTimelineFullyExpanded}
                expandDisabled={promptGroups.length === 0}
                showBottomBorder={false}
                onReset={handleRecordedTraceReset}
                zoomControls={
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 border-border/50"
                      title="Zoom in timeline"
                      aria-label="Zoom in timeline"
                      disabled={timelineViewportMaxMs <= timelineZoomMinMs}
                      onClick={() =>
                        setTimelineViewportMaxMs((v) =>
                          Math.max(timelineZoomMinMs, Math.round(v * 0.8)),
                        )
                      }
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-7 w-7 border-border/50"
                      title="Zoom out timeline"
                      aria-label="Zoom out timeline"
                      disabled={
                        timelineViewportMaxMs >= maxEndMsForToolbar * 4
                      }
                      onClick={() =>
                        setTimelineViewportMaxMs((v) =>
                          Math.min(
                            maxEndMsForToolbar * 4,
                            Math.round(v * 1.25),
                          ),
                        )
                      }
                    >
                      <Minus className="size-3.5" aria-hidden />
                    </Button>
                  </>
                }
                onToggleExpandAll={() => {
                  if (isTimelineFullyExpanded) {
                    setExpandedPromptIds(new Set());
                    setExpandedStepIds(new Set());
                  } else {
                    setExpandedPromptIds(
                      new Set(promptGroups.map((group) => group.key)),
                    );
                    setExpandedStepIds(new Set(fullyExpandedStepIds));
                  }
                }}
              />
            ) : (
              <div className="text-xs font-medium text-muted-foreground">
                {viewMode === "raw"
                  ? "Trace JSON"
                  : viewMode === "tools"
                    ? "Expected vs actual tools"
                    : traceMessages.length > 0
                      ? `${traceMessages.length} message${traceMessages.length !== 1 ? "s" : ""}`
                      : "Trace"}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-md border border-border/40 bg-background p-0.5">
            <button
              type="button"
              onClick={() => setViewMode("timeline")}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
                viewMode === "timeline"
                  ? "bg-primary/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Timeline"
            >
              <AlignLeft className="h-3 w-3" />
              Timeline
            </button>
            <button
              type="button"
              onClick={() => setViewMode("chat")}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
                viewMode === "chat"
                  ? "bg-primary/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Chat view"
            >
              <MessageSquare className="h-3 w-3" />
              Chat
            </button>
            <button
              type="button"
              onClick={() => setViewMode("raw")}
              className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
                viewMode === "raw"
                  ? "bg-primary/10 text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Raw JSON"
            >
              <Code2 className="h-3 w-3" />
              Raw
            </button>
            {hasEvalToolCalls ? (
              <button
                type="button"
                onClick={() => setViewMode("tools")}
                className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
                  viewMode === "tools"
                    ? "bg-primary/10 text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title="Expected vs actual tool calls"
                data-testid="trace-viewer-tools-tab"
              >
                <GitCompare className="h-3 w-3" />
                Tools
              </button>
            ) : null}
          </div>
        </div>
        {traceInsight ? (
          <div
            className={
              compactChrome
                ? "mt-1.5 border-t border-border/40 pt-1.5"
                : "mt-2 border-t border-border/40 pt-2"
            }
            data-testid="trace-viewer-insight-slot"
          >
            {traceInsight}
          </div>
        ) : null}
      </div>

      {viewMode === "raw" && (
        <JsonEditor height="100%" viewOnly value={trace} />
      )}

      {viewMode === "timeline" && (
        <Suspense
          fallback={
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <TraceTimelineLazy
            recordedSpans={recordedSpans}
            estimatedDurationMs={
              recordedSpans?.length ? undefined : estimatedDurationMs
            }
            transcriptMessageCount={
              recordedSpans?.length ? 0 : traceMessages.length
            }
            transcriptMessages={traceMessages}
            onRevealInTranscript={handleRevealInTranscript}
            hideToolbar={hasRecordedSpans}
            timelineFilter={hasRecordedSpans ? timelineFilter : undefined}
            onTimelineFilterChange={
              hasRecordedSpans ? setTimelineFilter : undefined
            }
            expandedPromptIds={hasRecordedSpans ? expandedPromptIds : undefined}
            onExpandedPromptIdsChange={
              hasRecordedSpans ? setExpandedPromptIds : undefined
            }
            expandedStepIds={hasRecordedSpans ? expandedStepIds : undefined}
            onExpandedStepIdsChange={
              hasRecordedSpans ? setExpandedStepIds : undefined
            }
            viewportMaxMs={
              hasRecordedSpans ? timelineViewportMaxMs : undefined
            }
            resetVersion={hasRecordedSpans ? timelineResetVersion : undefined}
          />
        </Suspense>
      )}

      {viewMode === "chat" &&
        (traceMessages.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No messages in trace
          </div>
        ) : (
          <div className="max-w-4xl space-y-8 px-4 pt-2">
            {adaptedTrace.messages.map((message) => (
              <div
                key={message.id}
                ref={(element) => {
                  messageRefs.current[message.id] = element;
                }}
                data-source-range={
                  adaptedTrace.uiMessageSourceRanges[message.id]
                    ? `${adaptedTrace.uiMessageSourceRanges[message.id]!.startIndex}-${adaptedTrace.uiMessageSourceRanges[message.id]!.endIndex}`
                    : undefined
                }
                className={
                  highlightedMessageIds.includes(message.id)
                    ? "rounded-xl border border-primary/30 bg-primary/5 p-2"
                    : ""
                }
              >
                <MessageView
                  message={message}
                  model={resolvedModel}
                  onSendFollowUp={NOOP}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  pipWidgetId={null}
                  fullscreenWidgetId={null}
                  onRequestPip={NOOP}
                  onExitPip={NOOP}
                  onRequestFullscreen={NOOP}
                  onExitFullscreen={NOOP}
                  toolRenderOverrides={adaptedTrace.toolRenderOverrides}
                  showSaveViewButton={false}
                  minimalMode={true}
                  interactive={false}
                  reasoningDisplayMode="collapsed"
                />
              </div>
            ))}
          </div>
        ))}

      {viewMode === "tools" && hasEvalToolCalls ? (
        <div
          className="grid gap-3 md:grid-cols-2"
          data-testid="trace-viewer-tools-compare"
        >
          <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase">
              Expected
            </div>
            {expectedToolCalls.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No expected tool calls
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-border/30 bg-background/50">
                <JsonEditor
                  value={expectedToolCalls}
                  viewOnly
                  collapsible
                  defaultExpandDepth={2}
                  collapseStringsAfterLength={160}
                  className="min-h-[160px] max-h-72"
                />
              </div>
            )}
          </div>
          <div className="rounded-md border border-border/40 bg-muted/10 p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase">
              Actual
            </div>
            {actualToolCalls.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No tool calls made
              </div>
            ) : (
              <div className="overflow-hidden rounded-md border border-border/30 bg-background/50">
                <JsonEditor
                  value={actualToolCalls}
                  viewOnly
                  collapsible
                  defaultExpandDepth={2}
                  collapseStringsAfterLength={160}
                  className="min-h-[160px] max-h-72"
                />
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
