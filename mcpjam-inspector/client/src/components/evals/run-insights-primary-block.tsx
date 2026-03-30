import { Loader2, Sparkles, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Diff-based run insights (vs prior completed baseline). Primary narrative above legacy triage.
 * Data and retry are provided by the parent (single useRunInsights per run detail).
 */
export function RunInsightsPrimaryBlock({
  summary,
  pending,
  requested,
  failedGeneration,
  error,
  onRetry,
  className,
}: {
  summary: string | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-violet-200/70 bg-violet-50/40 dark:border-violet-900/45 dark:bg-violet-950/20",
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-violet-200/50 px-3 py-2 dark:border-violet-900/40">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-400" />
          <span className="text-xs font-medium text-foreground">
            Run insights
          </span>
          <span className="text-[10px] text-muted-foreground">
            vs prior completed run
          </span>
        </div>
        {failedGeneration ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => onRetry()}
          >
            <RotateCw className="h-3 w-3" />
            Retry
          </Button>
        ) : null}
      </div>
      <div className="px-3 py-2 text-xs leading-relaxed">
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
            Insights did not complete. Use Retry or open AI triage for more
            detail.
          </p>
        ) : requested ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
            Requesting insights…
          </span>
        ) : (
          <p className="text-muted-foreground">
            Insights generate automatically when you open a completed run.
          </p>
        )}
      </div>
    </div>
  );
}
