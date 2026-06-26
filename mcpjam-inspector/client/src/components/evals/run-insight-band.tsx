import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Severity drives a subtle left accent, NOT the band's presence — progressive
 * discovery: neutral stays quiet; warn/alert add a thin border cue when there's
 * something worth expanding (judge disagreement, quality flag, regression).
 */
export type InsightSeverity = "neutral" | "warn" | "alert";

const SEVERITY_STYLES: Record<InsightSeverity, { wrap: string }> = {
  neutral: { wrap: "border-border/50 bg-muted/5" },
  warn: {
    wrap: "border-border/50 border-l-2 border-l-warning bg-muted/5",
  },
  alert: {
    wrap: "border-border/50 border-l-2 border-l-destructive bg-muted/5",
  },
};

/**
 * Collapsible, severity-colored run/group-level insight band shown ABOVE the
 * full-width case matrix — the SINGLE home for AI insights on both the
 * single-run and run-group views. The per-case detail lives in the matrix
 * cells' expandable "Insight"; this band carries only the scope-level summary
 * (judge headline, cross-host diagnosis) and collapses to one quiet line.
 */
export function RunInsightBand({
  summary,
  children,
  severity = "neutral",
  defaultOpen = false,
}: {
  /** Collapsed-state summary line (e.g. judge headline + disagreement count). */
  summary: ReactNode;
  /** Expanded content — the existing insight cards / diagnosis. */
  children: ReactNode;
  /** Drives the header color; default neutral (muted, easy to ignore). */
  severity?: InsightSeverity;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const styles = SEVERITY_STYLES[severity];
  return (
    <div
      data-severity={severity}
      className={cn(
        "mb-3 shrink-0 overflow-hidden rounded-md border",
        styles.wrap,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse run insights" : "Expand run insights"}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/20"
      >
        <ChevronDown
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-x-2 sm:gap-y-0">
          {summary}
        </div>
      </button>
      {open ? (
        <div className="border-t border-border/40">{children}</div>
      ) : null}
    </div>
  );
}
