import { cn } from "@/lib/utils";
import type { OwaspId } from "./evaluator-library-types";

export type OwaspCoverage = "passing" | "partial" | "failing" | "not_covered";

const COVERAGE: Record<OwaspCoverage, { label: string; dot: string }> = {
  passing: { label: "Passing", dot: "bg-success" },
  partial: { label: "Partial", dot: "bg-warning" },
  failing: { label: "Failing", dot: "bg-destructive" },
  not_covered: { label: "Not covered here", dot: "bg-muted-foreground" },
};

export type OwaspCoverageCellProps = {
  id: OwaspId;
  title: string;
  /** What covers it: an evaluator, a server check, or nothing in MCPJam. */
  coveredBy: string;
  coverage: OwaspCoverage;
};

/**
 * One OWASP MCP Top 10 item and what covers it. Items no evaluator or server
 * check can test say so instead of implying coverage.
 */
export function OwaspCoverageCell({
  id,
  title,
  coveredBy,
  coverage,
}: OwaspCoverageCellProps) {
  return (
    <div
      role="group"
      aria-label={`${id}: ${COVERAGE[coverage].label}`}
      className="flex flex-col gap-1 rounded-lg border border-border bg-popover p-3"
    >
      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <span
          aria-hidden
          className={cn("size-2 rounded-full", COVERAGE[coverage].dot)}
        />
        {id}
      </span>
      <span className="text-sm font-semibold text-card-foreground">
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{coveredBy}</span>
      <span className="text-xs text-muted-foreground">
        {COVERAGE[coverage].label}
      </span>
    </div>
  );
}
