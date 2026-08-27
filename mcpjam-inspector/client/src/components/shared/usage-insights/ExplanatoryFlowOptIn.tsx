/**
 * The flow diagram, behind the decision to pay for it.
 *
 * Two things sit next to each other on a run detail and they are offered
 * differently, on purpose:
 *
 *   - The **user value chain** is a rollup of verdicts the stage worker
 *     already derived. Reading it costs nothing, so it renders unasked.
 *   - The **flow diagram** is a model's reading of the same traces, bought per
 *     pass. Nothing here subscribes to it, warms it, or triggers it until a
 *     person has said yes to the spend — including on mount, including when
 *     the panel is scrolled into view.
 *
 * That distinction is the whole component. An "insights" panel that quietly
 * queues an analysis the first time somebody opens a tab is how a bill arrives
 * for something nobody asked for, and the fix is not a smaller model — it is
 * an affirmative click.
 *
 * NOTHING HERE CAN MOVE A NUMBER. The pass it buys is read by the diagram and
 * by nothing that scores, so a refusal, a failure, or an analysis that never
 * runs leaves every reported result exactly as it was.
 */

import { useCallback, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Loader2, Sparkles } from "lucide-react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { cn } from "@/lib/utils";
import { SessionFlowSankey } from "@/components/shared/usage-insights/SessionFlowSankey";
import {
  useUsageInsights,
  type InsightsScope,
  type SankeyStage,
} from "@/hooks/useUsageInsights";
import {
  EMPTY_USAGE_FILTER,
  type InsightsSelection,
} from "@/hooks/scenario-usage-filters";

export function ExplanatoryFlowOptIn({
  scope,
  stageTitles,
  /** What the reader is being asked to spend on, in their own terms. */
  costLabel = "Reading these traces costs credits.",
  className,
}: {
  /**
   * The cohort to analyze. `null` means this surface has no analyzable cohort,
   * and the whole panel disappears rather than offering a button that would
   * spend nothing and produce nothing.
   */
  scope: InsightsScope | null;
  stageTitles?: Partial<Record<SankeyStage, string>>;
  costLabel?: string;
  className?: string;
}) {
  const [accepted, setAccepted] = useState(false);

  // Nothing at all, rather than a permanent "not available here" line. A
  // surface with no cohort has no offer to make, and an explanation of an
  // absent feature is noise on a column that may have nothing else in it.
  if (scope === null) return null;

  return (
    <section
      className={cn("rounded-md border border-border/60", className)}
      aria-label="Flow diagram"
    >
      <div className="border-b border-border/40 bg-muted/20 px-4 py-2 text-xs font-medium">
        Flow diagram
      </div>
      {accepted ? (
        // The subscription starts HERE and not one render earlier: mounting
        // the reader is the spend.
        <ErrorBoundary fallback={null}>
          <FlowBody scope={scope} {...(stageTitles ? { stageTitles } : {})} />
        </ErrorBoundary>
      ) : (
        <div className="space-y-2 px-4 py-3">
          <p className="text-[11px] text-muted-foreground">
            The chain above is measured from verdicts we already have. This
            diagram is a model&apos;s reading of the same traces — what was
            attempted, how it turned out, how it read. {costLabel} Nothing it
            produces feeds a score.
          </p>
          <Button size="sm" variant="outline" onClick={() => setAccepted(true)}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Analyze these traces
          </Button>
        </div>
      )}
    </section>
  );
}

function FlowBody({
  scope,
  stageTitles,
}: {
  scope: InsightsScope;
  stageTitles?: Partial<Record<SankeyStage, string>>;
}) {
  const { breakdown, rebuild } = useUsageInsights({
    scope,
    filters: EMPTY_USAGE_FILTER,
    threadsEnabled: false,
    breakdownEnabled: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Selection is local and inert: this is a read-only panel on a run detail,
  // not the insights workbench, and there is nothing here to drill into.
  const [selection] = useState<InsightsSelection | null>(null);

  const run = useCallback(() => {
    setBusy(true);
    setError(null);
    void rebuild()
      .catch((err: unknown) => {
        // A refusal is reported, not swallowed. "Nothing happened" and "we
        // declined to spend on this" look identical from the outside, and only
        // one of them is worth waiting through.
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  }, [rebuild]);

  if (breakdown === undefined) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading the traces…
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <SessionFlowSankey
        breakdown={breakdown}
        selection={selection}
        onSelectNode={() => {}}
        onSelectLink={() => {}}
        onRebuild={run}
        rebuildBusy={busy}
        {...(stageTitles ? { stageTitles } : {})}
      />
      {error ? (
        <p className="px-4 pb-3 text-[11px] text-amber-600 dark:text-amber-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
