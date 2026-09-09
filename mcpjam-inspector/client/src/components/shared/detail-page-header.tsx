/**
 * Shared chrome for detail pages (Swarm run, User Testing scenario, …).
 *
 * Layout:
 *   Row: [back] | [title]  [tabs]                 [actions]
 *   Optional body (children)
 *
 * Surfaces keep different title/body content; spacing, back-link style, and
 * tab placement live here so a chrome tweak applies everywhere.
 */
import type { ReactNode } from "react";
import {
  ViewModeSelector,
  type ViewModeSelectorOption,
} from "@/components/shared/view-mode-selector";
import { cn } from "@/lib/utils";

const TAB_CLASSNAME =
  "w-auto min-w-0 shrink justify-start overflow-x-auto [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm sm:[&_button]:min-h-8 sm:[&_button]:px-3 sm:[&_button]:text-sm md:[&_button]:min-h-8 lg:[&_button]:px-3.5";

export function DetailBackLink({
  label,
  onBack,
  testId,
}: {
  label: string;
  onBack: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="shrink-0 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      data-testid={testId}
    >
      ← {label}
    </button>
  );
}

export function DetailPageHeader<T extends string>({
  backLabel,
  onBack,
  backTestId,
  title,
  actions,
  tabs,
  children,
  className,
  testId,
}: {
  backLabel: string;
  onBack: () => void;
  backTestId?: string;
  title: ReactNode;
  actions?: ReactNode;
  /** Omit on sibling routes (e.g. User Testing Edit) that share this chrome. */
  tabs?: {
    value: T;
    options: readonly ViewModeSelectorOption<T>[];
    onChange: (value: T) => void;
    ariaLabel: string;
    indicatorId: string;
  };
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "relative shrink-0 border-b border-border/40 px-8 pt-2.5 pb-2.5",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <DetailBackLink
            label={backLabel}
            onBack={onBack}
            testId={backTestId}
          />
          <div
            className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
            aria-hidden="true"
          />
          <div className="min-w-0">{title}</div>
          {tabs ? (
            <>
              <div
                className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
                aria-hidden="true"
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
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
    </div>
  );
}
