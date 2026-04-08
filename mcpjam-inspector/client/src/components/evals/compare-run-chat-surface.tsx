import { Loader2 } from "lucide-react";
import type { ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { ModelDefinition } from "@/shared/types";
import { TraceViewer } from "./trace-viewer";
import { type TraceEnvelope } from "./trace-viewer-adapter";
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

export function CompareRunChatSurface({
  iteration,
  traceModel,
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
}: {
  iteration: EvalIteration | null;
  traceModel?: ModelDefinition | null;
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
  const resolvedBlob = shouldOwnTraceBlob ? blob : (traceBlob ?? null);
  const resolvedLoading = shouldOwnTraceBlob
    ? loading
    : (traceBlobLoading ?? false);
  const resolvedError = shouldOwnTraceBlob ? error : (traceBlobError ?? null);
  const activeTrace = (resolvedBlob ?? fallbackTrace) as TraceEnvelope | null;
  const hasFallbackTrace = fallbackTrace != null;

  if (!iteration && !fallbackTrace) {
    return <EmptyState message={emptyMessage} />;
  }

  if (resolvedLoading && !hasFallbackTrace && !resolvedBlob) {
    return <LoadingState message="Loading trace details…" />;
  }

  if (resolvedError && !hasFallbackTrace) {
    return <ErrorState message={resolvedError} />;
  }

  if (!activeTrace) {
    return <EmptyState message="No chat trace is available for this run." />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TraceViewer
          trace={activeTrace}
          model={traceModel ?? undefined}
          toolsMetadata={toolsMetadata}
          toolServerMap={toolServerMap}
          connectedServerIds={connectedServerIds}
          forcedViewMode="chat"
          hideToolbar
          fillContent
          interactive={false}
        />
      </div>
    </div>
  );
}
