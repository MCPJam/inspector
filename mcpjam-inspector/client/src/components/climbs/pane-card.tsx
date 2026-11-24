import { Check, Loader2, X } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Card } from "@mcpjam/design-system/card";
import { TraceViewer } from "../evals/trace-viewer";
import type { EvalIteration } from "../evals/types";
import { useEvalTraceBlob } from "../evals/use-eval-trace-blob";

export type PaneData = {
  letter?: string;
  title: string;
  sub: string;
  /** The iteration shown; absent when this run has none for the case. */
  iteration?: EvalIteration;
  /** True while the run's iterations are still loading. */
  loading?: boolean;
};

/** An iteration's pass or fail, from the backend's own result. */
export function iterationPassed(iteration: EvalIteration | undefined): boolean | undefined {
  if (!iteration || iteration.result === "pending") return undefined;
  return iteration.result === "passed";
}

function Transcript({ iteration }: { iteration: EvalIteration }) {
  const { blob, loading, error } = useEvalTraceBlob({ iteration });
  if (loading) {
    return (
      <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the transcript.
      </p>
    );
  }
  if (error) return <p className="p-3 text-sm text-destructive">{error} Reload the page to try again.</p>;
  if (!blob) return <p className="p-3 text-sm text-muted-foreground">This run saved no transcript.</p>;
  return (
    <TraceViewer
      trace={blob}
      frame="none"
      chromeDensity="compact"
      forcedViewMode="chat"
      hideToolbar
      hideTranscriptRevealControls
    />
  );
}

/** A card around the existing transcript viewer, with pass or fail and the case's tool calls. */
export function PaneCard({ pane, height = 300 }: { pane: PaneData; height?: number }) {
  const passed = iterationPassed(pane.iteration);
  const calls = pane.iteration?.actualToolCalls.length;
  return (
    <Card className="min-w-0 gap-0 overflow-hidden p-0 shadow-none" data-testid="pane-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {pane.letter ? <span className="mr-1.5 text-muted-foreground">{pane.letter}</span> : null}
            {pane.title}
          </div>
          <div className="truncate text-xs text-muted-foreground">{pane.sub}</div>
        </div>
        {passed === undefined ? null : (
          <Badge variant="outline" className="gap-1">
            {passed ? (
              <Check className="size-3.5 text-success" aria-hidden />
            ) : (
              <X className="size-3.5 text-destructive" aria-hidden />
            )}
            {passed ? "Passed" : "Failed"}
          </Badge>
        )}
      </div>
      <div style={{ height, overflow: "auto" }}>
        {pane.iteration ? (
          <Transcript iteration={pane.iteration} />
        ) : (
          <p className="p-3 text-sm text-muted-foreground" role="status">
            {pane.loading ? "Loading the run." : "This run has no iteration of this case."}
          </p>
        )}
      </div>
      {calls !== undefined ? (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {calls} {calls === 1 ? "tool call" : "tool calls"}
          {pane.iteration?.usage?.totalTokens ? ` · ${pane.iteration.usage.totalTokens.toLocaleString("en-US")} tokens` : ""}
        </div>
      ) : null}
    </Card>
  );
}
