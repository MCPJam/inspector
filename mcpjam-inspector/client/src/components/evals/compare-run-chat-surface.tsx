import { useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { ModelDefinition } from "@/shared/types";
import { TraceViewer } from "./trace-viewer";
import { type TraceEnvelope } from "./trace-viewer-adapter";
import { useEvalTraceBlob } from "./use-eval-trace-blob";
import { buildToolCallPromptIndex } from "./rendered-widget-targets";
import type { EvalIteration } from "./types";
import type { RecorderProps } from "@/components/chat-v2/thread/recorder-types";

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

export function CompareRunChatSurface({
  iteration,
  traceModel,
  isLoading = false,
  emptyMessage = "Run this test to inspect trace details.",
  fallbackTrace = null,
  onTraceLoaded,
  toolsMetadata,
  toolServerMap,
  connectedServerIds,
  blobLoadingEnabled = true,
  traceBlob,
  traceBlobLoading,
  traceBlobError,
  interactive = false,
  recorder,
  sendFollowUpMessage,
  preserveLiveFallbackTrace = false,
}: {
  iteration: EvalIteration | null;
  traceModel?: ModelDefinition | null;
  isLoading?: boolean;
  emptyMessage?: string;
  fallbackTrace?: TraceEnvelope | null;
  onTraceLoaded?: () => void;
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: string[];
  blobLoadingEnabled?: boolean;
  traceBlob?: TraceEnvelope | null;
  traceBlobLoading?: boolean;
  traceBlobError?: string | null;
  // Tier 3 live preview: opt-in interactive + recorder. Run-results omit both
  // (interactive defaults false; recorder undefined) so they stay read-only.
  interactive?: boolean;
  recorder?: RecorderProps;
  /** A widget `ui/message` follow-up handler. When set, clicking a widget that
   *  sends a message hands off to the live playground (see the editor's
   *  `handleWidgetFollowUp`). Omitted on read-only run-results. */
  sendFollowUpMessage?: (text: string) => void;
  /**
   * The Quick Run chat preview has a live streaming trace before the persisted
   * trace blob is available. Once the blob loads, it carries cached widget HTML
   * snapshots that are useful for later replay but should not replace the live
   * widget iframe that is already on screen.
   */
  preserveLiveFallbackTrace?: boolean;
}) {
  const shouldOwnTraceBlob =
    traceBlob === undefined &&
    traceBlobLoading === undefined &&
    traceBlobError === undefined;
  const { blob, loading, error } = useEvalTraceBlob({
    iteration,
    onTraceLoaded,
    enabled: shouldOwnTraceBlob && blobLoadingEnabled,
  });
  const resolvedBlob = shouldOwnTraceBlob ? blob : traceBlob ?? null;
  const resolvedLoading = shouldOwnTraceBlob
    ? loading
    : traceBlobLoading ?? false;
  const resolvedError = shouldOwnTraceBlob ? error : traceBlobError ?? null;
  const liveFallbackTraceRef = useRef<TraceEnvelope | null>(null);
  if (preserveLiveFallbackTrace && fallbackTrace) {
    liveFallbackTraceRef.current = fallbackTrace;
  } else if (isLoading && liveFallbackTraceRef.current) {
    liveFallbackTraceRef.current = null;
  }

  const activeTrace = (liveFallbackTraceRef.current ??
    resolvedBlob ??
    fallbackTrace) as TraceEnvelope | null;
  // The displayed trace may be the live streaming envelope (kept so a
  // record-capable live widget stays mounted right after a run), which lacks the
  // server-side `widgetRenderObservations`. Those live on the persisted blob and
  // drive the Chat tab's frozen-screenshot replay — surface them onto whatever
  // trace we show so a completed-run view shows the recorded widget, not a
  // drifted live re-render. (TraceViewer skips frozen overrides while a widget
  // is armed for recording.)
  const traceForViewer = useMemo<TraceEnvelope | null>(() => {
    if (!activeTrace) return activeTrace;
    const obs = resolvedBlob?.widgetRenderObservations;
    const steps = resolvedBlob?.browserInteractionSteps;
    const needObs =
      !!obs?.length && !activeTrace.widgetRenderObservations?.length;
    const needSteps =
      !!steps?.length && !activeTrace.browserInteractionSteps?.length;
    if (!needObs && !needSteps) return activeTrace;
    return {
      ...activeTrace,
      ...(needObs ? { widgetRenderObservations: obs } : {}),
      ...(needSteps ? { browserInteractionSteps: steps } : {}),
    };
  }, [activeTrace, resolvedBlob]);
  const hasFallbackTrace = fallbackTrace != null;
  const recorderPromptIndexSnapshotRef = useRef<{
    key: string;
    entries: Array<[string, number]>;
  } | null>(null);

  // Tier 3: inject `resolvePromptIndex` (toolCallId → promptIndex) so the
  // recorder can attribute a clicked widget to its turn. Built here because
  // CompareRunChatSurface owns the resolved trace.
  //
  // `widgetRenderObservations` are AUTHORITATIVE: they carry the same
  // authored-turn `promptIndex` convention as the recording TARGETS (the chip /
  // `deriveRenderedWidgetTargets` read the very same observations). Tool `spans`
  // number turns by the LIVE message ordinal, which diverges from the authored
  // turn whenever a widget follow-up (e.g. a cart-view `ui/message`) inserts an
  // extra turn — so a span can say "turn 2" for a widget the target calls
  // "turn 1", and the exact-match save gate would silently drop the click.
  // Build from spans as the streaming-time base, then let observations OVERRIDE
  // so the resolved promptIndex matches the armed target.
  const recorderPromptIndexSnapshot = useMemo(() => {
    if (!recorder) {
      const previous = recorderPromptIndexSnapshotRef.current;
      if (previous?.key === "") return previous;
      const next = { key: "", entries: [] };
      recorderPromptIndexSnapshotRef.current = next;
      return next;
    }
    const entries = buildToolCallPromptIndex(
      traceForViewer?.spans,
      traceForViewer?.widgetRenderObservations,
    );
    const key = JSON.stringify(entries);
    const previous = recorderPromptIndexSnapshotRef.current;
    if (previous?.key === key) return previous;
    const next = { key, entries };
    recorderPromptIndexSnapshotRef.current = next;
    return next;
  }, [recorder, traceForViewer?.spans, traceForViewer?.widgetRenderObservations]);

  const recorderWithResolver = useMemo<RecorderProps | undefined>(() => {
    if (!recorder) return undefined;
    const promptIndexByToolCallId = new Map(
      recorderPromptIndexSnapshot.entries
    );
    return {
      ...recorder,
      resolvePromptIndex: (toolCallId: string) =>
        promptIndexByToolCallId.get(toolCallId),
    };
  }, [recorder, recorderPromptIndexSnapshot]);

  if (resolvedLoading && !hasFallbackTrace && !resolvedBlob) {
    return <LoadingState message="Loading trace details…" />;
  }

  if (resolvedError && !hasFallbackTrace) {
    return <ErrorState message={resolvedError} />;
  }

  if (!activeTrace) {
    return (
      <EmptyState
        message={
          !iteration && !fallbackTrace && !resolvedBlob
            ? emptyMessage
            : "No chat trace is available for this run."
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TraceViewer
          trace={traceForViewer}
          model={traceModel ?? undefined}
          isLoading={isLoading}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          forcedViewMode="chat"
          hideToolbar
          fillContent
          interactive={interactive}
          recorder={recorderWithResolver}
          {...(sendFollowUpMessage ? { sendFollowUpMessage } : {})}
        />
      </div>
    </div>
  );
}
