import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Tab chrome shared by the Swarm and Evaluate headers: title | tabs sitting on
 * one baseline, the tab row allowed to shrink and scroll rather than push the
 * primary action off the row.
 */
export const PAGE_HEADER_TAB_CLASSNAME =
  "mt-0 w-auto min-w-0 shrink justify-start overflow-x-auto [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm sm:[&_button]:min-h-8 sm:[&_button]:px-3 sm:[&_button]:text-sm md:[&_button]:min-h-8 lg:[&_button]:px-3.5";

interface PageHeaderShellProps {
  /** Page name, rendered as the h1. */
  title: string;
  /** One line of body copy under the title row. */
  description: string;
  /** View tabs, placed after the title and the vertical rule. */
  tabs?: ReactNode;
  /** Primary action(s), pinned to the far end of the title row. */
  actions?: ReactNode;
  /** Padding/border for the outer container, so each page keeps its own gutter. */
  className?: string;
  testId?: string;
  titleRowTestId?: string;
  titleRuleTestId?: string;
}

/**
 * The landing-page header shell (BB-236): title, optional tabs, optional
 * primary action on one row, with the page description underneath.
 *
 * Swarm and Evaluate had grown identical copies of this markup by hand — the
 * tab class string was duplicated character for character — so it lives here
 * once. Callers still own their container padding, which differs between the
 * two pages to line up with the body content below each header.
 */
export function PageHeaderShell({
  title,
  description,
  tabs,
  actions,
  className,
  testId,
  titleRowTestId,
  titleRuleTestId,
}: PageHeaderShellProps) {
  return (
    <div
      className={cn("relative shrink-0 border-b border-border/40", className)}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div
          className="flex min-w-0 items-center gap-3"
          data-testid={titleRowTestId}
        >
          <h1 className="shrink-0 text-xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          {tabs ? (
            <>
              <div
                className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
                aria-hidden="true"
                data-testid={titleRuleTestId}
              />
              {tabs}
            </>
          ) : null}
        </div>
        {actions}
      </div>
      <p className="mt-2 w-full text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
