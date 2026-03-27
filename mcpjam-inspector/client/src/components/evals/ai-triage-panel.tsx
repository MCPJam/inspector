import { Loader2, Sparkles, AlertCircle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EvalSuiteRun } from "./types";
import { useAiTriage } from "./use-ai-triage";

interface AiTriagePanelProps {
  run: EvalSuiteRun;
  failedCount?: number;
  /** When false, triage starts only when the user clicks (default: true). */
  autoRequestTriage?: boolean;
}

export function AiTriagePanel({
  run,
  failedCount,
  autoRequestTriage = true,
}: AiTriagePanelProps) {
  const { canTriage, error, unavailable, requested, requestTriage } =
    useAiTriage(run, failedCount, { autoRequest: autoRequestTriage });

  // Don't render anything if the backend isn't available
  if (unavailable) return null;

  const { triageStatus, triageSummary } = run;

  const failed = failedCount ?? run.summary?.failed ?? 0;

  // No failures — nothing to triage
  if (failed === 0) return null;

  // Pending — show spinner
  if (triageStatus === "pending") {
    return (
      <div className="rounded-lg border border-border/50 border-l-2 border-l-orange-500 bg-muted/30 px-4 py-3 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
        <span className="text-sm text-muted-foreground">
          AI is analyzing failures...
        </span>
      </div>
    );
  }

  // Completed — render results
  if (triageStatus === "completed" && triageSummary) {
    return (
      <div className="rounded-lg border bg-card text-card-foreground border-l-2 border-l-orange-500">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-xs font-semibold">AI Triage</span>
            <span className="text-[10px] text-muted-foreground">
              {triageSummary.modelUsed}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1.5 text-[10px] text-muted-foreground"
            onClick={requestTriage}
            disabled={requested}
          >
            <RotateCw className="h-3 w-3" />
            Re-triage
          </Button>
        </div>

        <div className="px-4 py-3 space-y-4">
          {/* Summary */}
          <p className="text-sm leading-relaxed">{triageSummary.summary}</p>

          {/* Failure categories */}
          {triageSummary.failureCategories.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
                Failure Categories
              </h4>
              <div className="space-y-2">
                {triageSummary.failureCategories.map((cat) => (
                  <div
                    key={cat.category}
                    className="rounded-md border bg-muted/20 px-3 py-2"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium">
                        {cat.category}
                      </span>
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {cat.count} failure{cat.count !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mb-1.5">
                      {cat.recommendation}
                    </p>
                    {cat.testCaseTitles.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {cat.testCaseTitles.map((title) => (
                          <span
                            key={title}
                            className="text-[10px] bg-muted px-1.5 py-0.5 rounded"
                          >
                            {title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top recommendations */}
          {triageSummary.topRecommendations.length > 0 && (
            <div className="rounded-md border border-orange-500/30 bg-orange-500/5 px-3 py-3 space-y-2">
              <h4 className="text-xs font-semibold text-orange-500 uppercase tracking-wide flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" />
                Top Recommendations
              </h4>
              <ol className="space-y-1.5">
                {triageSummary.topRecommendations.map((rec, i) => (
                  <li key={i} className="text-xs leading-relaxed flex gap-2">
                    <span className="font-mono text-orange-500/70 shrink-0">
                      {i + 1}.
                    </span>
                    <span>{rec}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Failed — show error with retry
  if (triageStatus === "failed") {
    return (
      <div className="rounded-lg border border-destructive/30 border-l-2 border-l-orange-500 bg-destructive/5 px-4 py-3 flex items-center gap-3">
        <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
        <span className="text-sm text-destructive flex-1">
          AI triage failed.{error ? ` ${error}` : ""}
        </span>
        <Button variant="outline" size="sm" onClick={requestTriage}>
          Retry
        </Button>
      </div>
    );
  }

  // Default (undefined) — show triage button if eligible
  if (!canTriage) return null;

  return (
    <div className="flex items-center mt-2">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 h-7 text-xs border-orange-300/70 bg-orange-50/50 text-orange-700 hover:bg-orange-100/70 hover:text-orange-800 dark:border-orange-800/50 dark:bg-orange-950/30 dark:text-orange-400 dark:hover:bg-orange-900/40"
        onClick={requestTriage}
        disabled={requested}
      >
        <Sparkles className="h-3 w-3" />
        Triage Failures
      </Button>
      {error && <span className="ml-3 text-xs text-destructive">{error}</span>}
    </div>
  );
}
