import { Loader2, Sparkles, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function RunInsightsNarrativeBody({
  summary,
  pending,
  requested,
  failedGeneration,
  error,
}: {
  summary: string | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
}) {
  return (
    <div className="text-sm leading-relaxed">
      {pending ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          Generating insights…
        </span>
      ) : error ? (
        <p className="text-destructive">{error}</p>
      ) : summary ? (
        <p className="text-foreground">{summary}</p>
      ) : failedGeneration ? (
        <p className="text-muted-foreground">
          We could not finish this summary. Retry below, or open a test for the
          full trace.
        </p>
      ) : requested ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          Requesting insights…
        </span>
      ) : (
        <p className="text-muted-foreground">
          We will add a short summary here when you open a completed run.
        </p>
      )}
    </div>
  );
}

/**
 * Diff-based run insights (vs prior completed baseline).
 * Standalone card: narrative first, then Sparkles + title row.
 * Embedded (run detail): narrative only + optional Retry; parent places this below the Run insights header.
 */
export function RunInsightsPrimaryBlock({
  summary,
  pending,
  requested,
  failedGeneration,
  error,
  onRetry,
  className,
  embedded = false,
}: {
  summary: string | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
  /** When true, omit outer card chrome for use inside a parent Run insights panel. */
  embedded?: boolean;
}) {
  const retryControl = failedGeneration ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => onRetry()}
    >
      <RotateCw className="h-3 w-3" />
      Retry
    </Button>
  ) : null;

  const titleAndRetryRow = (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-2 border-t border-border/60 px-3 pt-2.5 pb-3",
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <Sparkles
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="text-xs font-semibold text-muted-foreground">
            Run insights
          </span>
        </div>
      </div>
      {retryControl}
    </div>
  );

  if (embedded) {
    return (
      <div className={cn("border-b border-border/45 pb-3", className)}>
        <RunInsightsNarrativeBody
          summary={summary}
          pending={pending}
          requested={requested}
          failedGeneration={failedGeneration}
          error={error}
        />
        {retryControl ? (
          <div className="mt-3 flex justify-end border-t border-border/45 pt-3">
            {retryControl}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card text-card-foreground shadow-none",
        className,
      )}
    >
      <div className="px-3 pt-3 pb-2">
        <RunInsightsNarrativeBody
          summary={summary}
          pending={pending}
          requested={requested}
          failedGeneration={failedGeneration}
          error={error}
        />
      </div>
      {titleAndRetryRow}
    </div>
  );
}
