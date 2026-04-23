/**
 * Generic AI insight card — reusable across insight types.
 *
 * Renders a summary narrative with pending/error/retry states.
 * Pass a `title` prop to label the insight type (default: "Run insights").
 */

import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";

function InsightNarrativeBody({
  summary,
  pending,
  requested,
  failedGeneration,
  error,
  pendingLabel = "Generating insights\u2026",
  requestingLabel = "Requesting insights\u2026",
  emptyLabel = "We will add a short summary here when you open a completed run.",
  failedLabel = "We could not finish this summary. Retry below, or open a test for the full trace.",
}: {
  summary: string | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  pendingLabel?: string;
  requestingLabel?: string;
  emptyLabel?: string;
  failedLabel?: string;
}) {
  return (
    <div className="text-sm leading-relaxed">
      {pending ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          {pendingLabel}
        </span>
      ) : error ? (
        <p className="text-destructive">{error}</p>
      ) : summary ? (
        <p className="text-foreground">{summary}</p>
      ) : failedGeneration ? (
        <p className="text-muted-foreground">{failedLabel}</p>
      ) : requested ? (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          {requestingLabel}
        </span>
      ) : (
        <p className="text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}

export interface InsightPrimaryBlockProps {
  summary: string | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  onRetry: () => void;
  className?: string;
  /** When true, omit outer card chrome for use inside a parent panel. */
  embedded?: boolean;
  /** Label shown in the card footer (standalone mode). Default: "Run insights". */
  title?: string;
  /** Customizable labels for each state. */
  pendingLabel?: string;
  requestingLabel?: string;
  emptyLabel?: string;
  failedLabel?: string;
}

export function InsightPrimaryBlock({
  summary,
  pending,
  requested,
  failedGeneration,
  error,
  onRetry,
  className,
  embedded = false,
  title = "Run insights",
  pendingLabel,
  requestingLabel,
  emptyLabel,
  failedLabel,
}: InsightPrimaryBlockProps) {
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

  const narrativeProps = {
    summary,
    pending,
    requested,
    failedGeneration,
    error,
    pendingLabel,
    requestingLabel,
    emptyLabel,
    failedLabel,
  };

  const titleAndRetryRow = (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-2 border-t border-border/60 px-3 pt-2.5 pb-3",
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">
            {title}
          </span>
        </div>
      </div>
      {retryControl}
    </div>
  );

  if (embedded) {
    return (
      <div
        className={cn(
          "rounded-lg border-l-2 border-l-primary/50 pl-3.5 pr-3 py-3",
          className,
        )}
      >
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <InsightNarrativeBody {...narrativeProps} />
          </div>
        </div>
        {retryControl ? (
          <div className="mt-3 flex justify-end border-t border-border/40 pt-3">
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
        <InsightNarrativeBody {...narrativeProps} />
      </div>
      {titleAndRetryRow}
    </div>
  );
}
