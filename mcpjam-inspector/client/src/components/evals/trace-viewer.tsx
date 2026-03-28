import {
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlignLeft, Code2, Loader2, MessageSquare } from "lucide-react";
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

const TraceTimelineLazy = lazy(() =>
  import("./trace-timeline").then((m) => ({ default: m.TraceTimeline })),
);

const NOOP = (..._args: unknown[]) => {};

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
}: TraceViewerProps) {
  const [viewMode, setViewMode] = useState<"timeline" | "chat" | "raw">(
    "timeline",
  );
  const [highlightedMessageIds, setHighlightedMessageIds] = useState<string[]>(
    [],
  );
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const resolvedModel: ModelDefinition = model ?? {
    id: "unknown",
    name: "Unknown",
    provider: "custom" as ModelProvider,
  };
  const traceMessages = getTraceMessages(trace);
  const recordedSpans = useMemo(() => getRecordedSpans(trace), [trace]);
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
        <div className="text-xs font-medium text-muted-foreground">
          {traceMessages.length > 0
            ? `${traceMessages.length} message${traceMessages.length !== 1 ? "s" : ""}`
            : "Trace"}
        </div>
        <div className="flex items-center gap-1 rounded-md border border-border/40 bg-background p-0.5">
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
        </div>
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
    </div>
  );
}
