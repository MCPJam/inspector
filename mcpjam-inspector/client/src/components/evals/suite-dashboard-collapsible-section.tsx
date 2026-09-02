import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";
import {
  insightHighlightCompactLabelClass,
  insightHighlightCompactSectionClass,
} from "./insight-highlight-chrome";
import { evalSurfaceCardClass } from "./eval-surface-chrome";

/**
 * Collapsible chrome for the suite dashboard bands above the results table.
 * Keeps a one-line summary visible when collapsed so users can reclaim
 * vertical space without losing the headline signal.
 */
export function SuiteDashboardCollapsibleSection({
  label,
  summary,
  defaultOpen = true,
  children,
  trailing,
  variant = "compact",
  testId,
}: {
  label: string;
  /** Shown beside the label when collapsed. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  trailing?: ReactNode;
  variant?: "compact" | "card";
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const shellClass =
    variant === "card"
      ? evalSurfaceCardClass
      : insightHighlightCompactSectionClass;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(shellClass, "overflow-hidden")}
      data-testid={testId}
    >
      <div
        className={cn(
          "flex items-center gap-2",
          variant === "card" ? "px-4 py-2.5" : "px-3 py-2",
        )}
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring/40",
            )}
            aria-expanded={open}
            aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                !open && "-rotate-90",
              )}
              aria-hidden
            />
            <span className={insightHighlightCompactLabelClass}>{label}</span>
            {!open && summary ? (
              <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
                {summary}
              </span>
            ) : null}
          </button>
        </CollapsibleTrigger>
        {trailing ? (
          <div
            className="shrink-0"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            {trailing}
          </div>
        ) : null}
      </div>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
