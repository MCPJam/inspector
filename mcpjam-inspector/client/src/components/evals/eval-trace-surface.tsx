import { useMemo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { JsonEditor } from "@/components/ui/json-editor";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { TraceViewer, type TraceViewerEvalToolCall } from "./trace-viewer";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
} from "./trace-viewer-adapter";
import {
  extractFinalAssistantOutput,
  resolveTraceModel,
} from "./compare-playground-helpers";
import { useEvalTraceBlob } from "./use-eval-trace-blob";
import type { EvalCase, EvalIteration } from "./types";
import { resolveIterationDisplayExpectedToolCalls } from "@/shared/prompt-turns";

interface EvalTraceSurfaceProps {
  iteration: EvalIteration | null;
  testCase: EvalCase | null;
  mode: "timeline" | "chat" | "raw" | "tools" | "output";
  emptyMessage?: string;
  /** When mode is controlled by tabs, Reveal in Chat needs this to switch to the chat tab. */
  onNavigateToChat?: () => void;
  /** Provisional live trace shown until the persisted blob finishes loading. */
  fallbackTrace?: TraceEnvelope | null;
  /** Provisional tool calls shown alongside {@link fallbackTrace}. */
  fallbackActualToolCalls?: TraceViewerEvalToolCall[];
  /** Called after the persisted blob has loaded successfully. */
  onTraceLoaded?: () => void;
  traceBlob?: TraceEnvelope | null;
  traceBlobLoading?: boolean;
  traceBlobError?: string | null;
  /** Run in progress; shows beside "Actual" in Results (tools) mode, same signal as metric spinners. */
  isLoading?: boolean;
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolServerMap: ToolServerMap;
  connectedServerIds: string[];
}

function SimpleEmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/10 px-6 py-10 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function SimpleLoadingState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-border/40 bg-muted/10 px-6 py-10">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function SimpleErrorState({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10">
      <div className="flex max-w-md items-start gap-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}

export function EvalTraceSurface({
  iteration,
  testCase,
  mode,
  emptyMessage = "Run this test to inspect trace details.",
  onNavigateToChat,
  fallbackTrace = null,
  fallbackActualToolCalls = [],
  onTraceLoaded,
  traceBlob,
  traceBlobLoading,
  traceBlobError,
  isLoading = false,
  toolsMetadata,
  toolServerMap,
  connectedServerIds,
}: EvalTraceSurfaceProps) {
  const shouldOwnTraceBlob =
    traceBlob === undefined &&
    traceBlobLoading === undefined &&
    traceBlobError === undefined;
  const { blob, loading, error } = useEvalTraceBlob({
    iteration,
    onTraceLoaded,
    enabled: shouldOwnTraceBlob,
  });
  const resolvedBlob = shouldOwnTraceBlob ? blob : (traceBlob ?? null);
  const resolvedLoading = shouldOwnTraceBlob
    ? loading
    : (traceBlobLoading ?? false);
  const resolvedError = shouldOwnTraceBlob ? error : (traceBlobError ?? null);

  const traceModel = useMemo(() => {
    if (!iteration) return null;
    return resolveTraceModel(iteration, testCase);
  }, [iteration, testCase]);

  const adaptedTrace = useMemo(() => {
    if (!resolvedBlob) return null;
    return adaptTraceToUiMessages({
      trace: resolvedBlob,
      toolsMetadata: toolsMetadata as Record<string, Record<string, any>>,
      toolServerMap,
      connectedServerIds,
    });
  }, [resolvedBlob, connectedServerIds, toolServerMap, toolsMetadata]);

  const output = useMemo(() => {
    if (!adaptedTrace) {
      return { text: null, json: null as unknown };
    }

    return extractFinalAssistantOutput(adaptedTrace.messages as any);
  }, [adaptedTrace]);

  if (!iteration) {
    return <SimpleEmptyState message={emptyMessage} />;
  }

  const activeTrace = (resolvedBlob ?? fallbackTrace) as TraceEnvelope | null;
  const hasFallbackTrace = fallbackTrace != null;

  if (resolvedLoading && !hasFallbackTrace && !resolvedBlob) {
    return <SimpleLoadingState message="Loading trace details…" />;
  }

  if (resolvedError && !hasFallbackTrace) {
    return <SimpleErrorState message={resolvedError} />;
  }

  if (mode === "output") {
    if (!resolvedBlob) {
      if (iteration.error) {
        return <SimpleErrorState message={iteration.error} />;
      }
      return (
        <SimpleEmptyState message="No output captured for this run yet." />
      );
    }

    if (output.text) {
      return (
        <div className="h-full overflow-y-auto rounded-xl border border-border/50 bg-background px-4 py-3">
          <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {output.text}
          </pre>
        </div>
      );
    }

    return (
      <div className="h-full overflow-hidden rounded-xl border border-border/50 bg-background">
        <JsonEditor value={output.json} viewOnly className="h-full" />
      </div>
    );
  }

  if (!activeTrace || !traceModel) {
    return (
      <SimpleEmptyState message="No trace data is available for this run." />
    );
  }

  const estimatedDurationMs =
    iteration.startedAt && iteration.updatedAt
      ? Math.max(iteration.updatedAt - iteration.startedAt, 0)
      : null;

  const expectedToolCalls = resolveIterationDisplayExpectedToolCalls(
    iteration.testCaseSnapshot,
    testCase,
  );
  const actualToolCalls =
    resolvedBlob != null
      ? (iteration.actualToolCalls ?? [])
      : fallbackActualToolCalls;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col rounded-xl border border-border/50 bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-3">
        <TraceViewer
          trace={activeTrace}
          model={traceModel}
          isLoading={isLoading}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          traceStartedAtMs={iteration.startedAt ?? iteration.createdAt}
          traceEndedAtMs={iteration.updatedAt}
          estimatedDurationMs={estimatedDurationMs}
          expectedToolCalls={expectedToolCalls}
          actualToolCalls={actualToolCalls}
          forcedViewMode={mode}
          hideToolbar
          fillContent
          onRevealNavigateToChat={onNavigateToChat}
        />
      </div>
    </div>
  );
}
