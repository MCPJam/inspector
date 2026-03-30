import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { EvalCaseInsightRow } from "./run-insight-helpers";
import { formatRunInsightStatusLabel } from "./run-insight-helpers";
import type { EvalSuiteRun } from "./types";

export function RunCaseInsightBlock({
  runStatus,
  caseInsight,
  pending,
  requested,
  failedGeneration,
  error,
  className,
  prominent = false,
}: {
  runStatus: EvalSuiteRun["status"];
  caseInsight: EvalCaseInsightRow | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  className?: string;
  /** Stronger visual hierarchy when showing a selected iteration’s insight. */
  prominent?: boolean;
}) {
  const bodyMuted = prominent ? "text-sm text-muted-foreground" : "text-xs text-muted-foreground";
  const bodyDestructive = prominent ? "text-sm text-destructive" : "text-xs text-destructive";

  let body: ReactNode;
  if (runStatus !== "completed") {
    body = (
      <p className={bodyMuted}>
        Complete the run to generate diff insights for this case.
      </p>
    );
  } else if (requested || pending) {
    body = (
      <span
        className={cn(
          "flex items-center gap-2 text-muted-foreground",
          prominent ? "text-sm" : "text-xs",
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        Generating insights…
      </span>
    );
  } else if (error) {
    body = <p className={bodyDestructive}>{error}</p>;
  } else if (failedGeneration) {
    body = (
      <p className={bodyMuted}>
        Run insights did not complete. Use Retry above.
      </p>
    );
  } else if (caseInsight) {
    body = (
      <div className="space-y-2">
        {caseInsight.status ? (
          <Badge variant="outline" className="text-[10px] font-normal">
            {formatRunInsightStatusLabel(caseInsight.status)}
          </Badge>
        ) : null}
        <p
          className={cn(
            "leading-relaxed text-foreground",
            prominent ? "text-sm" : "text-xs",
          )}
        >
          {caseInsight.summary}
        </p>
      </div>
    );
  } else {
    body = (
      <p
        className={cn(
          "text-muted-foreground",
          prominent ? "text-sm" : "text-xs",
        )}
      >
        No notable change in the last two runs.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2",
        prominent
          ? "border-primary/25 bg-primary/[0.06] py-3 shadow-sm dark:bg-primary/10"
          : "border-border/80 bg-card/50",
        className,
      )}
    >
      <div
        className={cn(
          "mb-1.5 text-foreground",
          prominent ? "text-sm font-semibold" : "text-xs font-medium",
        )}
      >
        Case insight
      </div>
      {body}
    </div>
  );
}
