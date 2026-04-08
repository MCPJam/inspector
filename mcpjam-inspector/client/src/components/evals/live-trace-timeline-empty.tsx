import { TraceViewer } from "./trace-viewer";
import {
  SAMPLE_TRACE,
  SAMPLE_TRACE_STARTED_AT_MS,
  SAMPLE_TRACE_VIEWER_MODEL,
} from "./sample-trace-data";

/**
 * Timeline placeholder: full sample trace (same fixture as CI Evaluate → “View sample trace”),
 * so users see the real layout before their own run exists.
 */
export function LiveTraceTimelineEmptyState({
  testId,
}: {
  testId: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden px-4 py-2"
      data-testid={testId}
    >
      <p className="shrink-0 px-1 text-center text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Sample trace</span>
        {" — "}
        Example layout with steps and latency (the same preview as Evaluate → Runs). Yours
        appears here after you send a message.
      </p>
      <div
        className="relative flex min-h-64 flex-1 flex-col overflow-hidden rounded-xl border bg-card"
        data-testid={`${testId}-sample-preview`}
      >
        <TraceViewer
          trace={SAMPLE_TRACE}
          model={SAMPLE_TRACE_VIEWER_MODEL}
          traceStartedAtMs={SAMPLE_TRACE_STARTED_AT_MS}
          chromeDensity="compact"
          forcedViewMode="timeline"
          hideToolbar
          fillContent
          hideTranscriptRevealControls
          interactive={false}
        />
      </div>
    </div>
  );
}
