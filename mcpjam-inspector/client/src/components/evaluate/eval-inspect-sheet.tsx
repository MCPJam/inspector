import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { cn } from "@mcpjam/design-system/cn";

/**
 * The Evaluate inspect layer — the 960px dismissable sheet that opens a
 * case, then an iteration, without leaving the run.
 *
 * Insights session preview uses this same shell so the layer is one
 * component, not a lookalike.
 */
export const evalInspectSheetContentClass = "w-full gap-0 sm:max-w-[960px]";

export function EvalInspectSheet({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open && children ? (
        <SheetContent className={evalInspectSheetContentClass}>
          {children}
        </SheetContent>
      ) : null}
    </Sheet>
  );
}

export function EvalInspectHeader({
  crumb,
  onBack,
  backAriaLabel,
  title,
  badge,
  description,
  descriptionSrOnly = false,
  actions,
}: {
  crumb?: ReactNode;
  onBack?: () => void;
  backAriaLabel?: string;
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  descriptionSrOnly?: boolean;
  /** Sits in the header, left of the sheet close control. */
  actions?: ReactNode;
}) {
  return (
    <SheetHeader
      className={cn(
        "px-6 py-5 pr-12",
        crumb ? "border-b border-border" : undefined,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {crumb && onBack ? (
            <button
              type="button"
              className="w-fit text-left text-sm text-muted-foreground hover:text-foreground"
              onClick={onBack}
              aria-label={backAriaLabel}
            >
              {crumb}
            </button>
          ) : null}
          {badge ? (
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle className="text-xl">{title}</SheetTitle>
              {badge}
            </div>
          ) : (
            <SheetTitle className="break-words text-xl">{title}</SheetTitle>
          )}
          {description != null ? (
            <SheetDescription
              className={descriptionSrOnly ? "sr-only" : undefined}
            >
              {description}
            </SheetDescription>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center pt-0.5">{actions}</div>
        ) : null}
      </div>
    </SheetHeader>
  );
}

export function EvalInspectBody({
  children,
  fill = false,
}: {
  children: ReactNode;
  /**
   * Fill the remaining sheet height as a flex column. Required for
   * `TraceViewer` / `fillContent` — a scrolling body gives those
   * `flex-1 min-h-0` children no definite height, so the timeline paints empty.
   */
  fill?: boolean;
}) {
  return (
    <div
      className={
        fill
          ? "flex min-h-0 flex-1 flex-col overflow-hidden"
          : "min-h-0 flex-1 overflow-y-auto p-6"
      }
    >
      {children}
    </div>
  );
}
