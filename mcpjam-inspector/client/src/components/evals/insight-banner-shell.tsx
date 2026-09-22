import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  insightHighlightCompactLabelClass,
  insightHighlightCompactSectionClass,
} from "@/components/evals/insight-highlight-chrome";

/**
 * Compact always-visible callout chrome — suite dashboard "Run insights" and
 * Swarm / User Testing pattern summaries share this shell.
 */
export function InsightBannerShell({
  label,
  children,
  trailing,
  className,
  testId,
}: {
  label: string;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      className={cn(insightHighlightCompactSectionClass, className)}
      data-testid={testId}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex shrink-0 items-center pt-0.5">
          <span className={insightHighlightCompactLabelClass}>{label}</span>
        </div>
        {children}
        {trailing}
      </div>
    </section>
  );
}
