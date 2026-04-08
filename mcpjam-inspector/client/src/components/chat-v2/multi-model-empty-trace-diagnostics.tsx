import type { ReactNode } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import type { ModelDefinition } from "@/shared/types";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import { LiveTraceRawEmptyState } from "@/components/evals/live-trace-raw-empty";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";

export type MultiModelEmptyTraceMode = "chat" | "timeline" | "raw";

export interface MultiModelEmptyTraceDiagnosticsPanelProps {
  activeTraceViewMode: MultiModelEmptyTraceMode;
  effectiveHasMessages: boolean;
  hasLiveTimelineContent: boolean;
  traceViewerTrace: TraceEnvelope;
  model: ModelDefinition;
  toolsMetadata: Record<string, Record<string, any>>;
  toolServerMap: ToolServerMap;
  traceStartedAtMs: number | null;
  traceEndedAtMs: number | null;
  rawXRayMirror: {
    payload: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
    hasUiMessages: boolean;
  };
  rawEmptyTestId: string;
  timelineEmptyTestId: string;
  onRevealNavigateToChat: () => void;
  /** Error callout above the footer composer, or null. */
  errorFooterSlot: ReactNode;
  chatInputSlot: ReactNode;
}

/**
 * Multi-model empty thread: Trace / Raw (live) diagnostics body + pinned composer.
 * Mirrors ChatTabV2 `!effectiveHasMessages && showLiveTraceDiagnostics && !minimalMode`.
 */
export function MultiModelEmptyTraceDiagnosticsPanel({
  activeTraceViewMode,
  effectiveHasMessages,
  hasLiveTimelineContent,
  traceViewerTrace,
  model,
  toolsMetadata,
  toolServerMap,
  traceStartedAtMs,
  traceEndedAtMs,
  rawXRayMirror,
  rawEmptyTestId,
  timelineEmptyTestId,
  onRevealNavigateToChat,
  errorFooterSlot,
  chatInputSlot,
}: MultiModelEmptyTraceDiagnosticsPanelProps) {
  return (
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
                {!effectiveHasMessages ? (
                  <LiveTraceRawEmptyState testId={rawEmptyTestId} />
                ) : (
                  <TraceViewer
                    trace={traceViewerTrace}
                    model={model}
                    toolsMetadata={toolsMetadata}
                    toolServerMap={toolServerMap}
                    traceStartedAtMs={traceStartedAtMs}
                    traceEndedAtMs={traceEndedAtMs}
                    forcedViewMode={activeTraceViewMode}
                    hideToolbar
                    fillContent
                    onRevealNavigateToChat={onRevealNavigateToChat}
                    rawGrowWithContent
                    rawXRayMirror={rawXRayMirror}
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
            {activeTraceViewMode === "timeline" && !hasLiveTimelineContent ? (
              <LiveTraceTimelineEmptyState testId={timelineEmptyTestId} />
            ) : (
              <TraceViewer
                trace={traceViewerTrace}
                model={model}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                traceStartedAtMs={traceStartedAtMs}
                traceEndedAtMs={traceEndedAtMs}
                forcedViewMode={activeTraceViewMode}
                hideToolbar
                fillContent
                onRevealNavigateToChat={onRevealNavigateToChat}
                rawXRayMirror={rawXRayMirror}
              />
            )}
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-background/80 backdrop-blur-sm">
        {errorFooterSlot}
        <div className="max-w-4xl mx-auto p-4">{chatInputSlot}</div>
      </div>
    </div>
  );
}
