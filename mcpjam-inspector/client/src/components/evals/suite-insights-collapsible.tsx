import { useMemo } from "react";
import { Sparkles, Loader2, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import type { EvalSuiteRun } from "./types";
import { pickLatestCompletedRun } from "./helpers";
import { useRunInsights } from "./use-run-insights";

export interface SuiteInsightsCollapsibleProps {
  runs: EvalSuiteRun[];
  /** Shown next to the sparkles badge, e.g. "Run insights" vs "Commit insights" */
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
  const latestCompleted = useMemo(
    () => pickLatestCompletedRun(runs),
    [runs],
  );

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
      className="group/suite-insights rounded-md border border-violet-200/70 bg-violet-50/35 dark:border-violet-900/45 dark:bg-violet-950/15"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left outline-none hover:bg-violet-100/40 dark:hover:bg-violet-950/25 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/suite-insights:-rotate-90 group-data-[state=open]/suite-insights:rotate-0" />
        <Badge
          variant="outline"
          className="border-violet-300/70 bg-violet-100/60 text-violet-800 text-[10px] font-bold uppercase tracking-wider shrink-0 dark:border-violet-800/50 dark:bg-violet-900/35 dark:text-violet-300"
        >
          <Sparkles className="mr-1 h-3 w-3" />
          AI
        </Badge>
        <span className="text-xs font-medium text-foreground">{title}</span>
        {failedGeneration ? (
          <button
            type="button"
            className="ml-auto text-[10px] text-primary hover:underline"
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
        <div className="border-t border-violet-200/45 px-3 pb-2 pt-0 dark:border-violet-900/40">
          {pending ? (
            <span className="flex items-center gap-1 pl-6 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Generating insights for the latest completed run…
            </span>
          ) : summary ? (
            <p className="pl-6 text-xs leading-relaxed">{summary}</p>
          ) : requested ? (
            <span className="flex items-center gap-1 pl-6 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Requesting insights…
            </span>
          ) : failedGeneration ? (
            <p className="pl-6 text-xs text-muted-foreground">
              Run insights did not complete. Use Retry.
            </p>
          ) : (
            <p className="pl-6 text-xs text-muted-foreground">
              Open a completed run for diff-based insights.
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
