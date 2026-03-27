import { useEffect, useMemo } from "react";
import { Sparkles, Loader2, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import type { EvalSuiteRun } from "./types";
import { useCommitTriage } from "./use-ai-triage";

export interface SuiteInsightsCollapsibleProps {
  runs: EvalSuiteRun[];
  /** Shown next to the sparkles badge, e.g. "Suite insights" vs "Commit insights" */
  title?: string;
}

/**
 * AI summary for failed suite runs, using the same commit-level triage hook
 * (first failed run carries aggregated narrative on the backend).
 */
export function SuiteInsightsCollapsible({
  runs,
  title = "Suite insights",
}: SuiteInsightsCollapsibleProps) {
  const runsWithFailedCases = useMemo(
    () => runs.filter((r) => r.isActive !== false && (r.summary?.failed ?? 0) > 0),
    [runs],
  );

  const aiTriage = useCommitTriage(runsWithFailedCases);
  const totalFailed = runsWithFailedCases.reduce(
    (acc, r) => acc + (r.summary?.failed ?? 0),
    0,
  );

  useEffect(() => {
    if (
      runsWithFailedCases.length > 0 &&
      !aiTriage.summary &&
      !aiTriage.loading &&
      !aiTriage.unavailable
    ) {
      aiTriage.requestTriage();
    }
  }, [
    runsWithFailedCases.length,
    aiTriage.summary,
    aiTriage.loading,
    aiTriage.unavailable,
    aiTriage.requestTriage,
  ]);

  if (totalFailed <= 0) {
    return null;
  }

  if (aiTriage.unavailable || !(aiTriage.summary || aiTriage.loading)) {
    return null;
  }

  return (
    <Collapsible
      defaultOpen
      className="group/suite-insights rounded-md border border-orange-200/60 bg-orange-50/30 dark:border-orange-900/40 dark:bg-orange-950/10"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left outline-none hover:bg-orange-100/40 dark:hover:bg-orange-950/20 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]/suite-insights:-rotate-90 group-data-[state=open]/suite-insights:rotate-0" />
        <Badge
          variant="outline"
          className="border-orange-300/70 bg-orange-100/60 text-orange-700 text-[10px] font-bold uppercase tracking-wider shrink-0 dark:border-orange-800/50 dark:bg-orange-900/30 dark:text-orange-400"
        >
          <Sparkles className="mr-1 h-3 w-3" />
          AI
        </Badge>
        <span className="text-xs font-medium text-foreground">{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-orange-200/40 px-3 pb-2 pt-0 dark:border-orange-900/40">
          {aiTriage.summary ? (
            <p className="pl-6 text-xs leading-relaxed">{aiTriage.summary}</p>
          ) : (
            <span className="flex items-center gap-1 pl-6 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              analyzing...
            </span>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
