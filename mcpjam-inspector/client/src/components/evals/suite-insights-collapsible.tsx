import { useMemo } from "react";
import { Loader2, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { EvalSuiteRun } from "./types";
import { pickLatestCompletedRun } from "./helpers";
import { useRunInsights } from "./use-run-insights";

export interface SuiteInsightsCollapsibleProps {
  runs: EvalSuiteRun[];
  /** Header label, e.g. "Run insights" vs "Commit insights" */
  title?: string;
}

/**
 * Diff-based insights for the latest completed suite run (vs prior baseline),
 * generated lazily on first view.
 */
export function SuiteInsightsCollapsible({
  runs,
  title = "Run insights",
}: SuiteInsightsCollapsibleProps) {
  const latestCompleted = useMemo(() => pickLatestCompletedRun(runs), [runs]);

  const {
    summary,
    pending,
    failedGeneration,
    requestRunInsights,
    unavailable,
    requested,
  } = useRunInsights(latestCompleted, { autoRequest: true });

  if (!latestCompleted || unavailable) {
    return null;
  }

  return (
    <Collapsible
      defaultOpen
      className="group/suite-insights rounded-lg border border-border bg-card text-card-foreground"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left outline-none hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/suite-insights:-rotate-90 group-data-[state=open]/suite-insights:rotate-0" />
        <span className="text-xs font-semibold text-muted-foreground">
          {title}
        </span>
        {failedGeneration ? (
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              requestRunInsights(true);
            }}
          >
            Retry
          </button>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border/50 px-3 pb-3 pt-2">
          {pending ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Generating insights…
            </span>
          ) : summary ? (
            <p className="text-xs leading-relaxed text-foreground">{summary}</p>
          ) : requested ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Requesting insights…
            </span>
          ) : failedGeneration ? (
            <p className="text-xs text-muted-foreground">
              Could not load this summary. Hit Retry in the header.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Open a completed run to see a short summary vs the previous one.
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
