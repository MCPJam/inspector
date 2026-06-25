import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Severity drives the band's color, NOT its presence — progressive discovery:
 * neutral stays muted and easy to ignore; the band only "lights up" (amber/red)
 * when there's something worth a click (a judge disagreement, a quality flag, a
 * regression). Mirrors how Sentry/Datadog use color as the attention signal.
 */
export type InsightSeverity = "neutral" | "warn" | "alert";

const SEVERITY_STYLES: Record<
  InsightSeverity,
  { wrap: string; icon: string }
> = {
  neutral: { wrap: "border-border/60 bg-card", icon: "text-muted-foreground" },
  warn: {
    wrap: "border-warning/60 bg-warning/10",
    icon: "text-warning",
  },
  alert: {
    wrap: "border-destructive/60 bg-destructive/10",
    icon: "text-destructive",
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
  const Icon = severity === "neutral" ? Sparkles : AlertTriangle;
  return (
    <div
      data-severity={severity}
      className={cn(
        "mb-3 shrink-0 overflow-hidden rounded-lg border",
        styles.wrap,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "Collapse AI insights" : "Expand AI insights"}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/20"
      >
        <Icon className={cn("size-3.5 shrink-0", styles.icon)} aria-hidden />
        <div className="flex min-w-0 flex-1 items-center gap-2">{summary}</div>
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="border-t border-border/50">{children}</div>
      ) : null}
    </div>
  );
}
