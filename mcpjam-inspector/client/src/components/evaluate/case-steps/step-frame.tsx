import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ANCHOR_ATTRIBUTE } from "./editor-rows";
import type { EditorAnchor } from "./case-steps-model";

/**
 * One numbered step of the editor: the number on a rail at the left, the
 * step's card beside it. The rail line runs down to the next step.
 */
export function StepFrame({
  number,
  anchor,
  title,
  hint,
  active = false,
  children,
}: {
  /** Null for a block outside the numbering, such as an add row. */
  number: number | null;
  anchor?: EditorAnchor;
  title?: string;
  hint?: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className="relative grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 sm:gap-x-6"
      data-testid={number === null ? undefined : "case-steps-step"}
      data-step-number={number ?? undefined}
    >
      <div className="relative flex justify-center" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        <span
          className={cn(
            "relative mt-1 flex size-10 items-center justify-center rounded-full border bg-background text-sm font-medium",
            number === null
              ? "border-dashed border-border text-muted-foreground"
              : "border-border text-foreground",
          )}
        >
          {number ?? "+"}
        </span>
      </div>
      <section
        {...(anchor ? { [ANCHOR_ATTRIBUTE]: anchor } : {})}
        tabIndex={anchor ? -1 : undefined}
        aria-label={title ? `Step ${number}: ${title}` : undefined}
        className={cn(
          "min-w-0 rounded-xl outline-none",
          number !== null && "border border-border bg-card p-4 sm:p-6",
          active && "ring-2 ring-ring",
        )}
      >
        {title ? (
          <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold leading-7 text-card-foreground">
              {title}
            </h2>
            {hint ? (
              <p className="text-sm text-muted-foreground">{hint}</p>
            ) : null}
          </header>
        ) : null}
        {children}
      </section>
    </li>
  );
}
