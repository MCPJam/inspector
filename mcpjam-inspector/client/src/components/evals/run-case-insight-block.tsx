import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EvalCaseInsightRow } from "./run-insight-helpers";
import type { EvalSuiteRun } from "./types";

const CAPTION_TEST_ID = "run-case-insight-trace-caption";

export function shouldOmitRunCaseInsightCaption({
  runStatus,
  caseInsight,
  pending,
  requested,
  failedGeneration,
  error,
}: {
  runStatus: EvalSuiteRun["status"];
  caseInsight: EvalCaseInsightRow | null;
  pending: boolean;
  requested: boolean;
  failedGeneration: boolean;
  error: string | null;
}) {
  return (
    runStatus === "completed" &&
    !pending &&
    !requested &&
    !error &&
    !failedGeneration &&
    caseInsight == null
  );
}

/** Plain caption for under the trace toolbar (no card). Returns null when there is nothing notable to show. */
export function RunCaseInsightTraceCaption({
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
  const bodyMuted = "text-xs text-muted-foreground";
  const bodyDestructive = "text-xs text-destructive";

  let body: ReactNode;
  if (runStatus !== "completed") {
    body = (
      <p className={bodyMuted}>
        Complete the run to generate diff insights for this case.
      </p>
    );
  } else if (requested || pending) {
    body = (
      <span className={cn("flex items-center gap-2 text-xs text-muted-foreground")}>
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
      <p className="text-xs leading-relaxed text-foreground">
        {caseInsight.summary}
      </p>
    );
  } else {
    return null;
  }

  return (
    <div className={cn(className)} data-testid={CAPTION_TEST_ID}>
      {body}
    </div>
  );
}
