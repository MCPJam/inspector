import {
  Check,
  CircleAlert,
  CircleSlash,
  LoaderCircle,
  Minus,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Every state an evaluator result or an iteration verdict can be in. The
 * first four mirror the runtime's ScoreStatus after a score is resolved to
 * passed or failed.
 */
export type VerdictStatus =
  | "passed"
  | "failed"
  | "error"
  | "skipped"
  | "not_applicable"
  | "running"
  | "partial";

const VERDICT = {
  passed: {
    label: "Passed",
    icon: Check,
    className: "bg-success/15 text-success",
  },
  failed: {
    label: "Failed",
    icon: X,
    // A tint with the reading foreground: small text on the solid
    // destructive fill is below 4.5:1 in both themes (DESIGN.md).
    className: "bg-destructive/15 text-foreground",
  },
  error: {
    label: "Error",
    icon: CircleAlert,
    className: "border border-destructive text-destructive",
  },
  skipped: {
    label: "Skipped",
    icon: CircleSlash,
    className: "bg-muted text-muted-foreground",
  },
  not_applicable: {
    label: "Not applicable",
    icon: Minus,
    className: "border border-border text-muted-foreground",
  },
  running: {
    label: "Running",
    icon: LoaderCircle,
    className: "bg-primary/10 text-primary",
  },
  partial: {
    label: "Partial",
    icon: TriangleAlert,
    className: "bg-warning/20 text-foreground",
  },
} as const;

/**
 * One evaluator result or iteration verdict. Error is outlined and Failed is
 * a filled tint, so a crashed evaluator never reads like a bad agent. Not
 * applicable is gray and outlined because it is not a pass.
 */
export function VerdictPill({
  status,
  label,
  size = "md",
}: {
  status: VerdictStatus;
  /** Overrides the status word, e.g. "0.62" for a score. */
  label?: string;
  size?: "sm" | "md";
}) {
  const { icon: Icon, className, label: fallback } = VERDICT[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-sm font-semibold",
        size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          size === "sm" ? "size-3" : "size-3.5",
          status === "running" && "animate-spin",
          status === "failed" && "text-destructive",
        )}
      />
      {label === undefined ? (
        fallback
      ) : (
        <>
          <span className="sr-only">{fallback}: </span>
          {label}
        </>
      )}
    </span>
  );
}
