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
}: {
  runStatus: EvalSuiteRun["status"];
  caseInsight: EvalCaseInsightRow | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
  className?: string;
}) {
  let body: ReactNode;
  if (runStatus !== "completed") {
    body = (
      <p className="text-xs text-muted-foreground">
        Complete the run to generate diff insights for this case.
      </p>
    );
  } else if (requested || pending) {
    body = (
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        Generating insights…
      </span>
    );
  } else if (error) {
    body = <p className="text-xs text-destructive">{error}</p>;
  } else if (failedGeneration) {
    body = (
      <p className="text-xs text-muted-foreground">
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
        <p className="text-xs leading-relaxed text-foreground">
          {caseInsight.summary}
        </p>
      </div>
    );
  } else {
    body = (
      <p className="text-xs text-muted-foreground">
        No notable change in the last two runs.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border border-border/80 bg-card/50 px-3 py-2",
        className,
      )}
    >
      <div className="mb-1.5 text-xs font-medium text-foreground">
        Case insight
      </div>
      {body}
    </div>
  );
}
