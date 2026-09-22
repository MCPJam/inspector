import { Network, Workflow } from "lucide-react";
import type { InsightsView } from "@/hooks/useInsightsFlowController";
import { cn } from "@/lib/utils";

/**
 * Session flow | Clusters exclusive toggle shared by User Testing and Swarm
 * Insights shells.
 */
export function InsightsViewToggle({
  view,
  onChange,
  testId = "insights-view-toggle",
}: {
  view: InsightsView;
  onChange: (next: InsightsView) => void;
  testId?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Insights view"
      className="flex items-center divide-x divide-border rounded-md border border-border"
      data-testid={testId}
    >
      <button
        type="button"
        aria-pressed={view === "flow"}
        onClick={() => onChange("flow")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors",
          view === "flow"
            ? "bg-muted/50 text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <Workflow className="h-3 w-3" />
        Session flow
      </button>
      <button
        type="button"
        aria-pressed={view === "clusters"}
        onClick={() => onChange("clusters")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors",
          view === "clusters"
            ? "bg-muted/50 text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <Network className="h-3 w-3" />
        Clusters
      </button>
    </div>
  );
}
