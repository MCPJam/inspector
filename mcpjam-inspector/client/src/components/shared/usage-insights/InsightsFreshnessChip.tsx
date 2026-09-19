import { Loader2, RefreshCw } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import type {
  InsightsAnalysisSummary,
  InsightsScope,
} from "@/hooks/useUsageInsights";

export function InsightsFreshnessChip({
  analysis,
  onRebuild,
  rebuildBusy,
  testId,
}: {
  scope: InsightsScope;
  analysis: InsightsAnalysisSummary | null | undefined;
  onRebuild: (args?: { force?: boolean }) => void | Promise<unknown>;
  rebuildBusy: boolean;
  testId?: string;
}) {
  if (!analysis) return null;
  const analyzing = Math.max(
    0,
    analysis.pending + analysis.running - analysis.deferred,
  );
  const guest = analysis.skips.guest_owned ?? 0;
  const label =
    guest === analysis.total && guest > 0
      ? `${guest} skipped: sign in to analyze`
      : `Analyzed ${analysis.analyzed} of ${analysis.total}${
          analyzing ? ` · ${analyzing} analyzing` : ""
        }`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={testId}
          className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border/50 bg-muted/25 px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground hover:bg-muted/50"
        >
          {analyzing ? <Loader2 className="size-3 animate-spin" /> : null}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3 text-xs">
        <div className="space-y-1">
          <p className="font-medium">
            Analyzed {analysis.analyzed} of {analysis.total}
          </p>
          {guest > 0 ? <p>{guest} skipped: sign in to analyze</p> : null}
          {analysis.deferred > 0 ? (
            <p>
              {analysis.deferred} deferred until{" "}
              {analysis.deferredUntil
                ? new Date(analysis.deferredUntil).toLocaleString()
                : "the next budget window"}
            </p>
          ) : null}
          {Object.entries(analysis.failures).map(([reason, count]) => (
            <p key={reason}>
              {count} sessions need a retry: {reason.replaceAll("_", " ")}
            </p>
          ))}
          {analysis.awaitingTaxonomy + analysis.unassigned > 0 ? (
            <p>
              Other / unclassified: {analysis.unassigned} unmatched ·{" "}
              {analysis.awaitingTaxonomy} awaiting themes
            </p>
          ) : null}
          {analysis.projectionPending + analysis.projectionFailed > 0 ? (
            <p>
              Map: {analysis.projectionPending} pending ·{" "}
              {analysis.projectionFailed} need a retry
            </p>
          ) : null}
          {analysis.staleAssignments > 0 ? (
            <p>
              {analysis.staleAssignments} assignments awaiting a taxonomy
              refresh. Previous themes remain visible.
            </p>
          ) : null}
          {analysis.sampled ? (
            <p>Coverage reflects a bounded sample of recent sessions.</p>
          ) : null}
          {analysis.taxonomies.map((t) => (
            <p key={t.dimension} className="text-muted-foreground">
              {t.dimension} v{t.version}: {t.status.replaceAll("_", " ")}
              {t.sampleSize ? ` · discovery sample ${t.sampleSize}` : ""}
              {t.errorCode ? ` · ${t.errorCode}` : ""}
            </p>
          ))}
        </div>
        <button
          type="button"
          disabled={rebuildBusy}
          onClick={() => void onRebuild({ force: true })}
          data-testid={testId ? `${testId}-rebuild` : undefined}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-medium hover:bg-muted disabled:opacity-50"
        >
          {rebuildBusy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          Re-analyze
        </button>
      </PopoverContent>
    </Popover>
  );
}
