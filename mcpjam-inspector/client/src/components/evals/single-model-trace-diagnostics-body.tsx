import type { ComponentProps } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import { LiveTraceRawEmptyState } from "@/components/evals/live-trace-raw-empty";
import { LiveTraceTimelineEmptyState } from "@/components/evals/live-trace-timeline-empty";
import { TraceViewer } from "@/components/evals/trace-viewer";

export type SingleModelTraceDiagnosticsMode = "chat" | "timeline" | "raw";

type ForwardedTraceViewerProps = Pick<
  ComponentProps<typeof TraceViewer>,
  | "trace"
  | "model"
  | "toolsMetadata"
  | "toolServerMap"
  | "traceStartedAtMs"
  | "traceEndedAtMs"
  | "onRevealNavigateToChat"
  | "sendFollowUpMessage"
  | "displayMode"
  | "onDisplayModeChange"
  | "onFullscreenChange"
  | "rawRequestPayloadHistory"
>;

export interface SingleModelTraceDiagnosticsBodyProps
  extends ForwardedTraceViewerProps {
  activeTraceViewMode: SingleModelTraceDiagnosticsMode;
  isThreadEmpty: boolean;
  showLiveTracePending: boolean;
  rawEmptyTestId: string;
  timelineEmptyTestId: string;
  nonRawShellClassName?: string;
}

export function SingleModelTraceDiagnosticsBody({
  activeTraceViewMode,
  isThreadEmpty,
  showLiveTracePending,
  rawEmptyTestId,
  timelineEmptyTestId,
  nonRawShellClassName = "flex min-h-64 flex-1 flex-col overflow-hidden px-4 py-4",
  ...traceViewerProps
}: SingleModelTraceDiagnosticsBodyProps) {
  if (activeTraceViewMode === "raw") {
    return (
      <StickToBottom
        className="flex flex-1 min-h-0 flex-col overflow-hidden"
        resize="smooth"
        initial="smooth"
      >
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          <StickToBottom.Content className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4">
            <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col">
              {isThreadEmpty ? (
                <LiveTraceRawEmptyState testId={rawEmptyTestId} />
              ) : (
                <TraceViewer
                  {...traceViewerProps}
                  forcedViewMode={activeTraceViewMode}
                  hideToolbar
                  fillContent
                  rawGrowWithContent
                />
              )}
            </div>
          </StickToBottom.Content>
          <ScrollToBottomButton />
        </div>
      </StickToBottom>
    );
  }

  return (
    <div className={nonRawShellClassName}>
      <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
        {showLiveTracePending ? (
          <LiveTraceTimelineEmptyState testId={timelineEmptyTestId} />
        ) : (
          <TraceViewer
            {...traceViewerProps}
            forcedViewMode={activeTraceViewMode}
            hideToolbar
            fillContent
          />
        )}
      </div>
    </div>
  );
}
