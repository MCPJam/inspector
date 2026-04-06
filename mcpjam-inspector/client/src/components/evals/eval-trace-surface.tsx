import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { JsonEditor } from "@/components/ui/json-editor";
import {
  type ListToolsResultWithMetadata,
  ToolServerMap,
  listTools,
} from "@/lib/apis/mcp-tools-api";
import {
  TraceViewer,
  type TraceViewerEvalToolCall,
} from "./trace-viewer";
import {
  adaptTraceToUiMessages,
  type TraceEnvelope,
} from "./trace-viewer-adapter";
import { extractFinalAssistantOutput, resolveTraceModel } from "./compare-playground-helpers";
import type { EvalCase, EvalIteration } from "./types";

interface EvalTraceSurfaceProps {
  iteration: EvalIteration | null;
  testCase: EvalCase | null;
  serverNames?: string[];
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
}

const EMPTY_SERVER_NAMES: string[] = [];

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
  serverNames = EMPTY_SERVER_NAMES,
  mode,
  emptyMessage = "Run this test to inspect trace details.",
  onNavigateToChat,
  fallbackTrace = null,
  fallbackActualToolCalls = [],
  onTraceLoaded,
}: EvalTraceSurfaceProps) {
  const getBlob = useAction(
    "testSuites:getTestIterationBlob" as any,
  ) as unknown as (args: { blobId: string }) => Promise<any>;

  const [blob, setBlob] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, any>>
  >({});
  const [toolServerMap, setToolServerMap] = useState<ToolServerMap>({});
  const [connectedServerIds, setConnectedServerIds] = useState<string[]>([]);
  const onTraceLoadedRef = useRef(onTraceLoaded);

  useEffect(() => {
    onTraceLoadedRef.current = onTraceLoaded;
  }, [onTraceLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!iteration?.blob) {
        setBlob(null);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const data = await getBlob({ blobId: iteration.blob });
        if (!cancelled) {
          setBlob(data);
          onTraceLoadedRef.current?.();
        }
      } catch (loadError: any) {
        if (!cancelled) {
          setError(loadError?.message || "Failed to load trace");
          setBlob(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [getBlob, iteration?.blob]);

  useEffect(() => {
    let cancelled = false;

    if (serverNames.length === 0) {
      setToolsMetadata({});
      setToolServerMap({});
      setConnectedServerIds([]);
      return () => {
        cancelled = true;
      };
    }

    setToolsMetadata({});
    setToolServerMap({});
    setConnectedServerIds([]);

    serverNames.forEach((serverId) => {
      void listTools({ serverId })
        .then((result: ListToolsResultWithMetadata) => {
            if (cancelled) return;

            setConnectedServerIds((prev) =>
              prev.includes(serverId) ? prev : [...prev, serverId],
            );

            if (result.tools?.length) {
              setToolServerMap((prev) => {
                const next = { ...prev };
                for (const tool of result.tools ?? []) {
                  next[tool.name] = serverId;
                }
                return next;
              });
            }

            if (result.toolsMetadata) {
              setToolsMetadata((prev) => ({
                ...prev,
                ...Object.fromEntries(
                  Object.entries(result.toolsMetadata ?? {}).map(
                    ([toolName, meta]) => [
                      toolName,
                      meta as Record<string, unknown>,
                    ],
                  ),
                ),
              }));
            }
          },
        )
        .catch((loadError: unknown) => {
          if (cancelled) return;
          console.warn(`Failed to fetch tools for server ${serverId}:`, loadError);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [serverNames]);

  const traceModel = useMemo(() => {
    if (!iteration) return null;
    return resolveTraceModel(iteration, testCase);
  }, [iteration, testCase]);

  const adaptedTrace = useMemo(() => {
    if (!blob) return null;
    return adaptTraceToUiMessages({
      trace: blob,
      toolsMetadata,
      toolServerMap,
      connectedServerIds,
    });
  }, [blob, connectedServerIds, toolServerMap, toolsMetadata]);

  const output = useMemo(() => {
    if (!adaptedTrace) {
      return { text: null, json: null as unknown };
    }

    return extractFinalAssistantOutput(adaptedTrace.messages as any);
  }, [adaptedTrace]);

  if (!iteration) {
    return <SimpleEmptyState message={emptyMessage} />;
  }

  const activeTrace = (blob ?? fallbackTrace) as TraceEnvelope | null;
  const hasFallbackTrace = fallbackTrace != null;

  if (loading && !hasFallbackTrace && !blob) {
    return <SimpleLoadingState message="Loading trace details…" />;
  }

  if (error && !hasFallbackTrace) {
    return <SimpleErrorState message={error} />;
  }

  if (mode === "output") {
    if (!blob) {
      if (iteration.error) {
        return <SimpleErrorState message={iteration.error} />;
      }
      return <SimpleEmptyState message="No output captured for this run yet." />;
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
    return <SimpleEmptyState message="No trace data is available for this run." />;
  }

  const estimatedDurationMs =
    iteration.startedAt && iteration.updatedAt
      ? Math.max(iteration.updatedAt - iteration.startedAt, 0)
      : null;

  const expectedToolCalls = iteration.testCaseSnapshot?.expectedToolCalls ?? [];
  const actualToolCalls =
    blob != null
      ? iteration.actualToolCalls ?? []
      : fallbackActualToolCalls;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-xl border border-border/50 bg-background">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        <TraceViewer
          trace={activeTrace}
          model={traceModel}
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
