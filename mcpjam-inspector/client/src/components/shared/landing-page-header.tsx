/**
 * Shared chrome for landing pages (Swarm, Evaluate).
 *
 * Layout:
 *   Row: [title] | [tabs]                          [actions]
 *   Description
 *
 * The detail-route counterpart is DetailPageHeader; this one is the version
 * with no way back out, so it carries the line that says what the page is for.
 */
import type { ReactNode } from "react";
import {
  ViewModeSelector,
  type ViewModeSelectorOption,
} from "@/components/shared/view-mode-selector";

/**
 * The strip itself, exported for the one header that swaps the whole title row
 * for a breadcrumb trail (Evaluate on detail routes) and still needs to sit at
 * the same height and inset as its own landing.
 */
export const PAGE_HEADER_STRIP_CLASSNAME =
  "relative shrink-0 border-b border-border/40 px-4 py-4 sm:px-6";

const TAB_CLASSNAME =
  "mt-0 w-auto min-w-0 shrink justify-start overflow-x-auto [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm sm:[&_button]:min-h-8 sm:[&_button]:px-3 sm:[&_button]:text-sm md:[&_button]:min-h-8 lg:[&_button]:px-3.5";

export function LandingPageHeader<T extends string>({
  title,
  description,
  tabs,
  actions,
  testId,
}: {
  title: string;
  description: ReactNode;
  /** Omit on a landing with a single view. */
  tabs?: {
    value: T;
    options: readonly ViewModeSelectorOption<T>[];
    onChange: (value: T) => void;
    ariaLabel: string;
    indicatorId: string;
  };
  actions?: ReactNode;
  testId?: string;
}) {
  // The inner test ids follow the container's so a caller names the header
  // once and its own tests can still reach the row and the rule.
  const rowTestId = testId ? `${testId}-title-row` : undefined;

  return (
    <div className={PAGE_HEADER_STRIP_CLASSNAME} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div
          className="flex min-w-0 items-center gap-3"
          data-testid={rowTestId}
        >
          <h1 className="shrink-0 text-xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          {tabs ? (
            <>
              <div
                className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
                aria-hidden="true"
                data-testid={testId ? `${testId}-title-rule` : undefined}
              />
              <ViewModeSelector
                value={tabs.value}
                options={tabs.options}
                onChange={tabs.onChange}
                ariaLabel={tabs.ariaLabel}
                indicatorId={tabs.indicatorId}
                className={TAB_CLASSNAME}
              />
            </>
          ) : null}
        </div>
        {actions}
      </div>
      <p className="mt-2 w-full text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
