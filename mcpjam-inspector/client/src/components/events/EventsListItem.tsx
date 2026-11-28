import { forwardRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";

/**
 * One row of an Events list (event types, subscriptions, received events).
 * It looks like a Tools row, and it is a button, so the keyboard reaches it.
 */
export const EventsListItem = forwardRef<
  HTMLButtonElement,
  {
    title: string;
    description?: ReactNode;
    meta?: ReactNode;
    selected: boolean;
    onClick: () => void;
    testId?: string;
    /** Lets a list find this row again, e.g. to return focus after Back. */
    itemKey?: string;
  }
>(function EventsListItem(
  { title, description, meta, selected, onClick, testId, itemKey },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testId}
      data-item-key={itemKey}
      className={cn(
        "w-full cursor-pointer rounded-md p-3 text-left transition-all duration-200 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-muted/50",
        selected
          ? "border border-border bg-muted/50 shadow-sm ring-1 ring-ring/20"
          : "hover:shadow-sm",
      )}
    >
      <span className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <code className="break-all rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
            {title}
          </code>
          {description ? (
            <span className="mt-2 block text-xs leading-relaxed text-muted-foreground md:line-clamp-2">
              {description}
            </span>
          ) : null}
          {meta ? <span className="mt-2 block">{meta}</span> : null}
        </span>
        <ChevronRight className="mt-1 h-3 w-3 flex-shrink-0 text-muted-foreground" />
      </span>
    </button>
  );
});
